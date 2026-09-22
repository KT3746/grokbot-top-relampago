import { CARS, DRIVERS, TRACKS, applyUpgrades } from "./data.js?v=polish6";

const SEG = 200;
const ROAD = 2100;
const LANES = 3;
const FOV = 100;
const CAM_H = 900;
const CAM_DEPTH = 1 / Math.tan(((FOV / 2) * Math.PI) / 180);
const PLAYER_Z = CAM_H * CAM_DEPTH;
const CENTRIFUGAL = 0.145;
const SPRITE_SCALE = 0.38;
const CAR_SCALE_AT_PLAYER = 3.7;
const CAR_HALF_W = 0.15;
const CAR_HALF_L = 175;
const CAR_BODY_Z = 560;
const CAR_BODY_X = 0.72;
const CAR_SIGHT_Z = 1700;
const NITRO_CHARGES = 3;
const NITRO_BURST = 1.75;
const AI_LINES = [-0.70, 0.62, -0.32, 0.38, -0.54, 0.12, 0.78];
const AI_SLOTS = [380, 1200, 2400, 3900, 5600, 7400, 9000];

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeIn(a, b, p) { return a + (b - a) * p * p; }
function easeInOut(a, b, p) { return a + (b - a) * ((-Math.cos(p * Math.PI) / 2) + 0.5); }
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const r = Math.round(lerp(A.r, B.r, t));
  const g = Math.round(lerp(A.g, B.g, t));
  const bl = Math.round(lerp(A.b, B.b, t));
  return `rgb(${r},${g},${bl})`;
}
function rumbleW(w) { return w / 7; }
function laneW(w) { return w / 28; }

function lastY(segs) {
  return segs.length ? segs[segs.length - 1].p2.y : 0;
}

function addSegment(segs, curve, y) {
  const n = segs.length;
  segs.push({
    index: n,
    p1: { x: 0, y: lastY(segs), z: n * SEG },
    p2: { x: 0, y, z: (n + 1) * SEG },
    curve,
    sprites: [],
    pickup: null,
    light: Math.floor(n / 3) % 2 === 0,
  });
}

function addRoad(segs, enter, hold, leave, curve, hill) {
  const startY = lastY(segs);
  const endY = startY + (hill || 0) * SEG;
  const total = enter + hold + leave;
  for (let n = 0; n < enter; n++) addSegment(segs, easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total));
  for (let n = 0; n < hold; n++) addSegment(segs, curve, easeInOut(startY, endY, (enter + n) / total));
  for (let n = 0; n < leave; n++) addSegment(segs, easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total));
}

function buildTrack(def) {
  const segs = [];
  for (const step of def.recipe()) {
    const kind = step[0];
    if (kind === "straight") addRoad(segs, 0, step[1], 0, 0, 0);
    else if (kind === "curve") addRoad(segs, step[1], step[1], step[1], step[2], step[3] || 0);
    else if (kind === "hill") addRoad(segs, step[1], step[1], step[1], 0, step[2]);
    else if (kind === "scurve") {
      addRoad(segs, step[1], step[1], step[1], step[2], 0);
      addRoad(segs, step[1], step[1], step[1], -step[2], 0);
    }
  }
  addRoad(segs, 10, 10, 10, 0, 0);

  const map = [];
  let x = 0, y = 0, ang = 0;
  for (const s of segs) {
    ang += s.curve * 0.018;
    x += Math.cos(ang);
    y += Math.sin(ang);
    map.push({ x, y });
  }

  const kinds = def.objects;
  for (let i = 3; i < segs.length; i += 2) {
    const side = (i % 4 === 0) ? -1 : 1;
    const kind = kinds[(i + (side > 0 ? 1 : 0)) % kinds.length];
    const offset = side * (1.22 + (i % 7) * 0.05);
    const big = kind === "building" ? 2.9 : kind === "palm" || kind === "pine" ? 2.35 : 1.4;
    segs[i].sprites.push({ kind, offset, scale: big });
    if (i % 2 === 1) {
      segs[i].sprites.push({
        kind: kinds[(i + 2) % kinds.length],
        offset: -offset * (1.08 + (i % 5) * 0.03),
        scale: big * 0.82,
      });
    }
    // Far scenery row for depth
    if (i % 5 === 0) {
      segs[i].sprites.push({
        kind: kinds[(i + 1) % kinds.length],
        offset: side * (2.05 + (i % 3) * 0.12),
        scale: big * 1.15,
      });
    }
  }
  for (let i = 55; i < segs.length - 40; i += 78) {
    segs[i].pickup = { x: ((i / 78) % 2 === 0 ? -0.18 : 0.18), taken: false };
  }
  return { segs, map, length: segs.length * SEG, def };
}

function isIOSLike() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function project(p, camX, camY, camZ, w, h) {
  const cx = p.x - camX;
  const cy = p.y - camY;
  const cz = p.z - camZ;
  const scale = cz <= 1 ? 0 : CAM_DEPTH / cz;
  return {
    x: w / 2 + scale * cx * w / 2,
    y: h / 2 - scale * cy * h / 2,
    w: scale * ROAD * w / 2,
    scale,
    cz,
  };
}

function poly(ctx, x1, y1, x2, y2, x3, y3, x4, y4, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.lineTo(x4, y4);
  ctx.closePath();
  ctx.fill();
}

function drawObject(ctx, kind, x, y, s, night) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  if (kind === "palm") {
    ctx.fillStyle = "#6b4423";
    ctx.fillRect(-6, -90, 12, 90);
    ctx.fillStyle = "#2f8a3a";
    for (let i = 0; i < 6; i++) {
      const a = (-90 + i * 36) * Math.PI / 180;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * 38, -100 + Math.sin(a) * 10, 34, 10, a, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === "pine") {
    ctx.fillStyle = "#4a3422";
    ctx.fillRect(-5, -40, 10, 40);
    ctx.fillStyle = "#1f4d32";
    ctx.beginPath(); ctx.moveTo(0, -140); ctx.lineTo(38, -40); ctx.lineTo(-38, -40); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -170); ctx.lineTo(28, -90); ctx.lineTo(-28, -90); ctx.fill();
  } else if (kind === "cactus") {
    ctx.fillStyle = "#2f7a3c";
    ctx.fillRect(-8, -80, 16, 80);
    ctx.fillRect(-28, -58, 20, 10);
    ctx.fillRect(-28, -58, 10, 28);
    ctx.fillRect(8, -48, 22, 10);
    ctx.fillRect(20, -48, 10, 22);
  } else if (kind === "rock") {
    ctx.fillStyle = "#6a6258";
    ctx.beginPath(); ctx.moveTo(-24, 0); ctx.lineTo(-10, -28); ctx.lineTo(8, -36); ctx.lineTo(26, -12); ctx.lineTo(18, 0); ctx.fill();
  } else if (kind === "bush") {
    ctx.fillStyle = night ? "#163322" : "#2d6b38";
    ctx.beginPath(); ctx.arc(-10, -10, 16, 0, Math.PI * 2); ctx.arc(10, -12, 18, 0, Math.PI * 2); ctx.arc(0, -20, 14, 0, Math.PI * 2); ctx.fill();
  } else if (kind === "building") {
    ctx.fillStyle = night ? "#14182a" : "#8a8f9c";
    ctx.fillRect(-30, -160, 60, 160);
    ctx.fillStyle = night ? "#ffd36a" : "#c9d3e0";
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 3; c++) {
        if ((r + c) % 2 === 0) ctx.fillRect(-22 + c * 16, -148 + r * 20, 10, 12);
      }
    }
  } else if (kind === "lamp") {
    ctx.fillStyle = "#2a2a30";
    ctx.fillRect(-3, -90, 6, 90);
    ctx.fillStyle = night ? "#fff2a8" : "#d8d8d8";
    ctx.beginPath(); ctx.arc(10, -92, 8, 0, Math.PI * 2); ctx.fill();
    if (night) {
      ctx.fillStyle = "rgba(255,230,140,0.18)";
      ctx.beginPath(); ctx.moveTo(10, -92); ctx.lineTo(-18, 0); ctx.lineTo(38, 0); ctx.fill();
    }
  } else if (kind === "sign") {
    ctx.fillStyle = "#555";
    ctx.fillRect(-3, -50, 6, 50);
    ctx.fillStyle = "#f0b429";
    ctx.fillRect(-22, -78, 44, 28);
    ctx.fillStyle = "#2a1b02";
    ctx.fillRect(-14, -68, 28, 6);
  }
  ctx.restore();
}

