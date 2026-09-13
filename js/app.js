import { CARS, TRACKS, UPGRADES, PRIZE, POINTS, DRIVERS, QUALIFY } from "./data.js?v=airace1";
import { AudioBus } from "./audio.js?v=airace1";
import { GameEngine } from "./engine.js?v=airace1";
import { getModo } from "./modo.js?v=airace1";

const SAVE_KEY = "relampago-save";

function emptyUpgrades() {
  return { engine: 0, tires: 0, nitro: 0 };
}

function emptyPoints() {
  return Object.fromEntries(DRIVERS.map((d) => [d.name, 0]));
}

function normalizeCup(raw) {
  if (!raw || raw.done) return null;
  const points = { ...emptyPoints(), ...(raw.points || {}) };
  const completed = Math.max(0, Math.min(TRACKS.length, Number(raw.completed) || 0));
  if (completed <= 0 && raw.phase !== "racing" && raw.phase !== "standings" && raw.phase !== "failed" && !raw.active) {
    return null;
  }
  return {
    completed,
    index: Math.max(0, Math.min(TRACKS.length - 1, Number(raw.index) || 0)),
    points,
    lastResults: raw.lastResults || null,
    done: false,
    phase: raw.phase === "racing" || raw.phase === "failed" ? raw.phase : "standings",
  };
}

function loadSave() {
  const fallback = {
    money: 0,
    upgrades: emptyUpgrades(),
    carId: "fenix",
    cup: null,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!raw) return fallback;
    return {
      money: Number(raw.money) || 0,
      upgrades: { ...emptyUpgrades(), ...(raw.upgrades || {}) },
      carId: raw.carId || "fenix",
      cup: normalizeCup(raw.cup),
    };
  } catch {
    return fallback;
  }
}

function save(state) {
  localStorage.setItem(SAVE_KEY, JSON.stringify({
    money: state.money,
    upgrades: state.upgrades,
    carId: state.carId,
    cup: state.cup || null,
  }));
}

function countdownLabel(cd) {
  if (cd > 2) return "3";
  if (cd > 1) return "2";
  if (cd > 0.28) return "1";
  return "VAI";
}

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function $(id) { return document.getElementById(id); }

class App {
  constructor() {
    this.save = loadSave();
    this.audio = new AudioBus();
    this.engine = new GameEngine($("view"), this.audio);
    this.phone = getModo() === "celular";
    this.kb = { up: false, down: false, left: false, right: false, nitro: false };
    this.pad = { up: false, down: false, left: false, right: false, nitro: false };
    this.goLatch = false;
    this._pointers = new Map();
    this.screen = "title";
    this.carId = this.save.carId;
    this.trackId = TRACKS[0].id;
    this.mode = "quick";
    this.cup = null;
    this.afterShop = "mode";
    this.menuIndex = 0;
    this._portraitOk = false;
    this._now = 0;
    document.body.classList.add(this.phone ? "modo-celular" : "modo-pc");
    this.engine.setPhone(this.phone);
    this._immersive = false;
    this.bind();
    this.renderCars();
    this.renderTracks();
    this.renderShop();
    this.show("title");
    this.preview("praia");
    this.refreshCupButton();
    this.loop(performance.now());
    this.syncMute();
    addEventListener("blur", () => {
      if (this.screen === "race") return;
      this.clearInput();
    });
    addEventListener("visibilitychange", () => {
      this._now = performance.now();
    });
    this.guardNavigation();
    try {
      if (new URLSearchParams(location.search).get("v")) window.__relampago = this;
    } catch (_) {}
  }

  bind() {
    if (!this.phone) {
      addEventListener("keydown", (e) => this.onKey(e, true), { capture: true });
      addEventListener("keyup", (e) => this.onKey(e, false), { capture: true });
    }
    document.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.audio.unlock();
        this.audio.ui();
        this.act(btn.dataset.action);
      });
    });
    $("btn-mute")?.addEventListener("click", () => {
      this.audio.unlock();
      this.audio.toggleMute();
      this.syncMute();
    });
    $("btn-full")?.addEventListener("click", () => {
      this.audio.unlock();
      this.toggleFull();
    });
    if (this.phone) {
      this.bindPads();
      addEventListener("touchmove", (e) => {
        if (this.screen === "race" || !e.target.closest?.(".screen")) e.preventDefault();
      }, { passive: false });
      addEventListener("gesturestart", (e) => e.preventDefault());
      addEventListener("orientationchange", () => {
        this.syncRotate();
        this.hideSafariChrome();
        this.fillVisibleShell();
      });
      matchMedia("(orientation: portrait)").addEventListener?.("change", () => this.syncRotate());
    }
    addEventListener("fullscreenchange", () => this.syncFullBtn());
    addEventListener("webkitfullscreenchange", () => this.syncFullBtn());
    visualViewport?.addEventListener("resize", () => this.fillVisibleShell());
    visualViewport?.addEventListener("scroll", () => this.fillVisibleShell());
    this.syncFullBtn();
    this.fillVisibleShell();
  }

  bindPads() {
    this._pointers = new Map();
    const syncPads = () => {
      const held = { up: false, down: false, left: false, right: false, nitro: false };
      for (const key of this._pointers.values()) {
        if (key in held) held[key] = true;
      }
      const wasUp = this.pad.up;
      this.pad.up = held.up;
      this.pad.down = held.down;
      this.pad.left = held.left;
      this.pad.right = held.right;
      this.pad.nitro = held.nitro;
      if (held.up) this.goLatch = true;
      else if (held.down) this.goLatch = false;
      else if (wasUp && !held.up && this.engine.countdown <= 0) this.goLatch = false;
      document.querySelectorAll("[data-hold]").forEach((el) => {
        el.classList.toggle("held", !!held[el.dataset.hold]);
      });
      this.engine.setKeys(this.driveKeys());
    };
    this._syncPads = syncPads;

    const press = (id, key) => {
      if (!id || !key) return;
      const fresh = !this._pointers.has(id);
      this._pointers.set(id, key);
      syncPads();
      if (fresh && key === "nitro") this.engine.tryNitro?.();
      queueMicrotask(() => this.audio.unlock());
    };
    const release = (id) => {
      if (!id || !this._pointers.has(id)) return;
      this._pointers.delete(id);
      syncPads();
    };

    const onPointerDown = (e) => {
      if (e.pointerType === "mouse" && e.button != null && e.button !== 0) return;
      if (e.cancelable) e.preventDefault();
      const key = e.currentTarget.dataset.hold;
      press(`p${e.pointerId}`, key);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    };
    const onPointerUp = (e) => {
      release(`p${e.pointerId}`);
    };
    const onLostCapture = (e) => {
      if (e.buttons) return;
      release(`p${e.pointerId}`);
    };
    const onTouchStart = (e) => {
      if (e.cancelable) e.preventDefault();
      const key = e.currentTarget.dataset.hold;
      for (const t of e.changedTouches) press(`t${t.identifier}`, key);
    };
    const onTouchEnd = (e) => {
      let released = false;
      for (const t of e.changedTouches) {
        const id = `t${t.identifier}`;
        if (this._pointers.has(id)) {
          release(id);
          released = true;
        }
      }
      // Only block the synthetic click when a pad hold actually ended.
      // Blanket preventDefault on every touchend was killing menu buttons (Jogar).
      if (released && e.cancelable) e.preventDefault();
    };

    document.querySelectorAll("[data-hold]").forEach((el) => {
      el.addEventListener("pointerdown", onPointerDown, { passive: false });
      el.addEventListener("pointerup", onPointerUp);
      el.addEventListener("pointercancel", onPointerUp);
      el.addEventListener("lostpointercapture", onLostCapture);
      el.addEventListener("touchstart", onTouchStart, { passive: false });
      el.addEventListener("touchend", onTouchEnd, { passive: false });
      el.addEventListener("touchcancel", onTouchEnd, { passive: false });
      el.addEventListener("contextmenu", (e) => e.preventDefault());
    });
    addEventListener("pointerup", onPointerUp, true);
    addEventListener("pointercancel", onPointerUp, true);
    addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });
  }

  driveKeys() {
    const lights = this.goLatch && this.engine.countdown > 0;
    if (!this.phone) {
      return {
        up: !!(this.kb.up || lights),
        down: this.kb.down,
        left: this.kb.left,
        right: this.kb.right,
        nitro: this.kb.nitro,
      };
    }
    return {
      up: !!(this.pad.up || lights),
      down: this.pad.down,
      left: this.pad.left,
      right: this.pad.right,
      nitro: this.pad.nitro,
    };
  }

  clearInput() {
    this.kb.up = this.kb.down = this.kb.left = this.kb.right = this.kb.nitro = false;
    if (this.screen === "race" && this._pointers?.size) {
      this._syncPads?.();
      if (this.engine.countdown > 0) return;
      if (![...this._pointers.values()].includes("up")) this.goLatch = false;
      return;
    }
    this.pad.up = this.pad.down = this.pad.left = this.pad.right = this.pad.nitro = false;
    if (this.engine.countdown > 0) {
      this._syncPads?.();
      return;
    }
    this.goLatch = false;
    this._pointers?.clear();
    document.querySelectorAll(".pad.held").forEach((el) => el.classList.remove("held"));
    this.engine.setKeys(this.driveKeys());
  }

  onKey(e, down) {
    const k = e.key;
    const code = e.code;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(k)) e.preventDefault();
    if (k === "ArrowUp" || k === "w" || k === "W" || code === "ArrowUp" || code === "KeyW") {
      this.kb.up = down;
      if (down) this.goLatch = true;
      else if (this.engine.countdown <= 0) this.goLatch = false;
    }
    if (k === "ArrowDown" || k === "s" || k === "S" || code === "ArrowDown" || code === "KeyS") {
      this.kb.down = down;
      if (down) this.goLatch = false;
    }
    if (k === "ArrowLeft" || k === "a" || k === "A" || code === "ArrowLeft" || code === "KeyA") this.kb.left = down;
    if (k === "ArrowRight" || k === "d" || k === "D" || code === "ArrowRight" || code === "KeyD") this.kb.right = down;
    if (k === " " || k === "Spacebar" || code === "Space") {
      e.preventDefault();
      this.kb.nitro = down;
    }
    if (k === "Shift" || code === "ShiftLeft" || code === "ShiftRight") this.kb.nitro = down;
    this.engine.setKeys(this.driveKeys());
    if (!down) return;
    this.audio.unlock();
    if (k === "m" || k === "M") {
      this.audio.toggleMute();
      this.syncMute();
    }
    if (k === "f" || k === "F") {
      this.toggleFull();
    }
    if (k === "Escape") {
      if (this.screen === "race") this.act("pause");
      else if (this.screen === "pause") this.act("resume");
    }
    if (k === "Enter") {
      const screen = document.querySelector(".screen:not(.hidden)");
      const primary = screen?.querySelector("button.primary");
      if (primary && this.screen !== "race") {
        this.audio.ui();
        this.act(primary.dataset.action);
      }
    }
  }

  syncMute() {
    const muteBtn = $("btn-mute");
    if (muteBtn) muteBtn.textContent = this.audio.muted ? "Som off" : "Som";
  }

  isIPhone() {
    return /iPhone|iPod/i.test(navigator.userAgent || "");
  }

  isStandalone() {
    return !!(navigator.standalone || matchMedia("(display-mode: standalone)").matches);
  }

  fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  canFullscreenApi() {
    if (this.isIPhone()) return false;
    const el = document.documentElement;
    return typeof (el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen) === "function";
  }

  hideSafariChrome() {
    try {
      window.scrollTo(0, 0);
      document.documentElement.scrollIntoView?.({ block: "start" });
      requestAnimationFrame(() => {
        window.scrollTo(0, 1);
        window.scrollTo(0, 0);
      });
    } catch (_) { /* Safari antigo */ }
  }

  fillVisibleShell() {
    const app = $("app");
    if (app) {
      app.style.position = "fixed";
      app.style.inset = "0";
      app.style.top = "0";
      app.style.left = "0";
      app.style.right = "0";
      app.style.bottom = "0";
      app.style.width = "100%";
      app.style.height = "100%";
      app.style.height = "100svh";
      app.style.height = "100dvh";
      app.style.minHeight = "-webkit-fill-available";
      app.style.padding = "0";
      app.style.margin = "0";
    }
    this.engine.resize();
  }

  syncFullBtn() {
    const btn = $("btn-full");
    if (!btn) return;
    const apiOn = !!this.fsElement();
    if (this.isStandalone()) {
      btn.textContent = "Tela preenchida";
      btn.title = "Aberto pela Tela de Início — já preenche a área visível.";
      return;
    }
    if (!this.canFullscreenApi()) {
      btn.textContent = this._immersive ? "Tela preenchida" : "Preencher tela";
      btn.title = this._immersive
        ? "Preenche a área visível. A barra do Safari não some por este botão."
        : "Preenche a área visível. No iPhone a barra do Safari não some por este botão.";
      return;
    }
    btn.textContent = apiOn ? "Sair da tela cheia" : "Tela cheia";
    btn.title = apiOn ? "Sair da tela cheia" : "Tela cheia";
  }

  async toggleFull() {
    const el = document.documentElement;
    if (this.isStandalone()) {
      this._immersive = true;
      document.documentElement.classList.add("immersive");
      document.body.classList.add("immersive");
      this.syncFullBtn();
      this.hideSafariChrome();
      this.fillVisibleShell();
      return;
    }
    if (this.canFullscreenApi()) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (this.fsElement() && exit) {
        try { await exit.call(document); } catch (_) { /* ignore */ }
        this._immersive = false;
        document.documentElement.classList.remove("immersive");
        document.body.classList.remove("immersive");
        this.syncFullBtn();
        this.fillVisibleShell();
        return;
      }
      try {
        await req.call(el, { navigationUI: "hide" });
        this._immersive = true;
        document.documentElement.classList.add("immersive");
        document.body.classList.add("immersive");
        this.syncFullBtn();
        this.fillVisibleShell();
        return;
      } catch (_) { /* iPhone/iPad recusa — cai no fallback */ }
    }
    this._immersive = !this._immersive;
    document.documentElement.classList.toggle("immersive", this._immersive);
    document.body.classList.toggle("immersive", this._immersive);
    this.hideSafariChrome();
    this.syncFullBtn();
    this.fillVisibleShell();
  }

  preview(trackId) {
    this.engine.startAttract(trackId || this.trackId || "praia", this.carId);
  }

  resetScroll(el) {
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    requestAnimationFrame(() => {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    });
  }

  show(name) {
    this.screen = name;
    document.body.classList.toggle("racing", name === "race");
    document.querySelectorAll(".screen").forEach((el) => el.classList.add("hidden"));
    const hud = $("hud");
    const count = $("countdown");
    const pads = $("pads");
    if (name === "mode") this.refreshCupButton();
    if (name === "race") {
      hud?.classList.remove("hidden");
      if (this.phone) pads?.classList.remove("hidden");
      else pads?.classList.add("hidden");
      this.syncRotate();
      return;
    }
    hud?.classList.add("hidden");
    count?.classList.add("hidden");
    $("lap-banner")?.classList.add("hidden");
    $("radio")?.classList.add("hidden");
    pads?.classList.add("hidden");
    this.pad.up = this.pad.down = this.pad.left = this.pad.right = this.pad.nitro = false;
    const el = $(`screen-${name}`);
    if (el) {
      el.classList.remove("hidden");
      this.resetScroll(el);
      if (name === "cars" || name === "tracks" || name === "shop") {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.querySelector("button.primary")?.scrollIntoView({ block: "nearest", inline: "nearest" });
          });
        });
      }
    }
    this.syncRotate();
  }

  isRotateBlocking() {
    if (!this.phone || this.screen !== "race" || this._portraitOk) return false;
    return matchMedia("(orientation: portrait)").matches;
  }

  guardNavigation() {
    const eatNav = (e) => {
      const a = e.target?.closest?.("a");
      if (this.screen === "race" && a) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };
    document.addEventListener("click", eatNav, true);
    document.addEventListener("auxclick", eatNav, true);
    const view = $("view");
    if (view) {
      const eat = (e) => {
        if (this.screen !== "race") return;
        e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        try { view.focus({ preventScroll: true }); } catch (_) {}
      };
      view.addEventListener("click", eat);
      view.addEventListener("auxclick", eat);
      view.addEventListener("dblclick", eat);
    }
    addEventListener("beforeunload", () => {}, { capture: true });
  }

  syncRotate() {
    const hint = $("rotate-hint");
    const block = this.isRotateBlocking();
    document.body.classList.toggle("rotate-block", block);
    if (hint) hint.classList.toggle("hidden", !block);
    if (block) {
      $("toast")?.classList.add("hidden");
      $("countdown")?.classList.add("hidden");
      $("lap-banner")?.classList.add("hidden");
      $("radio")?.classList.add("hidden");
    }
  }

  act(name) {
    if (name === "portrait-ok") {
      this._portraitOk = true;
      this.syncRotate();
      return;
    }
    if (name === "play") {
      this.show("cars");
      this.preview("praia");
    }
    if (name === "howto") this.show("howto");
    if (name === "back-title") {
      this.show("title");
      this.preview("praia");
    }
    if (name === "cars-next") this.show("mode");
    if (name === "back-cars") {
      this.show("cars");
      this.preview("praia");
    }
    if (name === "back-mode") this.show("mode");
    if (name === "mode-cup") this.startCup();
    if (name === "mode-quick") this.show("tracks");
    if (name === "open-shop") {
      this.afterShop = this.screen === "standings" ? "standings" : "mode";
      this.renderShop();
      this.show("shop");
    }
    if (name === "shop-back") {
      this.show(this.afterShop);
      if (this.afterShop === "standings") this.renderStandings();
    }
    if (name === "track-go") this.startQuick();
    if (name === "pause") {
      if (this.engine.finished) return;
      this.engine.mode = "idle";
      this.show("pause");
    }
    if (name === "resume") {
      this.engine.mode = "race";
      this.show("race");
    }
    if (name === "restart") {
      this.engine.restart();
      this.show("race");
    }
    if (name === "quit-race") this.quitRace();
    if (name === "results-next") this.afterResults();
    if (name === "cup-next") this.nextCupRace();
    this.refreshMoney();
  }

  renderCars() {
    const grid = $("car-grid");
    grid.innerHTML = "";
    CARS.forEach((car) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "pick" + (car.id === this.carId ? " selected" : "");
      el.innerHTML = `
        <div class="swatch" style="background:${car.color}"></div>
        <h3>${car.name}</h3>
        <p>${car.tag}</p>
        ${this.stat("Velocidade", car.top, 330)}
        ${this.stat("Arranque", car.accel, 1.4)}
        ${this.stat("Aderência", car.grip, 1.4)}
        ${this.stat("Nitro", car.nitro, 1.5)}
        ${this.stat("Tanque", car.fuel, 1.2)}
      `;
      el.addEventListener("click", () => {
        this.audio.unlock();
        this.audio.ui();
        this.carId = car.id;
        this.save.carId = car.id;
        save(this.save);
        this.renderCars();
        this.preview(this.trackId || "praia");
      });
      grid.appendChild(el);
    });
  }

  stat(label, value, max) {
    const pct = Math.round((value / max) * 100);
    return `<div class="stat"><b>${label}</b><i style="--v:${pct}%"></i></div>`;
  }

  renderTracks() {
    const grid = $("track-grid");
    grid.innerHTML = "";
    TRACKS.forEach((t) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "pick" + (t.id === this.trackId ? " selected" : "");
      el.innerHTML = `
        <div class="swatch" style="background:linear-gradient(90deg,${t.sky[0]},${t.sky[1]})"></div>
        <h3>${t.name}</h3>
        <p>${t.place} · ${t.laps} voltas</p>
        <p>${t.mood}</p>
      `;
      el.addEventListener("click", () => {
        this.audio.unlock();
        this.audio.ui();
        this.trackId = t.id;
        this.renderTracks();
      });
      grid.appendChild(el);
    });
  }

  renderShop() {
    $("shop-money").textContent = `Dinheiro: $${this.save.money}`;
    const grid = $("shop-grid");
    grid.innerHTML = "";
    Object.entries(UPGRADES).forEach(([key, item]) => {
      const level = this.save.upgrades[key] || 0;
      const maxed = level >= item.max;
      const cost = maxed ? 0 : item.costs[level];
      const el = document.createElement("div");
      el.className = "shop-card";
      el.innerHTML = `
        <h3>${item.name}</h3>
        <p>${item.blurb}</p>
        <p>Nível ${level}/${item.max}</p>
        ${this.stat("Força", 0.35 + level * 0.22, 1)}
        <div class="menu">
          <button type="button" ${maxed || this.save.money < cost ? "disabled" : ""}>
            ${maxed ? "No máximo" : `Comprar · $${cost}`}
          </button>
        </div>
      `;
      const btn = el.querySelector("button");
      btn.addEventListener("click", () => {
        if (maxed || this.save.money < cost) return;
        this.save.money -= cost;
        this.save.upgrades[key] = level + 1;
        save(this.save);
        this.audio.ok();
        this.renderShop();
        this.refreshMoney();
      });
      grid.appendChild(el);
    });
  }

  refreshMoney() {
    $("money-hint").textContent = `Seu dinheiro: $${this.save.money}`;
    this.refreshCupButton();
  }

  hasCupInProgress() {
    const cup = this.save.cup;
    return !!(cup && !cup.done && (cup.completed > 0 || cup.phase === "racing" || cup.phase === "standings" || cup.phase === "failed"));
  }

  refreshCupButton() {
    const btn = $("btn-cup") || document.querySelector('[data-action="mode-cup"]');
    if (!btn) return;
    btn.textContent = this.hasCupInProgress() ? "Continuar campeonato" : "Campeonato";
  }

  persistCup() {
    this.save.cup = this.cup
      ? {
          completed: this.cup.completed,
          index: this.cup.index,
          points: { ...this.cup.points },
          lastResults: this.cup.lastResults,
          done: !!this.cup.done,
          phase: this.cup.phase,
          active: !this.cup.done,
        }
      : null;
    save(this.save);
  }

  cloneCup(src) {
    return {
      completed: src.completed || 0,
      index: src.index || 0,
      points: { ...emptyPoints(), ...(src.points || {}) },
      lastResults: src.lastResults || null,
      done: !!src.done,
      phase: src.phase === "racing" || src.phase === "failed" ? src.phase : "standings",
    };
  }

  startQuick() {
    this.mode = "quick";
    this.cup = null;
    this.goRace(this.trackId);
  }

  startCup() {
    this.mode = "cup";
    const saved = this.save.cup;
    if (saved && !saved.done) {
      this.cup = this.cloneCup(saved);
      if (this.cup.phase === "failed") {
        this.cup.phase = "racing";
        this.persistCup();
        this.goRace(TRACKS[Math.min(this.cup.completed, TRACKS.length - 1)].id);
        return;
      }
      if (this.cup.completed > 0 || this.cup.phase === "standings") {
        this.cup.phase = "standings";
        this.persistCup();
        this.renderStandings();
        this.show("standings");
        const previewId = TRACKS[Math.min(this.cup.completed, TRACKS.length - 1)].id;
        this.preview(previewId);
        return;
      }
      this.cup.phase = "racing";
      this.cup.index = 0;
      this.persistCup();
      this.goRace(TRACKS[0].id);
      return;
    }
    this.cup = {
      completed: 0,
      index: 0,
      points: emptyPoints(),
      lastResults: null,
      done: false,
      phase: "racing",
    };
    this.persistCup();
    this.goRace(TRACKS[0].id);
  }

  quitRace() {
    if (this.cup) {
      this.cup.phase = this.cup.completed > 0 ? "standings" : "racing";
      this.persistCup();
      if (this.cup.completed > 0) {
        this.renderStandings();
        this.show("standings");
        this.preview(TRACKS[Math.min(this.cup.completed, TRACKS.length - 1)].id);
        return;
      }
    }
    this.show("mode");
    this.preview(this.trackId);
  }

  goRace(trackId) {
    this.trackId = trackId;
    this.engine.onFinish = (results) => this.finish(results);
    this.engine.startRace(trackId, this.carId, this.save.upgrades, 2);
    this.show("race");
    this.audio.go();
    try { window.focus(); } catch (_) {}
    try { $("view")?.focus?.(); } catch (_) {}
  }

  finish(results) {
    const list = Array.isArray(results) ? results : [];
    const you = list.find((r) => r.you) || { place: list.length || 8, time: this.engine.time || 0 };
    const prize = PRIZE[(you.place - 1)] || 80;
    this.save.money += prize;
    const nextBtn = document.querySelector('[data-action="results-next"]');
    const qualified = you.place <= QUALIFY;
    const rows = list.length ? list : [{ place: you.place, name: "Você", car: "", time: you.time, you: true }];
    const table = `
      <tr><th>#</th><th>Piloto</th><th>Carro</th><th>Tempo</th></tr>
      ${rows.map((r) => `<tr class="${r.you ? "you" : ""}"><td>${r.place}</td><td>${r.name}</td><td>${r.car || ""}</td><td>${fmt(r.time || 0)}</td></tr>`).join("")}
    `;
    try {
      if (this.cup) {
        this.cup.lastResults = list;
        if (!qualified) {
          this.cup.phase = "failed";
          this.persistCup();
          $("results-title").textContent = "Não se classificou";
          $("results-sub").textContent = `Você chegou em ${you.place}º. Precisa do ${QUALIFY}º ou melhor para avançar. +$${prize}`;
          $("results-table").innerHTML = table;
          if (nextBtn) nextBtn.textContent = "Tentar de novo";
          this.show("results");
          return;
        }
        list.forEach((r) => {
          this.cup.points[r.name] = (this.cup.points[r.name] || 0) + (POINTS[r.place - 1] || 0);
        });
        this.cup.completed += 1;
        this.cup.index = this.cup.completed - 1;
        this.cup.phase = "standings";
        this.cup.done = this.cup.completed >= TRACKS.length;
        this.persistCup();
      } else {
        save(this.save);
      }
      $("results-title").textContent = you.place === 1 ? "Vitória" : "Chegada";
      $("results-sub").textContent = `${you.place}º lugar · +$${prize} · ${fmt(you.time || 0)}`;
      $("results-table").innerHTML = table;
      if (nextBtn) nextBtn.textContent = "Continuar";
    } catch (_) {
      if ($("results-title")) $("results-title").textContent = "Chegada";
      if ($("results-sub")) $("results-sub").textContent = `${you.place}º lugar`;
    }
    this.show("results");
  }

  afterResults() {
    if (this.mode === "cup" && this.cup) {
      if (this.cup.phase === "failed") {
        this.cup.phase = "racing";
        this.persistCup();
        this.goRace(TRACKS[Math.min(this.cup.completed, TRACKS.length - 1)].id);
        return;
      }
      this.renderStandings();
      this.show("standings");
      this.preview(this.trackId);
      return;
    }
    this.show("mode");
    this.preview(this.trackId);
  }

  renderStandings() {
    const last = !this.cup || this.cup.done || this.cup.completed >= TRACKS.length;
    const rows = Object.entries(this.cup.points).sort((a, b) => b[1] - a[1]);
    $("standings-title").textContent = last ? "Taça TOP RELÂMPAGO" : "Classificação";
    $("standings-sub").textContent = last
      ? `${rows[0][0]} levou o campeonato.`
      : `Próxima pista: ${TRACKS[this.cup.completed].name}`;
    $("standings-table").innerHTML = `
      <tr><th>#</th><th>Piloto</th><th>Pontos</th></tr>
      ${rows.map((r, i) => `<tr class="${r[0] === "Você" ? "you" : ""}"><td>${i + 1}</td><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}
    `;
    const next = document.querySelector('[data-action="cup-next"]');
    next.textContent = last ? "Voltar ao menu" : "Próxima etapa";
  }

  nextCupRace() {
    if (!this.cup || this.cup.done || this.cup.completed >= TRACKS.length) {
      this.cup = null;
      this.save.cup = null;
      save(this.save);
      this.show("mode");
      this.preview("praia");
      return;
    }
    this.cup.index = this.cup.completed;
    this.cup.phase = "racing";
    this.persistCup();
    this.goRace(TRACKS[this.cup.completed].id);
  }

  loop(now) {
    if (document.hidden) {
      this._now = now;
      requestAnimationFrame((t) => this.loop(t));
      return;
    }
    const last = this._now || now;
    const rawDt = (now - last) / 1000;
    this._now = now;
    if (rawDt > 0.25) {
      requestAnimationFrame((t) => this.loop(t));
      return;
    }
    const dt = Math.min(1 / 20, Math.max(0, rawDt));
    const rotateBlock = this.isRotateBlocking();
    if (rotateBlock !== this._wasRotate) {
      this.syncRotate();
      this._wasRotate = rotateBlock;
    }
    this.engine.setKeys(this.driveKeys());
    const liveMenu = this.screen === "title" || this.screen === "cars" || this.screen === "mode" || this.screen === "tracks" || this.screen === "howto" || this.screen === "shop" || this.screen === "standings" || this.screen === "results";
    if (!rotateBlock && (this.screen === "race" || liveMenu)) {
      this.engine.update(dt, dt);
    }
    this.engine.render();
    if (this.screen === "race") this.paintHud(rotateBlock);
    const p = this.engine.player;
    const max = p ? this.engine.maxSpeed(p) : 1;
    const boosting = !rotateBlock && (p?.nitroBurst || 0) > 0;
    this.audio.setEngine((p?.speed || 0) / max, boosting);
    requestAnimationFrame((t) => this.loop(t));
  }

  paintHud(rotateBlock = false) {
    const h = this.engine.hud();
    $("hud-speed").textContent = String(h.speed);
    $("hud-speed").classList.toggle("boost", !rotateBlock && h.boosting);
    $("hud-pos").innerHTML = `${h.place}<span>/${h.field}</span>`;
    $("hud-lap").innerHTML = `${h.lap}<span>/${h.laps}</span>`;
    $("hud-time").textContent = fmt(h.time);
    if ($("hud-flag")) $("hud-flag").textContent = h.trackFlag || "🏁";
    if ($("hud-track-name")) $("hud-track-name").textContent = h.trackName || "";
    $("hud-nitro-pips")?.querySelectorAll("i").forEach((el, i) => {
      el.classList.toggle("on", i < (h.nitroCharges || 0));
    });
    $("hud-nitro-pips")?.classList.toggle("hot", !rotateBlock && h.boosting);
    $("hud-fuel").style.width = `${Math.round(h.fuel * 100)}%`;
    const toast = $("toast");
    const showToast = !rotateBlock && h.toast && (h.toast !== "NITRO" || h.boosting);
    if (showToast) {
      toast.textContent = h.toast;
      toast.classList.toggle("toast-nitro", h.toast === "NITRO");
      toast.classList.toggle("toast-fuel", h.toast === "TANQUE CHEIO");
      toast.classList.toggle("toast-hit", h.toast === "BATIDA");
      toast.classList.remove("hidden");
    } else toast.classList.add("hidden");

    const banner = $("lap-banner");
    if (banner) {
      if (!rotateBlock && h.lapFlash) {
        $("lap-banner-title").textContent = h.lapFlash.title || "VOLTA";
        $("lap-banner-pos").textContent = String(h.lapFlash.place || h.place || 1);
        $("lap-banner-time").textContent = fmt(h.lapFlash.time || 0);
        banner.classList.remove("hidden");
      } else {
        banner.classList.add("hidden");
      }
    }

    const radio = $("radio");
    if (radio) {
      if (!rotateBlock && h.radio) {
        $("radio-msg").textContent = h.radio;
        radio.classList.remove("hidden");
      } else {
        radio.classList.add("hidden");
      }
    }

    const cd = $("countdown");
    if (!rotateBlock && h.countdown > 0) {
      cd.classList.remove("hidden");
      const label = countdownLabel(h.countdown);
      const num = $("countdown-num") || cd;
      if (num.textContent !== label) {
        num.textContent = label;
        if (label === "VAI") this.audio.go();
        else this.audio.count();
      }
      cd.classList.toggle("n3", label === "3");
      cd.classList.toggle("n2", label === "2");
      cd.classList.toggle("n1", label === "1");
      cd.classList.toggle("go", label === "VAI");
    } else {
      cd.classList.add("hidden");
      cd.classList.remove("n3", "n2", "n1", "go");
    }
    if (!this.phone || this._frame % 2 === 0) this.engine.renderMinimap($("minimap"));
    this._frame = (this._frame || 0) + 1;
  }
}

addEventListener("pointerdown", () => {
  window.scrollTo(0, 0);
  document.documentElement.scrollIntoView?.({ block: "start" });
}, { once: true });

new App();