function drawFuelPickup(ctx, destX, destY, pixelH) {
  const s = pixelH / 100;
  ctx.save();
  ctx.translate(destX, destY);
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(255, 236, 40, 0.18)";
  ctx.beginPath();
  ctx.ellipse(0, -44, 26, 30, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath();
  ctx.ellipse(0, 10, 46, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(-4, -90, 18, Math.PI * 0.95, Math.PI * 0.08, true);
  ctx.stroke();
  ctx.fillStyle = "#111";
  ctx.fillRect(16, -98, 28, 12);
  ctx.fillStyle = "#e11d2e";
  ctx.fillRect(40, -104, 16, 22);
  ctx.fillStyle = "#ff5a4a";
  ctx.fillRect(43, -101, 10, 8);
  ctx.beginPath();
  ctx.moveTo(-36, -82);
  ctx.lineTo(32, -82);
  ctx.lineTo(42, 6);
  ctx.lineTo(-44, 6);
  ctx.closePath();
  ctx.fillStyle = "#111";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-30, -76);
  ctx.lineTo(26, -76);
  ctx.lineTo(34, 0);
  ctx.lineTo(-38, 0);
  ctx.closePath();
  ctx.fillStyle = "#f5c400";
  ctx.fill();
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = "#8b0d16";
  ctx.fillRect(-28, -58, 54, 9);
  ctx.fillRect(-8, -80, 14, 68);
  ctx.fillStyle = "#111";
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("FUEL", -2, -28);
  ctx.fillStyle = "#e11d2e";
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.bezierCurveTo(14, 6, 8, 22, 0, 22);
  ctx.bezierCurveTo(-8, 22, -14, 6, 0, -8);
  ctx.fill();
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

function fuelPixelSize(p1, h) {
  const carH = 50 * carScreenScale(p1.scale, h) * 1.22;
  return clamp(carH * 0.22, 3, carH * 0.34);
}

function shadeHex(hex, amt) {
  const c = hexToRgb(hex);
  const k = (v) => clamp(Math.round(v + amt), 0, 255);
  return `rgb(${k(c.r)},${k(c.g)},${k(c.b)})`;
}

function drawCar(ctx, x, y, scale, car, steer, nitro) {
  const st = clamp(steer || 0, -1, 1);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale * 1.22);
  // Ground-car turn: soft lean + yaw silhouette (not airplane bank).
  ctx.rotate(st * 0.12);
  ctx.transform(1, 0, -st * 0.10, 1, 0, 0);
  ctx.translate(st * 5, Math.abs(st) * 1.2);
  const body = car.color;
  const accent = car.accent;
  const type = car.silhouette;
  const hi = shadeHex(body, 38);
  const lo = shadeHex(body, -42);
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.beginPath();
  ctx.ellipse(st * 4, 26, 58, 11, st * 0.06, 0, Math.PI * 2);
  ctx.fill();

  const flare = type === "wide" ? 8 : type === "long" ? 2 : 0;
  const tail = type === "long" ? 6 : type === "box" ? -4 : 0;
  const spoiler = type === "gt" || type === "box";
  const wdx = st * 7;
  const yaw = st * 14;

  ctx.fillStyle = "#141418";
  ctx.fillRect(-48 - flare + wdx, 10, 22, 16);
  ctx.fillRect(26 + flare + wdx, 10, 22, 16);
  ctx.fillStyle = accent;
  ctx.fillRect(-46 - flare + wdx, 12, 8, 8);
  ctx.fillRect(38 + flare + wdx, 12, 8, 8);

  ctx.fillStyle = lo;
  ctx.beginPath();
  ctx.moveTo(-50 - flare + yaw * 0.15, 16);
  ctx.lineTo(-42 - flare + yaw, -10 + tail);
  ctx.lineTo(-14 + yaw * 1.15, type === "box" ? -28 : -22);
  ctx.lineTo(14 + yaw * 1.15, type === "box" ? -28 : -22);
  ctx.lineTo(42 + flare + yaw, -10 + tail);
  ctx.lineTo(50 + flare + yaw * 0.15, 16);
  ctx.lineTo(36, 20);
  ctx.lineTo(-36, 20);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = hi;
  ctx.beginPath();
  ctx.moveTo(-28 + yaw * 0.4, 4);
  ctx.lineTo(-12 + yaw * 1.2, -20);
  ctx.lineTo(12 + yaw * 1.2, -20);
  ctx.lineTo(28 + yaw * 0.4, 4);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 2.6;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-50 - flare + yaw * 0.15, 16);
  ctx.lineTo(-42 - flare + yaw, -10 + tail);
  ctx.lineTo(-14 + yaw * 1.15, type === "box" ? -28 : -22);
  ctx.lineTo(14 + yaw * 1.15, type === "box" ? -28 : -22);
  ctx.lineTo(42 + flare + yaw, -10 + tail);
  ctx.lineTo(50 + flare + yaw * 0.15, 16);
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = "rgba(12, 18, 28, 0.92)";
  ctx.beginPath();
  ctx.moveTo(-16 + yaw, -8);
  ctx.lineTo(-8 + yaw * 1.2, -20);
  ctx.lineTo(8 + yaw * 1.2, -20);
  ctx.lineTo(16 + yaw, -8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(180, 205, 230, 0.28)";
  ctx.fillRect(-12 + yaw * 1.15, -18, 24, 6);

  if (Math.abs(st) > 0.18) {
    const side = st > 0 ? -46 - flare : 46 + flare;
    ctx.fillStyle = shadeHex(body, st > 0 ? -18 : 12);
    ctx.beginPath();
    ctx.moveTo(side, 16);
    ctx.lineTo(side + st * 8, -6 + tail);
    ctx.lineTo(side * 0.72 + yaw, -10);
    ctx.lineTo(side * 0.7, 18);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(-38 - flare + yaw, -6, 7, 5);
  ctx.fillRect(31 + flare + yaw, -6, 7, 5);
  ctx.fillStyle = "#ff2a2a";
  ctx.fillRect(-36, 12, 14, 5);
  ctx.fillRect(22, 12, 14, 5);
  ctx.fillStyle = "#ffd0d0";
  ctx.fillRect(-34, 13, 6, 2);
  ctx.fillRect(28, 13, 6, 2);

  ctx.fillStyle = accent;
  ctx.fillRect(-22, 6, 44, 4);
  if (spoiler) {
    ctx.fillStyle = lo;
    ctx.fillRect(-28, -30, 56, 5);
    ctx.fillRect(-26, -26, 4, 8);
    ctx.fillRect(22, -26, 4, 8);
  }

  const boost = typeof nitro === "number" ? nitro : (nitro ? 1 : 0);
  // Draw exhaust FIRST (behind body) so the plume reads clearly.
  if (boost > 0.05) {
    const t = (typeof performance !== "undefined" ? performance.now() : 0) * 0.025;
    const flick = (0.82 + 0.18 * Math.sin(t * 3.4)) * clamp(boost, 0, 1);
    const len = (120 + 50 * (0.5 + 0.5 * Math.sin(t * 4.0))) * flick;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `rgba(30, 200, 255, ${0.45 * flick})`;
    ctx.beginPath();
    ctx.ellipse(0, 38, 78, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    for (const ox of [-20, 0, 20]) {
      const wob = Math.sin(t * 5.0 + ox) * 8;
      const wide = ox === 0 ? 0.85 : 1.15;
      ctx.fillStyle = `rgba(20, 170, 255, ${0.55 * flick})`;
      ctx.beginPath();
      ctx.moveTo(ox - 18 * wide, 16);
      ctx.quadraticCurveTo(ox - 34 * flick * wide + wob, 30 + len * 0.4, ox + wob * 0.4, 26 + len);
      ctx.quadraticCurveTo(ox + 34 * flick * wide + wob, 30 + len * 0.4, ox + 18 * wide, 16);
      ctx.fill();
      ctx.fillStyle = `rgba(180, 250, 255, ${0.7 * flick})`;
      ctx.beginPath();
      ctx.moveTo(ox - 8 * wide, 16);
      ctx.lineTo(ox + wob * 0.3, 16 + len * 0.72);
      ctx.lineTo(ox + 8 * wide, 16);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * flick})`;
      ctx.beginPath();
      ctx.moveTo(ox - 3.5, 16);
      ctx.lineTo(ox, 16 + len * 0.48);
      ctx.lineTo(ox + 3.5, 16);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 140, 40, ${0.55 * flick})`;
      ctx.beginPath();
      ctx.arc(ox + wob * 0.7, 24 + len * 0.85, 5.5 + flick * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 230, 120, ${0.4 * flick})`;
      ctx.beginPath();
      ctx.arc(ox - wob * 0.5, 20 + len * 0.6, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.fillStyle = boost > 0.05 ? "#b8fff8" : "#2a2a30";
  ctx.fillRect(-18, 16, 8, 5);
  ctx.fillRect(10, 16, 8, 5);
  ctx.restore();
}

function wrapDist(a, b, len) {
  let d = a - b;
  const half = len / 2;
  if (d > half) d -= len;
  if (d < -half) d += len;
  return d;
}

function wrapZ(z, len) {
  z %= len;
  if (z < 0) z += len;
  return z;
}

function carScreenScale(projScale, h) {
  return projScale * CAM_H * (h / 720) * CAR_SCALE_AT_PLAYER;
}

export class GameEngine {
  constructor(canvas, audio) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.audio = audio;
    this.keys = {};
    this.mode = "idle";
    this.track = null;
    this.cars = [];
    this.player = null;
    this.camX = 0;
    this.camY = CAM_H;
    this.camZ = 0;
    this.position = 0;
    this.playerX = 0;
    this._ios = isIOSLike();
    this._phone = false;
    this._skyKey = "";
    this._proj = [];
    this._lut = null;
    this._frame = 0;
    this.steer = 0;
    this.slip = 0;
    this.lean = 0;
    this.sideShock = 0;
    this.hitShake = 0;
    this.hitFlash = 0;
    this.fovKick = 0;
    this.time = 0;
    this.lapTime = 0;
    this.bestLap = null;
    this.laps = 1;
    this.totalLaps = 2;
    this.countdown = 0;
    this.finished = false;
    this.results = null;
    this.onFinish = null;
    this.toast = "";
    this.toastT = 0;
    this.lapFlash = null;
    this.lapFlashT = 0;
    this.radio = "";
    this.radioT = 0;
    this._fuelWarn = 0;
    this._nitroRadioLatch = false;
    this._draftRadioLatch = false;
    this.dust = [];
    this.draft = 0;
    this._lastPlace = 8;
    this._placeReady = false;
    this.bumpCool = 0;
    this.upgrades = { engine: 0, tires: 0, nitro: 0 };
    this.playerCarId = "fenix";
    this.resize();
    addEventListener("resize", () => this.resize());
    visualViewport?.addEventListener("resize", () => this.resize());
    visualViewport?.addEventListener("scroll", () => this.resize());
  }

  setPhone(on) {
    this._phone = !!on;
  }

  resize() {
    const box = this.canvas.parentElement || this.canvas;
    const vv = visualViewport;
    let iw = Math.max(1, box.clientWidth || 0, innerWidth);
    let ih = Math.max(1, box.clientHeight || 0, innerHeight);
    if (vv && vv.width > 1 && vv.height > 1) {
      iw = Math.max(iw, vv.width);
      ih = Math.max(ih, vv.height);
    }
    const dprCap = this._ios || this._phone ? 1.5 : 2;
    const dpr = Math.min(devicePixelRatio || 1, dprCap);
    const bw = Math.round(iw * dpr);
    const bh = Math.round(ih * dpr);
    if (this.canvas.width === bw && this.canvas.height === bh) return;
    this.canvas.width = bw;
    this.canvas.height = bh;
    this._skyKey = "";
  }

  findSeg(z) {
    const segs = this.track.segs;
    const i = Math.floor(z / SEG) % segs.length;
    return segs[(i + segs.length) % segs.length];
  }

  percent(z) {
    return (z % SEG) / SEG;
  }

  loadTrack(id) {
    const def = TRACKS.find((t) => t.id === id) || TRACKS[0];
    this.track = buildTrack(def);
    const lut = [];
    for (let i = 0; i < 32; i++) {
      const fogT = Math.pow(i / 31, 1.15) * def.fog;
      lut.push({
        grass0: mixHex(def.grass[0], def.fogColor, fogT),
        grass1: mixHex(def.grass[1], def.fogColor, fogT),
        road0: mixHex(def.road[0], def.fogColor, fogT),
        road1: mixHex(def.road[1], def.fogColor, fogT),
        rumble0: mixHex(def.rumble[0], def.fogColor, fogT),
        rumble1: mixHex(def.rumble[1], def.fogColor, fogT),
        lane: mixHex(def.lane, def.fogColor, fogT),
      });
    }
    this._lut = lut;
    this._skyKey = "";
  }

  setupField(playerCarId, upgrades) {
    this.upgrades = { ...upgrades };
    this.playerCarId = playerCarId;
    const playerBase = CARS.find((c) => c.id === playerCarId) || CARS[0];
    const playerSpec = applyUpgrades(playerBase, upgrades);
    this.cars = [];
    this.player = {
      human: true,
      name: "Você",
      spec: playerSpec,
      car: playerBase,
      x: 0,
      z: PLAYER_Z,
      speed: 0,
      nitroCharges: NITRO_CHARGES,
      nitroBurst: 0,
      nitro: 1,
      fuel: 1,
      laps: 0,
      finished: false,
      finishTime: 0,
      place: 1,
      steer: 0,
      nudgeX: 0,
      nudgeZ: 0,
      speedAim: null,
      bumpLock: 0,
    };
    this.cars.push(this.player);
    const pool = CARS.filter((c) => c.id !== playerCarId);
    const traffic = pool.length ? pool : CARS;
    DRIVERS.filter((d) => !d.human).forEach((d, i) => {
      const base = traffic[i % traffic.length] || CARS[(i + 1) % CARS.length];
      const line = AI_LINES[i % AI_LINES.length];
      const slot = AI_SLOTS[i % AI_SLOTS.length];
      this.cars.push({
        human: false,
        name: d.name,
        skill: d.skill,
        nerve: d.nerve,
        spec: applyUpgrades(base, { engine: 0, tires: 0, nitro: 0 }),
        car: base,
        x: line,
        z: wrapZ(PLAYER_Z + slot, this.track.length),
        speed: 0,
        nitro: 1,
        fuel: 1,
        laps: 0,
        finished: false,
        finishTime: 0,
        place: i + 2,
        steer: 0,
        lane: line,
        line,
        slot,
        laneT: 0.8 + i * 0.35,
        aiIndex: i,
        nudgeX: 0,
        nudgeZ: 0,
        speedAim: null,
        bumpLock: 0,
        _drawX: null,
        _drawY: null,
        _drawS: null,
      });
    });
  }

  startRace(trackId, playerCarId, upgrades, laps) {
    this.loadTrack(trackId);
    this.setupField(playerCarId, upgrades);
    this.totalLaps = laps || this.track.def.laps;
    this.position = 0;
    this.playerX = 0;
    this.steer = 0;
    this.slip = 0;
    this.lean = 0;
    this.sideShock = 0;
    this.hitShake = 0;
    this.hitFlash = 0;
    this.time = 0;
    this.lapTime = 0;
    this.bestLap = null;
    this.laps = 1;
    this.countdown = 3;
    this.finished = false;
    this.dust = [];
    this.draft = 0;
    this._lastPlace = 8;
    this._placeReady = false;
    this.toast = "";
    this.toastT = 0;
    this.lapFlash = null;
    this.lapFlashT = 0;
    this.radio = "";
    this.radioT = 0;
    this._fuelWarn = 0;
    this._nitroRadioLatch = false;
    this._draftRadioLatch = false;
    this._aiDoneAt = 0;
    this.results = null;
    this.mode = "race";
    this.player.z = PLAYER_Z;
    this.player.speed = 0;
    this.player.nitroCharges = NITRO_CHARGES;
    this.player.nitroBurst = 0;
    this.player._nitroLatch = false;
    this.player.nitro = 1;
    this.player.fuel = 1;
    this.player.laps = 0;
    this.cars.forEach((c) => {
      c._lastZ = c.z;
      c._prevZ = c.z;
      c.laps = 0;
      c.finished = false;
      c.nudgeX = 0;
      c.nudgeZ = 0;
      c.speedAim = null;
      c.bumpLock = 0;
      c._drawX = null;
      c._drawY = null;
      c._drawS = null;
    });
    this.position = wrapZ(this.player.z - PLAYER_Z, this.track.length);
    this.camZ = this.position;
    this.camX = this.playerX;
    const seg0 = this.findSeg(this.position);
    this.camY = CAM_H + lerp(seg0.p1.y, seg0.p2.y, this.percent(this.position));
    this.audio.startMusic("race");
  }

  startAttract(trackId, playerCarId) {
    this.loadTrack(trackId || "praia");
    this.setupField(playerCarId || this.playerCarId || "fenix", { engine: 0, tires: 0, nitro: 0 });
    this.mode = "attract";
    this.countdown = 0;
    this.player.speed = 210;
    this.player.z = PLAYER_Z;
    this.position = 0;
    this.camZ = 0;
    this.camX = this.playerX || 0;
    const segA = this.findSeg(0);
    this.camY = CAM_H + lerp(segA.p1.y, segA.p2.y, 0);
    this.cars.forEach((c, i) => {
      if (!c.human) {
        c.speed = 180 + i * 12;
        c.z = PLAYER_Z + (i + 1) * SEG * 8;
      }
    });
    this.audio.startMusic("menu");
  }

  restart() {
    this.startRace(this.track.def.id, this.playerCarId, this.upgrades, this.totalLaps);
  }

  setKeys(keys) { this.keys = keys || this.keys; }

  tryNitro() {
    const p = this.player;
    if (!p || this.mode !== "race" || this.finished) return;
    const off = Math.abs(this.playerX) > 1.05;
    if (p._nitroLatch || p.nitroBurst > 0 || p.nitroCharges <= 0 || p.fuel <= 0 || off) return;
    p.nitroCharges -= 1;
    p.nitroBurst = NITRO_BURST * (p.spec.nitroTank || 1);
    this.fovKick = 1.18;
    p.speed = Math.min(this.maxSpeed(p) * 1.12, p.speed + 110);
    this.audio?.nitro?.();
    this.radioSay("Nitro! Vai fundo!", 1.8);
    p._nitroLatch = true;
    this.keys = { ...this.keys, nitro: true };
  }

  maxSpeed(car) {
    const fuelCut = car.fuel <= 0 ? 0.42 : 1;
    return (car.spec.top * 22) * fuelCut;
  }

  update(dt, rawDt = dt) {
    this._dt = dt;
    if (!this.track || this.mode === "idle") return;
    if (this.mode === "attract") {
      this.autoDrive(dt);
      this.followCamera(dt);
      return;
    }
    if (this.mode !== "race" || this.finished) {
      if (this.finished) {
        this.simulateWorld(dt, false, false);
        this.followCamera(dt);
      }
      return;
    }
    if (this.countdown > 0) {
      this.countdown = Math.max(0, this.countdown - Math.min(0.25, dt));
      this.drivePlayer(dt);
      this.driveAI(dt);
      this.simulateWorld(dt, true, true);
      this.followCamera(dt);
      return;
    }
    this.drivePlayer(dt);
    this.driveAI(dt);
    this.simulateWorld(dt, false);
    this.time += dt;
    this.lapTime += dt;
    this.collisions();
    this.settleBumps(dt);
    this.position = wrapZ(this.player.z - PLAYER_Z, this.track.length);
    this.followCamera(dt);
    this.pickups();
    this.rank();
    {
      const place = this.livePlace(this.player);
      if (!this._placeReady) {
        this._lastPlace = place;
        this._placeReady = true;
      } else if (place < this._lastPlace) {
        this.radioSay(place === 1 ? "Primeiro! Segura a ponta!" : `Passou! Agora ${place}º!`, 1.6);
      }
      this._lastPlace = place;
    }
    this.checkLaps();
    if (this.bumpCool > 0) this.bumpCool -= dt;
  }

  draftBoost() {
    if (!this.player || !this.track) return 0;
    const len = this.track.length;
    const p = this.player;
    let best = 0;
    for (const c of this.cars) {
      if (c.human || c.finished) continue;
      if (Math.abs(this.progress(c) - this.progress(p)) > len * 0.45) continue;
      const dz = wrapDist(c.z, p.z, len);
      // Rival ahead, close, same lane-ish
      if (dz > 120 && dz < 1100 && Math.abs(c.x - this.playerX) < 0.34) {
        const proxim = 1 - (dz - 120) / 980;
        const align = 1 - Math.abs(c.x - this.playerX) / 0.34;
        best = Math.max(best, proxim * align);
      }
    }
    return clamp(best, 0, 1);
  }

  spawnDust(dt, off, speedPct) {
    if (!off || speedPct < 0.18) return;
    this.dust = this.dust || [];
    const n = Math.min(3, 1 + Math.floor(speedPct * 3));
    for (let i = 0; i < n; i++) {
      this.dust.push({
        x: (Math.random() - 0.5) * 0.55,
        y: 0,
        life: 0.28 + Math.random() * 0.35,
        max: 0.55,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -0.15 - Math.random() * 0.35,
        r: 4 + Math.random() * 10,
      });
    }
    if (this.dust.length > 48) this.dust.splice(0, this.dust.length - 48);
  }

  updateDust(dt) {
    if (!this.dust?.length) return;
    for (const d of this.dust) {
      d.life -= dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.r += 18 * dt;
    }
    this.dust = this.dust.filter((d) => d.life > 0);
  }

  drawDust(w, h) {
    if (!this.dust?.length) return;
    const ctx = this.ctx;
    const baseX = this._playerDrawX != null ? this._playerDrawX : w / 2;
    const baseY = h * 0.86;
    ctx.save();
    for (const d of this.dust) {
      const a = clamp(d.life / (d.max || 0.5), 0, 1) * 0.35;
      ctx.fillStyle = `rgba(210, 185, 130, ${a})`;
      ctx.beginPath();
      ctx.ellipse(baseX + d.x * 120, baseY + d.y * 90, d.r, d.r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drivePlayer(dt) {
    const p = this.player;
    const up = this.keys.up;
    const down = this.keys.down;
    const left = this.keys.left;
    const right = this.keys.right;
    const offAmt = Math.max(0, Math.abs(this.playerX) - 1.02);
    const off = offAmt > 0.03;
    const wantNitro = !!this.keys.nitro;
    const canFire = wantNitro && !p._nitroLatch && p.nitroBurst <= 0 && p.nitroCharges > 0 && p.fuel > 0 && !off;
    if (canFire) {
      p.nitroCharges -= 1;
      p.nitroBurst = NITRO_BURST * (p.spec.nitroTank || 1);
      this.fovKick = 1.18;
      p.speed = Math.min(this.maxSpeed(p) * 1.12, p.speed + 110);
      this.audio?.nitro?.();
      this.radioSay("Nitro! Vai fundo!", 1.8);
    }
    p._nitroLatch = wantNitro;
    const boost = p.nitroBurst > 0 && p.fuel > 0 && !off;

    let max = this.maxSpeed(p);
    if (boost) max *= 1.48 + (p.spec.nitro - 1) * 0.35;
    const draft = off ? 0 : this.draftBoost();
    this.draft = lerp(this.draft || 0, draft, 1 - Math.exp(-6 * dt));
    if (this.draft > 0.12) {
      max *= 1 + this.draft * 0.14;
      if (this.draft > 0.55) {
        if (!this._draftRadioLatch) {
          this._draftRadioLatch = true;
          this.radioSay("Vácuo! Colado nele!", 1.4);
        }
      } else if (this.draft < 0.35) {
        this._draftRadioLatch = false;
      }
    } else {
      this._draftRadioLatch = false;
    }
    if ((p.bumpLock || 0) > 0 && p.speedAim != null) {
      max = Math.min(max, p.speedAim);
    }
    if (off) {
      const dirt = 0.36 + ((p.spec.offroad || 1) - 1) * 0.12;
      max *= dirt / (1 + offAmt * 1.15);
    }

    const look = this.findSeg(p.z + 12 * SEG);
    const grip = p.spec.grip * (off ? 0.32 : 1);
    const bend = clamp(Math.abs(look.curve || 0) / 5.0, 0, 1);
    if (!boost) max *= 1 - bend * (0.068 / Math.max(0.72, grip));

    const accel = 1800 * p.spec.accel * (boost ? 2.48 : 1) * (off ? 0.55 : 1);
    if (boost) p.speed = Math.min(max, p.speed + 560 * dt);
    if (up) p.speed += accel * dt;
    else p.speed -= (off ? 780 : 520) * dt;
    if (down) p.speed -= 3800 * dt;
    if (off && p.speed > max) {
      p.speed -= (1600 + (p.speed - max) * 2.4) * dt;
      if (p.speed < max) p.speed = max;
    } else {
      p.speed = clamp(p.speed, 0, max);
    }
    p.speed = Math.max(0, p.speed);

    const speedPct = p.speed / Math.max(1, this.maxSpeed(p));
    this.spawnDust(dt, off, speedPct);
    this.updateDust(dt);
    if (off && speedPct > 0.25) this.hitShake = Math.max(this.hitShake || 0, 0.38 * speedPct);
    const want = (right ? 1 : 0) - (left ? 1 : 0);
    // Easy lane changes — strong lateral move even at mid speed.
    this.steer = lerp(this.steer, want, (off ? 3.4 : 6.0) * dt);
    const turn = (0.78 + grip * 0.48) * (0.72 + 0.70 * speedPct);
    this.playerX += this.steer * turn * dt;
    // Curve drift fights less while you hold a direction.
    const curvePull = want ? 0.014 : (off ? 0.036 : 0.030);
    this.playerX += (-look.curve * curvePull * speedPct) * dt;
    if (!want && (this.sideShock || 0) <= 0) {
      this.playerX = lerp(this.playerX, clamp(-look.curve * 0.028, -0.16, 0.16), (off ? 1.6 : 0.7) * dt);
    }
    if (this.sideShock > 0) this.sideShock = Math.max(0, this.sideShock - dt);
    if (this.hitShake > 0) this.hitShake = Math.max(0, this.hitShake - dt * 2.8);
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 2.2);
    // Only soften at the very edge — don't fight mid-lane turns.
    const tooWide = Math.abs(this.playerX) > 0.92;
    if (tooWide && want && Math.sign(want) === Math.sign(this.playerX)) {
      this.steer = lerp(this.steer, 0, 6 * dt);
    }
    if (Math.abs(this.playerX) > 0.98) {
      this.playerX = lerp(this.playerX, Math.sign(this.playerX) * 0.90, 1.8 * dt);
    }
    if (off) this._recovering = true;
    if (this._recovering) {
      this.playerX = lerp(this.playerX, 0, 1 - Math.exp(-5.2 * dt));
      if (Math.abs(this.playerX) < 0.45) this._recovering = false;
      if (this.toast !== "NITRO") {
        this.toast = "DE VOLTA À PISTA";
        this.toastT = 0.55;
      }
    }
    this.slip = lerp(this.slip, this.steer * speedPct * (off ? 1.15 : 0.7), 3.2 * dt);
    const leanWant = want * (0.32 + 0.22 * speedPct) + this.steer * 0.28;
    this.lean = clamp(lerp(this.lean || 0, leanWant, 1 - Math.exp(-7.5 * dt)), -0.72, 0.72);
    p.steer = this.lean;

    if (p.nitroBurst > 0) p.nitroBurst = Math.max(0, p.nitroBurst - dt);
    if (boost) {
      p.fuel = Math.max(0, p.fuel - dt * 0.05);
      this.fovKick = lerp(this.fovKick, 1.05, 10 * dt);
      if (p.nitroBurst > 0) {
        this.toast = "NITRO";
        this.toastT = 0.2;
      } else if (this.toast === "NITRO") {
        this.toast = "";
        this.toastT = 0;
      }
    } else {
      const speedKick = clamp((speedPct - 0.82) / 0.18, 0, 1) * 0.26;
      this.fovKick = lerp(this.fovKick, speedKick, 3.4 * dt);
      if (this.toast === "NITRO") {
        this.toast = "";
        this.toastT = 0;
      }
    }
    if (p.speed > 80) {
      p.fuel = Math.max(0, p.fuel - dt * (0.0078 + speedPct * 0.0064) / p.spec.fuel);
    }
    if (p.fuel <= 0 && this._fuelWarn < 3) {
      this._fuelWarn = 3;
      this.radioSay("Sem combustível! Economiza!", 2.6);
    } else if (p.fuel > 0 && p.fuel <= 0.12 && this._fuelWarn < 2) {
      this._fuelWarn = 2;
      this.radioSay("Tanque no vermelho!", 2.4);
    } else if (p.fuel > 0.12 && p.fuel <= 0.28 && this._fuelWarn < 1) {
      this._fuelWarn = 1;
      this.radioSay("Combustível baixo!", 2.2);
    } else if (p.fuel > 0.45) {
      this._fuelWarn = 0;
    }
    if (off) {
      if (this.toast !== "NITRO" && this.toast !== "DE VOLTA À PISTA") {
        this.toast = "FORA DA PISTA";
        this.toastT = 0.3;
      }
    }
  }

  autoDrive(dt) {
    const len = this.track.length;
    const p = this.player;
    p.z += 4200 * dt;
    p.z = wrapZ(p.z, len);
    this.position = wrapZ(p.z - PLAYER_Z, len);
    const seg = this.findSeg(p.z);
    this.playerX = lerp(this.playerX, -seg.curve * 0.04, 0.8 * dt);
    p.x = this.playerX;
    this.steer = lerp(this.steer, -seg.curve * 0.08, dt * 2);
    this.player.steer = this.steer;
    this.cars.forEach((c) => {
      if (c.human) return;
      c.z += c.speed * 18 * dt;
      c.z = wrapZ(c.z, len);
    });
  }

  driveAI(dt) {
    const len = this.track.length;
    const player = this.player;
    const playerMax = this.maxSpeed(player);
    const playerSpeed = player.speed || 0;
    const boosting = (player.nitroBurst || 0) > 0;
    // Mild pack reference — never zero if the player stalls at the line.
    const packRef = Math.max(
      playerSpeed * (boosting ? 0.92 : 1),
      playerMax * 0.55,
      2200,
    );
    const kLane = 1 - Math.exp(-2.2 * dt);
    const kX = 1 - Math.exp(-2.8 * dt);
    const kSteer = 1 - Math.exp(-7 * dt);
    for (const c of this.cars) {
      if (c.human || c.finished) continue;
      const here = this.findSeg(c.z);
      const look = this.findSeg(c.z + 14 * SEG);
      const bend = Math.max(Math.abs(here.curve), Math.abs(look.curve));
      const corner = clamp(bend / 5.2, 0, 1);

      // Each rival has their own race pace and keeps racing even if you don't launch.
      const selfMax = this.maxSpeed(c);
      const paceMul = 0.84 + c.skill * 0.12 + ((c.aiIndex || 0) % 5) * 0.018;
      let cruise = selfMax * paceMul;
      cruise *= 1 - corner * (0.08 + (1 - c.skill) * 0.06);
      // Blend a little with the pack so the field stays together, without freezing.
      let target = cruise * 0.72 + packRef * paceMul * 0.28;
      const cap = Math.max(cruise * 1.06, selfMax * 0.98, packRef * 1.02);

      // Same-ribbon gap only (ignore full-lap progress jumps).
      const raceGap = wrapDist(c.z, player.z, len);
      const slot = Math.min(c.slot || 0, len * 0.35);
      const slotErr = raceGap - slot;
      if (raceGap > 5000) target *= 0.86;
      else if (slotErr > 1800) target *= 0.91;
      else if (slotErr > 700) target *= 0.96;
      else if (raceGap < -2800) target = Math.min(cap, target * 1.08);
      else if (slotErr < -1800) target *= 1.05;
      else if (slotErr < -700) target *= 1.02;

      const floor = Math.max(selfMax * 0.42, 1600);
      target = clamp(target, floor, cap);

      if (c.speed < target) c.speed += 3400 * c.spec.accel * (1 - corner * 0.35) * dt;
      else c.speed -= (420 + corner * 920) * dt;
      if (c.speed > cap) c.speed = lerp(c.speed, cap, 1 - Math.exp(-4 * dt));
      c.speed = clamp(c.speed, 0, cap);

      c.laneT = (c.laneT || 0) - dt;
      const curveSign = Math.sign(look.curve || here.curve || 1);
      const inside = -curveSign * 0.42 * corner;
      let want = lerp(c.line, inside, corner * (0.45 + c.skill * 0.15));
      const locked = (c.bumpLock || 0) > 0;

      if (!locked) {
        let blocked = false;
        for (const o of this.cars) {
          if (o === c) continue;
          const dz = wrapDist(o.z, c.z, len);
          if (dz > 50 && dz < 720 && Math.abs((o.x) - c.x) < 0.26) {
            blocked = true;
            const side = ((c.aiIndex || 0) % 2 === 0) ? 1 : -1;
            const pass = clamp(c.line + side * 0.52, -0.82, 0.82);
            if (c.laneT <= 0) {
              c.line = pass;
              c.laneT = 1.8 + c.skill * 0.7;
            }
            want = pass;
            break;
          }
        }
        if (!blocked && c.laneT <= 0) {
          const cycle = 2.5 + ((c.aiIndex || 0) % 3) * 0.45;
          const idx = ((c.aiIndex || 0) + Math.floor(this.time / cycle)) % AI_LINES.length;
          const next = AI_LINES[idx];
          if (Math.abs(next - (c.line || 0)) > 0.1) {
            c.line = next;
            c.laneT = cycle * 0.85;
          } else {
            c.laneT = 0.35;
          }
        }
      } else {
        want = c.line;
      }

      c.lane = lerp(c.lane ?? c.x, want, kLane);
      const dest = clamp(c.lane, -0.86, 0.86);
      c.x = lerp(c.x, dest, kX);
      const steerWant = clamp((dest - c.x) * 1.6 + look.curve * 0.01, -0.28, 0.28);
      c.steer = lerp(c.steer || 0, steerWant, kSteer);
      if (Math.abs(c.x) > 1.02) c.speed = Math.min(c.speed, this.maxSpeed(c) * 0.55);
      c.fuel = Math.max(0.2, c.fuel - dt * 0.01);
    }
  }

  simulateWorld(dt, freezePlayer, freezeAI) {
    const p = this.player;
    const len = this.track.length;
    if (!freezePlayer) {
      const seg = this.findSeg(p.z);
      const speedPct = p.speed / Math.max(1, this.maxSpeed(p));
      {
        const hold = (this.keys?.left || this.keys?.right) ? 0.45 : 1;
        this.playerX -= dt * speedPct * seg.curve * CENTRIFUGAL * hold / (p.spec.grip * (Math.abs(this.playerX) > 1 ? 0.4 : 1));
      }
      p._prevZ = p.z;
      p.z += p.speed * dt;
      p.z = wrapZ(p.z, len);
    } else {
      p._prevZ = p.z;
    }
    this.playerX = clamp(this.playerX, -1.08, 1.08);
    p.x = this.playerX;
    this.position = wrapZ(p.z - PLAYER_Z, len);
    if (!freezeAI) {
      for (const c of this.cars) {
        if (c.human) continue;
        c._prevZ = c.z;
        const step = clamp(c.speed * dt, 0, 4200 * dt + 40);
        c.z = wrapZ(c.z + step, len);
      }
    } else {
      for (const c of this.cars) {
        if (!c.human) c._prevZ = c.z;
      }
    }
    this.toastT -= dt;
    if (this.lapFlashT > 0) {
      this.lapFlashT -= dt;
      if (this.lapFlashT <= 0) this.lapFlash = null;
    }
    if (this.radioT > 0) {
      this.radioT -= dt;
      if (this.radioT <= 0) this.radio = "";
    }
  }

  followCamera(dt) {
    if (!this.track) return;
    const follow = 1 - Math.exp(-(this._phone || this._ios ? 10 : 14) * dt);
    const leanOff = (this.steer || 0) * 0.14 + (this.slip || 0) * 0.10;
    const bumpOff = ((this.hitShake || 0) > 0 ? (Math.random() - 0.5) * 0.04 * this.hitShake : 0);
    const wantX = clamp(this.playerX + leanOff + bumpOff, -0.95, 0.95);
    this.camX = lerp(this.camX, wantX, follow);
    const seg = this.findSeg(this.position);
    const t = this.percent(this.position);
    const nitroLift = (this.fovKick || 0) * 72;
    const wantY = CAM_H + lerp(seg.p1.y, seg.p2.y, t) - nitroLift;
    this.camY = lerp(this.camY, wantY, follow);
    this.camZ = this.position;
  }


  shiftAI(car, dx, dz) {
    if (!car || car.human) return;
    const len = this.track.length;
    // Cap corrections so rivals never "teleport" when unsticking.
    if (dx) {
      dx = clamp(dx, -0.12, 0.12);
      car.x = clamp(car.x + dx, -0.92, 0.92);
      car.line = car.x;
      car.lane = car.x;
      car.laneT = Math.max(car.laneT || 0, 0.8);
      car._drawX = null;
    }
    if (dz) {
      dz = clamp(dz, -12, 12);
      car.z = wrapZ(car.z + dz, len);
      car._drawX = null;
      car._drawY = null;
      car._drawS = null;
    }
  }

  steerAside(car, fromX) {
    if (!car || car.human) return;
    const side = Math.sign(car.x - fromX) || (1 - 2 * ((car.aiIndex || 0) % 2));
    const lane = clamp((fromX || 0) + side * 0.70, -0.82, 0.82);
    car.line = lane;
    car.lane = lane;
    car.laneT = Math.max(car.laneT || 0, 1.4);
  }

  aiDepth(car) {
    const len = this.track.length;
    let d = wrapDist(car.z, this.player.z, len);
    // Cars a lap ahead/behind share the same ribbon Z — without this they
    // "teleport" next to the player when they cross the line.
    if (this.player && car && !car.human) {
      const progGap = this.progress(car) - this.progress(this.player);
      if (progGap > len * 0.5) {
        d = d > 0 ? Math.max(d, len * 0.55) : len * 0.55;
      } else if (progGap < -len * 0.5) {
        d = d < 0 ? Math.min(d, -len * 0.55) : -len * 0.55;
      }
    }
    return d;
  }

  pixelClearX(car) {
    const dz = this.aiDepth(car);
    const cz = Math.max(90, PLAYER_Z + dz);
    const sc = CAM_DEPTH / cz;
    const w = this.canvas.width || 844;
    const h = this.canvas.height || 390;
    const pS = CAR_SCALE_AT_PLAYER * (h / 720);
    const rS = clamp(sc * CAM_H * (h / 720) * CAR_SCALE_AT_PLAYER, 0.14, (h / 720) * 8);
    const needPx = 58 * pS + 52 * rS + 18;
    const worldPerPx = sc * ROAD * (w / 2);
    if (worldPerPx < 1e-6) return 0.9;
    return clamp(needPx / worldPerPx, 0.45, 1.25);
  }

  spriteBox(x, y, scale, steer = 0) {
    const sx = scale;
    const sy = scale * 1.22;
    const st = clamp(steer || 0, -1, 1);
    const cx = x + st * 6 * sx;
    const fat = 52 + Math.abs(st) * 10;
    return {
      l: cx - fat * sx,
      r: cx + fat * sx,
      t: y - 34 * sy,
      b: y + 24 * sy,
    };
  }

  boxesTouch(a, b) {
    const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
    const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return ox > 2 && oy > 3;
  }

  rivalScreenPose(car) {
    const w = this.canvas.width || 844;
    const h = this.canvas.height || 390;
    if (car._drawX != null && car._drawY != null && car._drawS != null) {
      return { x: car._drawX, y: car._drawY, s: car._drawS };
    }
    const dz = this.aiDepth(car);
    const cz = Math.max(90, PLAYER_Z + dz);
    const sc = CAM_DEPTH / cz;
    return {
      x: w / 2 + sc * (car.x - (this.playerX ?? 0)) * ROAD * (w / 2),
      y: h / 2 + sc * CAM_H * (h / 2),
      s: clamp(sc * CAM_H * (h / 720) * CAR_SCALE_AT_PLAYER, 0.14, (h / 720) * 8),
    };
  }

  playerDrawX(w, h, steer) {
    const st = clamp(steer || 0, -1, 1);
    const s = CAR_SCALE_AT_PLAYER * (h / 720);
    const shift = st * (28 * s + 48);
    return clamp(w / 2 - shift, w * 0.26, w * 0.74);
  }

  playerScreenBox() {
    const w = this.canvas.width || 844;
    const h = this.canvas.height || 390;
    const s = CAR_SCALE_AT_PLAYER * (h / 720);
    const st = this.lean || this.player?.steer || 0;
    const dx = this._playerDrawX != null ? this._playerDrawX : this.playerDrawX(w, h, st);
    return this.spriteBox(dx, h * 0.84, s, st);
  }

  spriteHitsPlayer(car) {
    if (!car || car.human || !this.player) return false;
    const dz = this.aiDepth(car);
    if (dz < 10 || dz > 1400) return false;
    const pose = this.rivalScreenPose(car);
    if (pose.s < 0.22) return false;
    const pb = this.playerScreenBox();
    const rb = this.spriteBox(pose.x, pose.y, pose.s, car.steer || 0);
    const ox = Math.min(pb.r, rb.r) - Math.max(pb.l, rb.l);
    const oy = Math.min(pb.b, rb.b) - Math.max(pb.t, rb.t);
    if (ox < 3 || oy < 3) return false;
    const body = pb.t + (pb.b - pb.t) * 0.12;
    if (rb.b < body) return false;
    return true;
  }

  overlapping(a, b) {
    if (!this.track || a === b) return false;
    const len = this.track.length;
    const adz = Math.abs(wrapDist(a.z, b.z, len));
    const adx = Math.abs(a.x - b.x);
    const vsPlayer = a.human || b.human;
    if (vsPlayer) {
      const ai = a.human ? b : a;
      const len = this.track.length;
      if (Math.abs(this.progress(ai) - this.progress(this.player)) > len * 0.45) return false;
      const dz = this.aiDepth(ai);
      const ax = Math.abs(ai.x - (this.playerX ?? this.player.x));
      if (dz > -CAR_HALF_L * 1.2 && dz < CAR_HALF_L * 2.0 && ax < CAR_HALF_W * 3.2) return true;
      if (Math.abs(dz) < CAR_HALF_L * 1.1 && ax < CAR_HALF_W * 3.4) return true;
      if (ax < 0.62 && dz > -200 && dz < 900) return this.spriteHitsPlayer(ai);
      return false;
    }
    return adz < CAR_HALF_L * 2 && adx < CAR_HALF_W * 2;
  }

  shovePlayer(dx) {
    if (!this.player) return;
    this.playerX = clamp(this.playerX + dx, -1.08, 1.08);
    this.player.x = this.playerX;
  }

  unstickFromPlayer(ai) {
    if (!ai || ai.human) return;
    const dz = this.aiDepth(ai);
    const adz = Math.abs(dz);
    const adx = Math.abs(ai.x - this.playerX);
    const side = Math.sign(ai.x - this.playerX) || (1 - 2 * ((ai.aiIndex || 0) % 2));
    const needX = Math.min(this.pixelClearX(ai), 0.42);
    if (adx < needX) this.shiftAI(ai, side * Math.min(needX - adx + 0.04, 0.14), 0);
    // No longitudinal shove — that looked like teleporting.
  }

  unstickPair(a, b) {
    const len = this.track.length;
    const dz = wrapDist(a.z, b.z, len);
    const adz = Math.abs(dz);
    const dx = a.x - b.x;
    const adx = Math.abs(dx);
    const vsPlayer = a.human || b.human;
    if (vsPlayer) {
      this.unstickFromPlayer(a.human ? b : a);
      return true;
    }
    const minZ = CAR_HALF_L * 1.6;
    const minX = CAR_HALF_W * 2;
    if (adz >= minZ || adx >= minX) return false;
    const ahead = dz >= 0 ? a : b;
    const needX = minX - adx + 0.03;
    const shoveX = Math.min(Math.max(needX, 0.08), 0.14);
    // Prefer lane separation; tiny forward nudge only if still stacked.
    this.shiftAI(a, Math.sign(dx || 1) * shoveX * 0.55, 0);
    this.shiftAI(b, -Math.sign(dx || 1) * shoveX * 0.55, 0);
    return true;
  }

  hitPlayer(factor) {
    const p = this.player;
    if (!p) return;
    if ((p.bumpLock || 0) > 0) return;
    p.speed = Math.max(0, p.speed * factor);
    p.speedAim = p.speed;
    p.bumpLock = 0.22;
  }

  queueSlow(car, factor) {
    if (!car) return;
    if (car.human) {
      this.hitPlayer(factor);
      return;
    }
    if ((car.bumpLock || 0) > 0) return;
    const aim = Math.max(0, car.speed * factor);
    if (car.speedAim == null || aim < car.speedAim) car.speedAim = aim;
    car.bumpLock = 1.15;
  }

  queueNudge(car, dx, dz) {
    if (!car || car.human) return;
    this.shiftAI(car, dx, dz);
  }

  settleBumps(dt) {
    const k = 1 - Math.exp(-11 * dt);
    for (const c of this.cars) {
      if (c.bumpLock > 0) c.bumpLock -= dt;
      if (c.human) continue;
      if (c.speedAim != null) {
        if ((c.bumpLock || 0) <= 0) c.speedAim = null;
        else c.speed = lerp(c.speed, c.speedAim, k);
      }
      c.nudgeX = 0;
      c.nudgeZ = 0;
    }
  }

  collisions() {
    if (!this.player || !this.track) return;
    const len = this.track.length;
    const p = this.player;
    const pProg = this.progress(p);
    for (const c of this.cars) {
      if (c.human || c.finished) continue;
      // Different lap on the race clock → never collide / shove (stops teleports).
      if (Math.abs(this.progress(c) - pProg) > len * 0.45) continue;
      if (!this.overlapping(p, c)) continue;
      const dx = this.playerX - c.x;
      const away = Math.sign(dx) || -1;
      // Lateral separation only — never push rivals along the track.
      this.shiftAI(c, -away * 0.06, 0);
      this.unstickFromPlayer(c);
      if ((this.bumpCool || 0) <= 0) {
        this.bumpCool = 0.38;
        this.hitShake = Math.max(this.hitShake || 0, 0.62);
        this.hitFlash = Math.max(this.hitFlash || 0, 0.78);
        this.sideShock = Math.max(this.sideShock || 0, 0.22);
        this.audio?.bump?.();
        if (this.toast !== "NITRO") {
          this.toast = "BATIDA";
          this.toastT = 0.5;
        }
        this.hitPlayer(0.93);
      }
    }
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i];
        const b = this.cars[j];
        if (a.human || b.human) continue;
        const adz = Math.abs(wrapDist(a.z, b.z, len));
        const adx = Math.abs(a.x - b.x);
        if (adz >= CAR_HALF_L * 2 || adx >= CAR_HALF_W * 2) continue;
        const firstHit = (a.bumpLock || 0) <= 0 && (b.bumpLock || 0) <= 0;
        this.unstickPair(a, b);
        if (firstHit) {
          this.queueSlow(a, 0.94);
          this.queueSlow(b, 0.94);
        }
      }
    }
  }


  pickups() {
    const len = this.track.length;
    const z = this.player.z;
    for (let k = -2; k <= 2; k++) {
      const seg = this.findSeg(wrapZ(z + k * SEG, len));
      if (!seg.pickup || seg.pickup.taken) continue;
      if (Math.abs(this.playerX - seg.pickup.x) < 0.48) {
        seg.pickup.taken = true;
        this.player.fuel = 1;
        this._fuelWarn = 0;
        this.audio.pickup?.();
        this.radioSay("Tanque cheio!", 1.5);
        return;
      }
    }
  }

  progress(car) {
    const len = this.track.length;
    return (car.laps || 0) * len + wrapZ(car.z, len);
  }

  aheadOf(a, b) {
    return this.progress(a) > this.progress(b);
  }

  livePlace(car = this.player) {
    if (!car || !this.track) return 1;
    let place = 1;
    for (const o of this.cars) {
      if (o !== car && this.aheadOf(o, car)) place++;
    }
    return place;
  }

  rank() {
    for (const c of this.cars) c.place = this.livePlace(c);
  }

  radioSay(msg, dur = 2.4) {
    if (!msg) return;
    this.radio = msg;
    this.radioT = dur;
  }

  checkLaps() {
    const len = this.track.length;
    for (const c of this.cars) {
      const prev = c._lastZ ?? c.z;
      const z = c.z;
      const crossed = prev > len * 0.62 && z < len * 0.38 && prev - z > len * 0.4;
      if (crossed && this.countdown <= 0 && !c.finished) {
        c.laps += 1;
        if (c.human) {
          const finishedLap = this.lapTime;
          if (this.bestLap == null || finishedLap < this.bestLap) this.bestLap = finishedLap;
          const done = c.laps >= this.totalLaps;
          this.laps = Math.min(this.totalLaps, c.laps + 1);
          this.lapFlash = {
            title: done ? "CHEGADA" : `VOLTA ${c.laps}`,
            place: this.livePlace(this.player),
            time: finishedLap,
          };
          this.lapFlashT = done ? 1.8 : 1.5;
          this.lapTime = 0;
          if (done) {
            const place = this.livePlace(this.player);
            this.toast = place === 1 ? "VITÓRIA!" : "CHEGADA!";
            this.toastT = 1.4;
            const cheers = {
              1: "Bandeirada! Campeão da pista!",
              2: "Chegada! Quase o ouro — brilhante!",
              3: "Chegada! Pódio! Que corrida!",
            };
            this.radioSay(cheers[place] || `Chegada em ${place}º! Que bela corrida!`, 2.6);
          } else {
            this.toast = "";
            this.toastT = 0;
            this.radioSay("Volta completa! Mantém o ritmo!", 2.0);
          }
        }
        if (c.laps >= this.totalLaps) {
          c.finished = true;
          c.finishTime = this.time - z / Math.max(280, c.speed);
          if (!c.human) c.speed *= 0.45;
        }
      }
      c._lastZ = z;
    }
    if (this.player.finished && !this.finished) {
      const allDone = this.cars.every((c) => c.finished);
      const timeout = this.time > this.player.finishTime + 6;
      if (allDone || timeout) this.endRace();
    }
  }

  endRace() {
    this.finished = true;
    this.cars.forEach((c) => {
      if (!c.finished) {
        c.finished = true;
        const remain = Math.max(0, this.totalLaps * this.track.length - this.progress(c));
        c.finishTime = this.time + remain / Math.max(280, c.speed || 400);
      }
    });
    const board = [...this.cars].sort((a, b) => a.finishTime - b.finishTime);
    board.forEach((c, i) => { c.place = i + 1; });
    this.results = board.map((c) => ({
      name: c.name,
      you: !!c.human,
      place: c.place,
      time: c.finishTime,
      car: c.car.name,
    }));
    this.audio.finish();
    this.audio.startMusic("menu");
    if (this.onFinish) this.onFinish(this.results);
  }

  hud() {
    const p = this.player;
    return {
      speed: Math.round((p?.speed || 0) / 22),
      place: this.livePlace(p),
      field: this.cars.length,
      lap: this.laps,
      laps: this.totalLaps,
      time: this.time,
      nitro: (p?.nitroCharges ?? 0) / NITRO_CHARGES,
      nitroCharges: p?.nitroCharges ?? 0,
      nitroMax: NITRO_CHARGES,
      fuel: p?.fuel || 0,
      toast: this.toastT > 0 && this.toast ? this.toast : "",
      countdown: this.countdown,
      boosting: !!(p?.nitroBurst > 0 && p?.fuel > 0 && (p?.speed || 0) > 40 && Math.abs(this.playerX) <= 1),
      drafting: (this.draft || 0) > 0.35,
      bestLap: this.bestLap,
      lapTime: this.lapTime,
      finished: this.finished,
      trackName: this.track?.def?.name || "",
      trackFlag: this.track?.def?.flag || "🏁",
      trackPlace: this.track?.def?.place || "",
      lapFlash: this.lapFlashT > 0 ? this.lapFlash : null,
      radio: this.radioT > 0 && this.radio ? this.radio : "",
    };
  }

  renderMinimap(mapCanvas) {
    if (!this.track || !mapCanvas) return;
    const dpr = Math.min(2, (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1) || 1);
    const cssW = mapCanvas.clientWidth || mapCanvas.width;
    const cssH = mapCanvas.clientHeight || mapCanvas.height;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (mapCanvas.width !== pw || mapCanvas.height !== ph) {
      mapCanvas.width = pw;
      mapCanvas.height = ph;
    }
    const m = mapCanvas.getContext("2d");
    const w = mapCanvas.width, h = mapCanvas.height;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, w, h);

    // Panel fill (matches CSS; redrawn so canvas stays opaque under track)
    const night = !!this.track.def.night;
    const bg = m.createRadialGradient(w * 0.5, h * 0.45, 4, w * 0.5, h * 0.5, w * 0.72);
    bg.addColorStop(0, night ? "rgba(18, 28, 48, 0.92)" : "rgba(10, 16, 28, 0.9)");
    bg.addColorStop(1, night ? "rgba(6, 10, 20, 0.96)" : "rgba(4, 8, 14, 0.96)");
    m.fillStyle = bg;
    m.beginPath();
    const r = 10 * dpr;
    m.moveTo(r, 0); m.arcTo(w, 0, w, h, r); m.arcTo(w, h, 0, h, r); m.arcTo(0, h, 0, 0, r); m.arcTo(0, 0, w, 0, r);
    m.closePath();
    m.fill();

    const pts = this.track.map;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const pad = 18 * dpr;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const ox = (w - spanX * s) / 2;
    const oy = (h - spanY * s) / 2;
    const tx = (x) => ox + (x - minX) * s;
    const ty = (y) => oy + (y - minY) * s;
    m.lineJoin = "round";
    m.lineCap = "round";

    // Soft asphalt outline
    m.beginPath();
    pts.forEach((p, i) => i ? m.lineTo(tx(p.x), ty(p.y)) : m.moveTo(tx(p.x), ty(p.y)));
    m.closePath();
    m.strokeStyle = "rgba(0,0,0,0.55)";
    m.lineWidth = 8 * dpr;
    m.stroke();
    m.strokeStyle = night ? "rgba(80, 110, 150, 0.55)" : "rgba(255,255,255,0.22)";
    m.lineWidth = 6 * dpr;
    m.stroke();
    // Racing line
    m.strokeStyle = night ? "#3de0ff" : "#f0b429";
    m.globalAlpha = 0.95;
    m.lineWidth = 2.4 * dpr;
    m.stroke();
    m.globalAlpha = 1;

    // Start / finish tick
    if (pts.length > 2) {
      const a = pts[0], b = pts[Math.min(6, pts.length - 1)];
      const x0 = tx(a.x), y0 = ty(a.y);
      const ang = Math.atan2(ty(b.y) - y0, tx(b.x) - x0);
      m.save();
      m.translate(x0, y0);
      m.rotate(ang);
      m.fillStyle = "rgba(255,255,255,0.9)";
      m.fillRect(-1.2 * dpr, -5.5 * dpr, 2.4 * dpr, 11 * dpr);
      m.restore();
    }

    // Fuel pickups — small amber pips
    for (const seg of this.track.segs) {
      if (!seg.pickup || seg.pickup.taken) continue;
      const p = pts[seg.index];
      if (!p) continue;
      const x = tx(p.x), y = ty(p.y);
      m.fillStyle = "rgba(245, 196, 0, 0.95)";
      m.beginPath();
      m.arc(x, y, 2.1 * dpr, 0, Math.PI * 2);
      m.fill();
      m.strokeStyle = "rgba(0,0,0,0.45)";
      m.lineWidth = 0.8 * dpr;
      m.stroke();
    }

    // Rivals first (under player)
    for (const c of this.cars) {
      if (c.human || c.finished) continue;
      const i = Math.floor((((c.z % this.track.length) + this.track.length) % this.track.length) / SEG) % pts.length;
      const p = pts[i];
      if (!p) continue;
      const x = tx(p.x), y = ty(p.y);
      m.beginPath();
      m.arc(x, y, 3.4 * dpr, 0, Math.PI * 2);
      m.fillStyle = c.car?.color || "#8899aa";
      m.fill();
      m.strokeStyle = "rgba(255,255,255,0.55)";
      m.lineWidth = 1.1 * dpr;
      m.stroke();
    }

    // Player — large directional arrow (reads clearly on the racing line)
    const player = this.player || this.cars.find((c) => c.human);
    if (player) {
      const len = this.track.length;
      const z = ((player.z % len) + len) % len;
      const i0 = Math.floor(z / SEG) % pts.length;
      const look = Math.max(4, Math.round(8 / Math.max(0.5, s / dpr)));
      const i1 = (i0 + look) % pts.length;
      const p0 = pts[i0], p1 = pts[i1];
      const x = tx(p0.x), y = ty(p0.y);
      let ang = Math.atan2(ty(p1.y) - y, tx(p1.x) - x);
      if (!Number.isFinite(ang)) ang = 0;
      m.save();
      m.translate(x, y);
      m.rotate(ang);
      // dark halo so it pops on gold/cyan track
      m.beginPath();
      m.arc(0, 0, 9.5 * dpr, 0, Math.PI * 2);
      m.fillStyle = "rgba(0,0,0,0.55)";
      m.fill();
      // gold ring
      m.beginPath();
      m.arc(0, 0, 8.2 * dpr, 0, Math.PI * 2);
      m.strokeStyle = "#f0b429";
      m.lineWidth = 2 * dpr;
      m.stroke();
      // arrow
      m.beginPath();
      m.moveTo(9.5 * dpr, 0);
      m.lineTo(-6.5 * dpr, 6.2 * dpr);
      m.lineTo(-3.5 * dpr, 0);
      m.lineTo(-6.5 * dpr, -6.2 * dpr);
      m.closePath();
      m.fillStyle = "#ffffff";
      m.fill();
      m.strokeStyle = "#111111";
      m.lineWidth = 1.6 * dpr;
      m.stroke();
      m.restore();
    }
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._frame += 1;
    if (!this.track) {
      ctx.fillStyle = "#070b14";
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const def = this.track.def;
    const skyKey = `${w}x${h}:${def.id}`;
    if (this._skyKey !== skyKey) {
      const sky = ctx.createLinearGradient(0, 0, 0, h * 0.62);
      sky.addColorStop(0, def.sky[0]);
      sky.addColorStop(1, def.sky[1]);
      this._skyGrad = sky;
      const sun = def.sun;
      const sg = ctx.createRadialGradient(w * sun.x, h * sun.y, 8, w * sun.x, h * sun.y, h * 0.35);
      sg.addColorStop(0, sun.color);
      sg.addColorStop(0.18, sun.glow);
      sg.addColorStop(1, "rgba(0,0,0,0)");
      this._sunGrad = sg;
      this._skyKey = skyKey;
    }
    ctx.fillStyle = this._skyGrad;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = this._sunGrad;
    ctx.fillRect(0, 0, w, h * 0.62);

    if ((this.hitShake || 0) > 0) {
      const s = this.hitShake;
      ctx.translate((Math.random() - 0.5) * 18 * s, (Math.random() - 0.5) * 11 * s);
    }

    this.drawHills(w, h, def);
    this.drawRoad(w, h, def);

    if ((this.hitFlash || 0) > 0.04) {
      const f = clamp(this.hitFlash, 0, 1);
      ctx.fillStyle = `rgba(255, 220, 210, ${0.20 * f})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (this.fovKick > 0.05) {
      const k = this.fovKick;
      const t = this._frame || 0;
      ctx.fillStyle = `rgba(70, 200, 255, ${0.12 * k})`;
      ctx.fillRect(0, 0, w, h);
      const rg = ctx.createRadialGradient(w * 0.5, h * 0.78, 8, w * 0.5, h * 0.72, h * 0.62);
      rg.addColorStop(0, `rgba(255, 255, 255, ${0.16 * k})`);
      rg.addColorStop(0.35, `rgba(80, 220, 255, ${0.08 * k})`);
      rg.addColorStop(1, "rgba(0, 40, 80, 0)");
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = `rgba(200, 245, 255, ${0.14 * k})`;
      ctx.lineWidth = 2;
      const lines = this._phone || this._ios ? 8 : 14;
      for (let i = 0; i < lines; i++) {
        const drift = ((t * 7 + i * 37) % 40);
        const y = h * 0.52 + i * 16 + drift * 0.35;
        const spread = 36 + i * 38;
        ctx.beginPath();
        ctx.moveTo(w * 0.5 - 28 - spread * 0.25, y);
        ctx.lineTo(w * 0.5 - 70 - spread, y + 14 + (i % 3));
        ctx.moveTo(w * 0.5 + 28 + spread * 0.25, y);
        ctx.lineTo(w * 0.5 + 70 + spread, y + 14 + (i % 3));
        ctx.stroke();
      }
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.1 * k})`;
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const y = h * 0.6 + ((t * 11 + i * 29) % 90);
        ctx.beginPath();
        ctx.moveTo(w * 0.5 - 12, y);
        ctx.lineTo(w * 0.5 - 40 - i * 18, y + 22);
        ctx.moveTo(w * 0.5 + 12, y);
        ctx.lineTo(w * 0.5 + 40 + i * 18, y + 22);
        ctx.stroke();
      }
    }
  }

  drawHills(w, h, def) {
    const ctx = this.ctx;
    const drift = this.camX * 55 + (this.findSeg(this.camZ).curve || 0) * 28;
    const base = h * 0.545;
    ctx.fillStyle = mixHex(def.grass[1], def.sky[0], 0.4);
    ctx.beginPath();
    ctx.moveTo(-w * 0.1, base);
    const steps = this._phone || this._ios ? 10 : 14;
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * w * 1.2 - drift - w * 0.1;
      const y = h * 0.36 + Math.sin(i * 0.7 + 0.4) * h * 0.08 + Math.sin(i * 1.6) * h * 0.03;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w * 1.1, base);
    ctx.fill();
    ctx.fillStyle = mixHex(def.grass[0], def.fogColor, 0.25);
    ctx.beginPath();
    ctx.moveTo(-w * 0.1, base);
    const steps2 = this._phone || this._ios ? 10 : 16;
    for (let i = 0; i <= steps2; i++) {
      const x = (i / steps2) * w * 1.2 - drift * 0.45 - w * 0.1;
      const y = h * 0.44 + Math.sin(i * 1.1 + 1.7) * h * 0.045;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w * 1.1, base);
    ctx.fill();
  }

  drawDistance() {
    if (this._phone || this._ios) return 320;
    return 280;
  }

  drawRoad(w, h, def) {
    const ctx = this.ctx;
    const segs = this.track.segs;
    const drawN = this.drawDistance();
    const camZ = this.camZ;
    const baseSeg = this.findSeg(camZ);
    const t = this.percent(camZ);
    const camY = this.camY;
    const playerSegI = baseSeg.index;
    const camXWorld = this.camX * ROAD;
    let maxY = h;
    if (this._proj.length !== drawN) {
      this._proj = Array.from({ length: drawN }, () => ({ seg: null, p1: null, p2: null, clip: 0 }));
    }
    const projected = this._proj;
    let x = 0;
    let dx = -(t * baseSeg.curve);
    let prevP2 = null;
    const spriteUntil = Math.floor(drawN * 0.52);
    for (let n = 0; n < drawN; n++) {
      const seg = segs[(playerSegI + n) % segs.length];
      const looped = (playerSegI + n) >= segs.length;
      const cz = camZ - (looped ? this.track.length : 0);
      const p1 = prevP2 || project(seg.p1, camXWorld - x, camY, cz, w, h);
      const p2 = project(seg.p2, camXWorld - x - dx, camY, cz, w, h);
      const pack = projected[n];
      pack.seg = seg;
      pack.p1 = p1;
      pack.p2 = p2;
      pack.clip = maxY;
      prevP2 = p2;
      x += dx;
      dx += seg.curve;
    }

    const lut = this._lut;
    const lutMax = lut ? lut.length - 1 : 0;
    for (let n = 0; n < drawN; n++) {
      const pack = projected[n];
      const { seg, p1, p2 } = pack;
      pack.clip = maxY;
      if (p1.cz <= 1 && p2.cz <= 1) continue;
      if (p1.y < p2.y - 6) continue;
      if (p2.y >= maxY && p1.y >= maxY) continue;
      const pal = lut[Math.min(lutMax, (n / drawN * lutMax) | 0)];
      const grass = seg.light ? pal.grass0 : pal.grass1;
      const road = seg.light ? pal.road0 : pal.road1;
      const rumble = seg.light ? pal.rumble0 : pal.rumble1;
      poly(ctx, 0, p1.y, w, p1.y, w, p2.y, 0, p2.y, grass);
      const r1 = rumbleW(p1.w), r2 = rumbleW(p2.w);
      poly(ctx, p1.x - p1.w - r1, p1.y, p1.x - p1.w, p1.y, p2.x - p2.w, p2.y, p2.x - p2.w - r2, p2.y, rumble);
      poly(ctx, p1.x + p1.w + r1, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x + p2.w + r2, p2.y, rumble);
      poly(ctx, p1.x - p1.w, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x - p2.w, p2.y, road);
      if (seg.light && p1.w > 18) {
        const lanew1 = p1.w * 2 / LANES;
        const lanew2 = p2.w * 2 / LANES;
        let lanex1 = p1.x - p1.w + lanew1;
        let lanex2 = p2.x - p2.w + lanew2;
        const l1 = laneW(p1.w), l2 = laneW(p2.w);
        for (let laneN = 1; laneN < LANES; laneN++, lanex1 += lanew1, lanex2 += lanew2) {
          poly(ctx, lanex1 - l1 / 2, p1.y, lanex1 + l1 / 2, p1.y, lanex2 + l2 / 2, p2.y, lanex2 - l2 / 2, p2.y, pal.lane);
        }
      }
      if (seg.index < 6) {
        const stripe = seg.index % 2 === 0 ? "#f4f4f4" : "#d1242f";
        poly(ctx, p1.x - p1.w, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x - p2.w, p2.y, stripe);
      }
      if (seg.pickup && !seg.pickup.taken && p1.w > 6) {
        const mx1 = p1.x + p1.scale * seg.pickup.x * ROAD * w / 2;
        const mx2 = p2.x + p2.scale * seg.pickup.x * ROAD * w / 2;
        const hw1 = Math.max(2, p1.w * 0.1);
        const hw2 = Math.max(2, p2.w * 0.1);
        poly(ctx, mx1 - hw1, p1.y, mx1 + hw1, p1.y, mx2 + hw2, p2.y, mx2 - hw2, p2.y, "#f5c400");
        const in1 = hw1 * 0.45, in2 = hw2 * 0.45;
        poly(ctx, mx1 - in1, p1.y, mx1 + in1, p1.y, mx2 + in2, p2.y, mx2 - in2, p2.y, "#e11d2e");
      }
      if (p1.y < maxY) maxY = p1.y;
    }
    const horizon = h * 0.545;
    if (maxY > horizon + 4) {
      const pal = lut[lutMax];
      ctx.fillStyle = pal.grass1;
      ctx.fillRect(0, horizon, w, maxY - horizon);
    }

    for (let n = spriteUntil; n >= 0; n--) {
      const { seg, p1, clip } = projected[n];
      if (!p1?.scale || p1.scale < 0.018) continue;
      for (const spr of seg.sprites) {
        const destY = p1.y;
        if (destY > clip) continue;
        const destX = p1.x + p1.scale * spr.offset * ROAD * w / 2;
        const s = p1.scale * SPRITE_SCALE * ROAD * (w / 880) * spr.scale;
        if (s < 0.14) continue;
        drawObject(ctx, spr.kind, destX, destY, s, def.night);
      }
    }

    for (let n = drawN - 1; n >= 0; n--) {
      const { seg, p1, clip } = projected[n];
      if (!seg?.pickup || seg.pickup.taken || !p1?.scale) continue;
      if (p1.y > clip + 40 || p1.y < -80) continue;
      const destX = p1.x + p1.scale * seg.pickup.x * ROAD * w / 2;
      drawFuelPickup(ctx, destX, p1.y, fuelPixelSize(p1, h));
    }

    const sprites = [];
    for (const c of this.cars) {
      const spr = this.projectCar(c, projected, w, h, drawN);
      if (spr) sprites.push(spr);
    }
    sprites.sort((a, b) => b.z - a.z);
    const you = sprites.find((s) => s.human);
    const drawOne = (s) => {
      let nitro = 0;
      if (s.human && this.mode === "race" && (s.c.nitroBurst || 0) > 0) {
        const maxB = NITRO_BURST * (s.c.spec?.nitroTank || 1);
        nitro = clamp((s.c.nitroBurst || 0) / Math.max(0.35, maxB), 0, 1);
      }
      const st = s.human
        ? clamp(s.c.steer || 0, -1, 1)
        : clamp(s.c.steer || 0, -0.28, 0.28);
      let dx = s.destX;
      if (s.human) {
        dx = this.playerDrawX(this.canvas.width, this.canvas.height, st);
        this._playerDrawX = dx;
      }
      drawCar(this.ctx, dx, s.destY, s.s, s.c.car, st, nitro);
      if (nitro > 0.05 && s.human) {
        const ctx = this.ctx;
        const t = (this._frame || 0) * 0.35;
        const flick = 0.75 + 0.25 * Math.sin(t);
        const sy = s.s * 1.22;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const gy = s.destY + 18 * sy;
        const g = ctx.createRadialGradient(dx, gy, 2, dx, gy + 40 * s.s, 90 * s.s * flick);
        g.addColorStop(0, `rgba(255,255,255,${0.55 * nitro * flick})`);
        g.addColorStop(0.25, `rgba(120,230,255,${0.45 * nitro * flick})`);
        g.addColorStop(0.6, `rgba(40,160,255,${0.22 * nitro})`);
        g.addColorStop(1, "rgba(0,60,120,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(dx, gy + 28 * s.s, 55 * s.s * flick, 70 * s.s * flick, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };
    for (const s of sprites) {
      if (s.human) continue;
      if (s.destY > s.clip + 24) continue;
      drawOne(s);
    }
    if (you) drawOne(you);
    this.drawDust(w, h);
  }

  projectCar(c, projected, w, h, drawN) {
    if (c.human) {
      return {
        z: PLAYER_Z,
        destX: w / 2,
        destY: h * 0.84,
        s: CAR_SCALE_AT_PLAYER * (h / 720),
        c,
        clip: h,
        human: true,
      };
    }
    const len = this.track.length;
    // Hide rivals that are ~a lap away on race progress (same ribbon Z looks like a teleport).
    if (Math.abs(this.progress(c) - this.progress(this.player)) > len * 0.45) {
      c._drawX = c._drawY = c._drawS = null;
      return null;
    }
    const segs = this.track.segs;
    const camZ = this.camZ;
    const camI = this.findSeg(camZ).index;
    const carI = this.findSeg(c.z).index;
    let n = carI - camI;
    if (n < 0) n += segs.length;
    if (n < 1 || n > drawN - 3) return null;
    const pack = projected[n];
    const nxt = projected[n + 1] || pack;
    if (!pack?.p1?.scale) return null;
    const pct = this.percent(c.z);
    const p1 = pack.p1;
    const p2 = nxt.p1?.scale ? nxt.p1 : pack.p2;
    const sc = lerp(p1.scale, p2.scale, pct);
    if (sc <= 0) return null;
    const destY = lerp(p1.y, p2.y, pct);
    const destX = lerp(p1.x, p2.x, pct) + sc * c.x * ROAD * w / 2;
    let s = carScreenScale(sc, h);
    s = clamp(s, 0.14, (h / 720) * 8);
    const dt = Math.max(0.008, this._dt || 1 / 60);
    const kX = 1 - Math.exp(-26 * dt);
    const kY = 1 - Math.exp(-40 * dt);
    if (c._drawX == null || Math.abs(destX - c._drawX) > 140 || Math.abs(destY - c._drawY) > 110) {
      c._drawX = destX;
      c._drawY = destY;
      c._drawS = s;
    } else {
      c._drawX = lerp(c._drawX, destX, kX);
      c._drawY = lerp(c._drawY, destY, kY);
      c._drawS = lerp(c._drawS, s, kY);
    }
    return {
      z: wrapDist(c.z, camZ, len),
      destX: c._drawX,
      destY: c._drawY,
      s: c._drawS,
      c,
      clip: pack.clip,
      human: false,
    };
  }
}
