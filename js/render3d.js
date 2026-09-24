/**
 * TOP RELÂMPAGO — renderer Three.js (mobile-first).
 * Mantém a lógica da engine (z, x, segs) e só desenha:
 * fita da pista + carros baixo-poli + props laterais.
 * Se o WebGL falhar, o app.js cai no canvas 2D clássico.
 */
import * as THREE from "three";

const SEG = 200;
const ROAD = 2100;
const PLAYER_Z = 900 * (1 / Math.tan((50 * Math.PI) / 180));
const NITRO_BURST = 1.75;
const XZ = 0.0115;
const Y_HILL = 0.00092;
const ROAD_W = ROAD * XZ;
const EYE_H = 2.62;
const CAM_BACK = 6.55;
const LOOK_AHEAD = 38;
const MAX_DRAW = 256;
const MAX_PROPS = 96;
const PROP_KINDS = ["palm", "pine", "cactus", "rock", "bush", "building", "lamp", "sign"];

function probeWebGL() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl");
    return !!gl;
  } catch (_) {
    return false;
  }
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexColor(hex) {
  return new THREE.Color(hex);
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

function lambert(color, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}

export class Renderer3D {
  constructor() {
    this.ok = false;
    this.canvas = null;
    this.lowFx = false;
    this.reduceMotion = false;
    this._phone = false;
    this._trackId = "";
    this._dummy = new THREE.Object3D();
    this._look = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._color = new THREE.Color();
    this._fog = new THREE.Color();
    this._stations = Array.from({ length: MAX_DRAW + 2 }, () => ({
      x: 0, y: 0, z: 0, seg: null, n: 0,
    }));
    this._nSta = 0;
    this._carPool = [];
    this._propPool = {};
    this._fuelPool = [];
    this._dust = [];
    this._fpsEma = 16.6;
    this._slow = 0;
    this._lastT = 0;
    this._antialias = false;
    this._dprCap = 1.5;
  }

  isOk() {
    return this.ok;
  }

  _refreshFx(phone) {
    this.reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    const narrow = !!(window.matchMedia && window.matchMedia("(max-width: 900px)").matches);
    this._phone = !!phone || coarse;
    this.lowFx = this.reduceMotion || this._phone || narrow;
    this._coarse = coarse;
    this._narrow = narrow;
  }

  init(canvas, opts = {}) {
    this.canvas = canvas;
    this._refreshFx(opts.phone);
    try {
      window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => this._refreshFx(this._phone));
      window.matchMedia("(pointer: coarse)").addEventListener("change", () => this._refreshFx(this._phone));
    } catch (_) { /* ok */ }

    if (!probeWebGL()) return false;
    if (!THREE || !THREE.WebGLRenderer) return false;

    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x87c8ff);
      scene.fog = new THREE.FogExp2(0xcfe8ff, this.lowFx ? 0.014 : 0.0085);

      const camera = new THREE.PerspectiveCamera(74, 1, 0.28, this.lowFx ? 220 : 340);

      this._antialias = !this.lowFx;
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: this._antialias,
        powerPreference: "high-performance",
        alpha: false,
      });
      this._dprCap = this._phone ? 1 : 1.5;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._dprCap));
      if (renderer.outputColorSpace !== undefined) renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = false;
      renderer.setClearColor(0x87c8ff, 1);

      this.scene = scene;
      this.camera = camera;
      this.renderer = renderer;

      this.ambient = new THREE.AmbientLight(0xffd7a0, 0.55);
      scene.add(this.ambient);
      this.hemi = new THREE.HemisphereLight(0x9ad4ff, 0x6a7a40, 0.95);
      scene.add(this.hemi);
      this.sun = new THREE.DirectionalLight(0xfff2d0, 1.15);
      this.sun.position.set(18, 28, 10);
      scene.add(this.sun);

      this.nitroLight = new THREE.PointLight(0x66e8ff, 0, 16, 2);
      scene.add(this.nitroLight);

      this._makeSky();
      this._makeRibbons();
      this._makeHills();
      this._makeProps();
      this._makeFuel();
      this._makeDust();
      this._makeFlash();

      this.root = new THREE.Group();
      scene.add(this.root);

      this.ok = true;
      this.resize();
      return true;
    } catch (err) {
      console.error("RELÂMPAGO WebGL init failed", err);
      this.ok = false;
      this.dispose();
      return false;
    }
  }

  dispose() {
    try {
      this.renderer?.dispose?.();
    } catch (_) { /* ok */ }
    this.ok = false;
  }

  resize() {
    if (!this.renderer || !this.camera || !this.canvas) return;
    const box = this.canvas.parentElement || this.canvas;
    const vv = window.visualViewport;
    let iw = Math.max(1, box.clientWidth || 0, window.innerWidth || 1);
    let ih = Math.max(1, box.clientHeight || 0, window.innerHeight || 1);
    if (vv && vv.width > 1 && vv.height > 1) {
      iw = Math.max(iw, vv.width);
      ih = Math.max(ih, vv.height);
    }
    const dprCap = this.lowFx || this._phone ? (this._slow > 24 ? 1 : 1.25) : this._dprCap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    this.camera.aspect = iw / Math.max(1, ih);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(iw, ih, false);
  }

  _makeSky() {
    const geo = new THREE.SphereGeometry(260, 12, 8);
    const cols = new Float32Array(geo.attributes.position.count * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this._skyCols = cols;
    this._skyPos = geo.attributes.position;

    const sunGeo = new THREE.SphereGeometry(4.2, 10, 8);
    this.sunMesh = new THREE.Mesh(sunGeo, new THREE.MeshBasicMaterial({ color: 0xfff3c4, fog: false }));
    this.scene.add(this.sunMesh);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(9.5, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffbe5c, transparent: true, opacity: 0.22, depthWrite: false, fog: false }),
    );
    this.sunMesh.add(glow);
  }

  _paintSky(c0, c1) {
    const a = hexColor(c0);
    const b = hexColor(c1);
    const pos = this._skyPos;
    const cols = this._skyCols;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 260;
      const t = clamp((y + 0.12) / 1.05, 0, 1);
      cols[i * 3] = lerp(b.r, a.r, t);
      cols[i * 3 + 1] = lerp(b.g, a.g, t);
      cols[i * 3 + 2] = lerp(b.b, a.b, t);
    }
    this.sky.geometry.attributes.color.needsUpdate = true;
  }

  _makeRibbons() {
    const sta = MAX_DRAW + 1;
    const road = this._stripGeo(sta, true);
    const grass = this._stripGeo(sta, true);
    this.roadMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      map: this._makeRoadTexture("#5a5a5e", "#f2f2f2", "#d3542f", "#efefef"),
    });
    this.grassMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.roadMesh = new THREE.Mesh(road.geo, this.roadMat);
    this.grassMesh = new THREE.Mesh(grass.geo, this.grassMat);
    this.roadMesh.frustumCulled = false;
    this.grassMesh.frustumCulled = false;
    this.roadMesh.matrixAutoUpdate = false;
    this.grassMesh.matrixAutoUpdate = false;
    this.scene.add(this.grassMesh);
    this.scene.add(this.roadMesh);
    this._road = road;
    this._grass = grass;
  }

  _stripGeo(sta, colors) {
    const vCount = sta * 2;
    const pos = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const col = colors ? new Float32Array(vCount * 3) : null;
    const nrm = new Float32Array(vCount * 3);
    for (let i = 0; i < vCount; i++) nrm[i * 3 + 1] = 1;
    const idx = new Uint32Array((sta - 1) * 6);
    let k = 0;
    for (let i = 0; i < sta - 1; i++) {
      const a = i * 2;
      idx[k++] = a;
      idx[k++] = a + 1;
      idx[k++] = a + 2;
      idx[k++] = a + 1;
      idx[k++] = a + 3;
      idx[k++] = a + 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    if (col) geo.setAttribute("color", new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 80), 400);
    return { geo, pos, uv, col, sta };
  }

  _makeRoadTexture(asphalt, rumbleA, rumbleB, lane) {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 256;
    const g = c.getContext("2d");
    g.fillStyle = asphalt;
    g.fillRect(0, 0, 128, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 128; x++) {
        if (((x * 17 + y * 13) % 23) === 0) {
          g.fillStyle = "rgba(0,0,0,0.08)";
          g.fillRect(x, y, 1, 1);
        }
      }
    }
    const rw = 11;
    for (let y = 0; y < 256; y += 16) {
      g.fillStyle = (y / 16) % 2 === 0 ? rumbleA : rumbleB;
      g.fillRect(0, y, rw, 16);
      g.fillRect(128 - rw, y, rw, 16);
    }
    g.fillStyle = lane;
    for (let y = 0; y < 256; y += 28) {
      g.fillRect(42, y, 4, 16);
      g.fillRect(82, y, 4, 16);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.anisotropy = 1;
    tex.needsUpdate = true;
    if (tex.colorSpace !== undefined && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _applyTrackVisuals(def) {
    if (!def) return;
    this._paintSky(def.sky[0], def.sky[1]);
    this._fog.set(def.fogColor);
    this.scene.background = hexColor(def.sky[0]);
    this.scene.fog.color.copy(this._fog);
    const dens = (this.lowFx ? 0.013 : 0.0082) * (0.65 + def.fog * 0.7);
    this.scene.fog.density = dens;
    this.ambient.color.set(def.ambient);
    this.ambient.intensity = def.night ? 0.28 : 0.55;
    this.hemi.color.set(def.sky[0]);
    this.hemi.groundColor.set(def.grass[1]);
    this.hemi.intensity = def.night ? 0.42 : 0.92;
    this.sun.color.set(def.sun.color);
    this.sun.intensity = def.night ? 0.22 : 1.12;
    this.sun.position.set((def.sun.x - 0.5) * 40, 18 + (0.35 - def.sun.y) * 36, 12);
    this.sunMesh.material.color.set(def.sun.color);
    this.sunMesh.visible = !def.night;
    this.renderer.setClearColor(def.sky[0], 1);
    if (this.roadMat.map) this.roadMat.map.dispose();
    this.roadMat.map = this._makeRoadTexture(def.road[0], def.rumble[0], def.rumble[1], def.lane);
    this.roadMat.needsUpdate = true;
    this._g0 = hexColor(def.grass[0]);
    this._g1 = hexColor(def.grass[1]);
    this._r0 = hexColor(def.road[0]);
    this._r1 = hexColor(def.road[1]);
    this._paintHills(def);
  }

  _makeHills() {
    this.hills = new THREE.Group();
    this.scene.add(this.hills);
    this._hillMeshes = [];
    for (let i = 0; i < 14; i++) {
      const h = 7 + (i % 5) * 4.2;
      const w = 11 + (i % 4) * 6;
      const mesh = new THREE.Mesh(
        new THREE.ConeGeometry(w * 0.55, h, 5),
        lambert(0x6a8a58),
      );
      mesh.position.set((i - 6.5) * 18, h * 0.28, 70 + (i % 3) * 12);
      this.hills.add(mesh);
      this._hillMeshes.push(mesh);
    }
  }

  _paintHills(def) {
    const c = hexColor(def.grass[1]).lerp(hexColor(def.sky[0]), 0.28);
    for (const m of this._hillMeshes) {
      m.material.color.copy(c);
      m.visible = !this.lowFx || this._hillMeshes.indexOf(m) % 2 === 0;
    }
  }

  _makeProps() {
    for (const kind of PROP_KINDS) {
      const proto = this._propMesh(kind);
      proto.visible = false;
      this.scene.add(proto);
      const items = [proto];
      const extra = this.lowFx ? 16 : 28;
      for (let i = 1; i < extra; i++) {
        const c = proto.clone(true);
        c.visible = false;
        this.scene.add(c);
        items.push(c);
      }
      this._propPool[kind] = { items, used: 0 };
    }
  }

  _propMesh(kind) {
    const g = new THREE.Group();
    g.userData.kind = kind;
    if (kind === "palm") {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 3.4, 5), lambert(0x6b4423));
      trunk.position.y = 1.7;
      g.add(trunk);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1.15, 6, 4), lambert(0x2f8a3a));
      crown.scale.set(1.6, 0.42, 1.6);
      crown.position.y = 3.45;
      g.add(crown);
    } else if (kind === "pine") {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.3, 5), lambert(0x4a3422));
      trunk.position.y = 0.65;
      g.add(trunk);
      const a = new THREE.Mesh(new THREE.ConeGeometry(1.15, 3.1, 6), lambert(0x1f4d32));
      a.position.y = 2.55;
      g.add(a);
    } else if (kind === "cactus") {
      const m = lambert(0x2f7a3c);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 2.6, 6), m);
      stem.position.y = 1.3;
      g.add(stem);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 1.1, 5), m);
      arm.position.set(-0.55, 1.7, 0);
      arm.rotation.z = 0.9;
      g.add(arm);
    } else if (kind === "rock") {
      const r = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 0), lambert(0x6a6258));
      r.scale.set(1.4, 0.85, 1.1);
      r.position.y = 0.4;
      g.add(r);
    } else if (kind === "bush") {
      const m = lambert(0x2d6b38);
      for (const [x, y, s] of [[-0.35, 0.45, 0.55], [0.3, 0.5, 0.62], [0.05, 0.7, 0.48]]) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(s, 6, 5), m);
        b.position.set(x, y, 0);
        g.add(b);
      }
    } else if (kind === "building") {
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 5.4, 1.8), lambert(0x8a8f9c));
      body.position.y = 2.7;
      g.add(body);
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 4.2, 0.08),
        new THREE.MeshLambertMaterial({ color: 0xc9d3e0, emissive: 0xffd36a, emissiveIntensity: 0.35 }),
      );
      win.position.set(0, 2.8, 0.92);
      g.add(win);
    } else if (kind === "lamp") {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.2, 5), lambert(0x2a2a30));
      pole.position.y = 1.6;
      g.add(pole);
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 6, 5),
        new THREE.MeshLambertMaterial({ color: 0xfff2a8, emissive: 0xffe080, emissiveIntensity: 0.8 }),
      );
      bulb.position.set(0.28, 3.15, 0);
      g.add(bulb);
    } else if (kind === "sign") {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.8, 5), lambert(0x555555));
      pole.position.y = 0.9;
      g.add(pole);
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.7, 0.08), lambert(0xf0b429));
      board.position.y = 1.95;
      g.add(board);
    }
    return g;
  }

  _makeFuel() {
    const proto = new THREE.Group();
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.9, 8), lambert(0xf5c400));
    can.position.y = 0.55;
    proto.add(can);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.18), lambert(0xe11d2e));
    cap.position.set(0.22, 1.05, 0);
    proto.add(cap);
    proto.visible = false;
    this.scene.add(proto);
    this._fuelPool = [proto];
    for (let i = 1; i < 8; i++) {
      const c = proto.clone(true);
      c.visible = false;
      this.scene.add(c);
      this._fuelPool.push(c);
    }
  }

  _makeDust() {
    this._dust = [];
    if (this.lowFx) return;
    const geo = new THREE.SphereGeometry(0.18, 5, 4);
    const mat = new THREE.MeshBasicMaterial({ color: 0xd2b982, transparent: true, opacity: 0.35, depthWrite: false });
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      this.scene.add(m);
      this._dust.push({ mesh: m, life: 0 });
    }
  }

  _makeFlash() {
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffdcd2,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.flash = new THREE.Mesh(geo, mat);
    this.flash.frustumCulled = false;
    this.flash.renderOrder = 999;
    this.flash.position.z = -0.6;
    this.camera.add(this.flash);
    this.scene.add(this.camera);
  }

  _carMesh(car) {
    const g = new THREE.Group();
    const type = car.silhouette || "gt";
    const bodyLen = type === "long" ? 4.9 : type === "box" ? 3.7 : 4.2;
    const bodyWid = type === "wide" ? 2.35 : 2.05;
    const bodyH = type === "box" ? 0.82 : 0.62;
    const bodyMat = lambert(car.color);
    const accent = lambert(car.accent);
    const dark = lambert(0x141418);
    const glass = new THREE.MeshLambertMaterial({ color: 0x0c121c, emissive: 0x8ab4d4, emissiveIntensity: 0.18 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(bodyWid, bodyH, bodyLen), bodyMat);
    body.position.y = 0.62;
    g.add(body);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(bodyWid * 0.72, 0.55, bodyLen * 0.42), glass);
    cabin.position.set(0, 1.05, bodyLen * 0.05);
    g.add(cabin);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(bodyWid * 0.18, bodyH + 0.04, bodyLen * 0.9), accent);
    stripe.position.y = 0.64;
    g.add(stripe);

    const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.28, 8);
    const places = [
      [-bodyWid * 0.52, 0.38, bodyLen * 0.32],
      [bodyWid * 0.52, 0.38, bodyLen * 0.32],
      [-bodyWid * 0.52, 0.38, -bodyLen * 0.32],
      [bodyWid * 0.52, 0.38, -bodyLen * 0.32],
    ];
    for (const p of places) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.rotation.z = Math.PI / 2;
      w.position.set(p[0], p[1], p[2]);
      g.add(w);
    }

    const lightGeo = new THREE.BoxGeometry(0.28, 0.16, 0.08);
    const glow = new THREE.MeshLambertMaterial({ color: 0xf4f1ea, emissive: 0xfff4d0, emissiveIntensity: 0.7 });
    const hl = new THREE.Mesh(lightGeo, glow);
    const hr = new THREE.Mesh(lightGeo, glow);
    hl.position.set(-bodyWid * 0.32, 0.62, bodyLen * 0.5);
    hr.position.set(bodyWid * 0.32, 0.62, bodyLen * 0.5);
    g.add(hl, hr);
    const tail = new THREE.MeshLambertMaterial({ color: 0xff2a2a, emissive: 0xff2a2a, emissiveIntensity: 0.45 });
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.06), tail);
    const tr = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.06), tail);
    tl.position.set(-bodyWid * 0.32, 0.58, -bodyLen * 0.5);
    tr.position.set(bodyWid * 0.32, 0.58, -bodyLen * 0.5);
    g.add(tl, tr);

    if (type === "gt" || type === "box") {
      const spoiler = new THREE.Mesh(new THREE.BoxGeometry(bodyWid * 0.95, 0.1, 0.35), bodyMat);
      spoiler.position.set(0, 1.12, -bodyLen * 0.42);
      g.add(spoiler);
    }

    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 1.8, 6),
      new THREE.MeshBasicMaterial({ color: 0x66e8ff, transparent: true, opacity: 0.0, depthWrite: false }),
    );
    flame.rotation.x = Math.PI;
    flame.position.set(0, 0.45, -bodyLen * 0.62);
    flame.visible = false;
    g.add(flame);
    g.userData.flame = flame;
    g.userData.bodyLen = bodyLen;
    g.frustumCulled = false;
    g.traverse((o) => { o.frustumCulled = false; });
    return g;
  }

  _ensureCars(engine) {
    const n = engine.cars?.length || 0;
    while (this._carPool.length < n) {
      const src = engine.cars[this._carPool.length];
      const mesh = this._carMesh(src.car);
      mesh.visible = false;
      this.scene.add(mesh);
      this._carPool.push({ mesh, carId: src.car.id });
    }
    for (let i = 0; i < this._carPool.length; i++) {
      const slot = this._carPool[i];
      const src = engine.cars[i];
      if (!src) {
        slot.mesh.visible = false;
        continue;
      }
      if (slot.carId !== src.car.id) {
        this.scene.remove(slot.mesh);
        slot.mesh.traverse((o) => {
          if (o.geometry && o.geometry.dispose && o !== slot.mesh) { /* keep shared */ }
        });
        slot.mesh = this._carMesh(src.car);
        this.scene.add(slot.mesh);
        slot.carId = src.car.id;
      }
    }
  }

  _hidePools() {
    for (const kind of PROP_KINDS) {
      const pool = this._propPool[kind];
      if (!pool) continue;
      pool.used = 0;
      for (const it of pool.items) it.visible = false;
    }
    for (const f of this._fuelPool) f.visible = false;
  }

  _placeProp(kind, x, y, z, scale, yaw) {
    const pool = this._propPool[kind];
    if (!pool) return;
    if (pool.used >= pool.items.length) return;
    const m = pool.items[pool.used++];
    m.visible = true;
    m.position.set(x, y, z);
    m.rotation.set(0, yaw || 0, 0);
    const s = 1.15 * (scale || 1);
    m.scale.setScalar(clamp(s, 0.45, 3.4));
  }

  _stationAtZ(relZ) {
    const n = this._nSta;
    if (n < 2) return this._stations[0];
    const z = relZ * XZ;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this._stations[mid].z < z) lo = mid;
      else hi = mid;
    }
    const a = this._stations[lo];
    const b = this._stations[Math.min(n - 1, lo + 1)];
    const span = b.z - a.z || 1;
    const t = clamp((z - a.z) / span, 0, 1);
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      t,
      yaw: Math.atan2(b.x - a.x, b.z - a.z),
      seg: t < 0.5 ? a.seg : b.seg,
    };
  }

  _updateRibbon(engine) {
    const track = engine.track;
    const segs = track.segs;
    const drawN = this.drawN;
    const camZ = engine.camZ;
    const base = engine.findSeg(camZ);
    const t = engine.percent(camZ);
    const camXWorld = engine.camX * ROAD;
    let x = 0;
    let dx = -(t * (base.curve || 0));
    const sta = this._stations;
    let nSta = 0;

    const push = (px, py, pz, seg) => {
      const s = sta[nSta] || (sta[nSta] = { x: 0, y: 0, z: 0, seg: null, n: 0 });
      s.x = px;
      s.y = py;
      s.z = pz;
      s.seg = seg;
      s.n = nSta;
      nSta++;
    };

    let prevP2 = null;
    for (let n = 0; n < drawN; n++) {
      const idx = (base.index + n) % segs.length;
      const seg = segs[idx];
      const looped = (base.index + n) >= segs.length;
      const cz = camZ - (looped ? track.length : 0);
      const x1 = (0 - (camXWorld - x)) * XZ;
      const y1 = seg.p1.y * Y_HILL;
      const z1 = (seg.p1.z - cz) * XZ;
      if (n === 0) push(x1, y1, z1, seg);
      x += dx;
      dx += seg.curve;
      const x2 = (0 - (camXWorld - x)) * XZ;
      const y2 = seg.p2.y * Y_HILL;
      const z2 = (seg.p2.z - cz) * XZ;
      push(x2, y2, z2, seg);
      prevP2 = z2;
    }
    this._nSta = nSta;

    const roadHalf = ROAD_W * 1.04;
    const grassHalf = ROAD_W * 6.4;
    const rp = this._road.pos;
    const ru = this._road.uv;
    const rc = this._road.col;
    const gp = this._grass.pos;
    const gu = this._grass.uv;
    const gc = this._grass.col;
    const g0 = this._g0 || hexColor("#c2a63c");
    const g1 = this._g1 || hexColor("#d6c15a");
    const r0 = this._r0 || hexColor("#5a5a5e");
    const r1 = this._r1 || hexColor("#4c4c51");

    const maxSta = this._road.sta;
    const used = Math.min(nSta, maxSta);
    for (let i = 0; i < used; i++) {
      const s = sta[i];
      const light = s.seg ? s.seg.light : (i % 2 === 0);
      let yaw = 0;
      if (i + 1 < used) yaw = Math.atan2(sta[i + 1].x - s.x, sta[i + 1].z - s.z);
      else if (i > 0) yaw = Math.atan2(s.x - sta[i - 1].x, s.z - sta[i - 1].z);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      const vi = i * 2;
      const yRoad = s.y + 0.045;
      rp[vi * 3] = s.x - rx * roadHalf;
      rp[vi * 3 + 1] = yRoad;
      rp[vi * 3 + 2] = s.z - rz * roadHalf;
      rp[(vi + 1) * 3] = s.x + rx * roadHalf;
      rp[(vi + 1) * 3 + 1] = yRoad;
      rp[(vi + 1) * 3 + 2] = s.z + rz * roadHalf;
      const vv = i * 0.45;
      ru[vi * 2] = 0;
      ru[vi * 2 + 1] = vv;
      ru[(vi + 1) * 2] = 1;
      ru[(vi + 1) * 2 + 1] = vv;

      gp[vi * 3] = s.x - rx * grassHalf;
      gp[vi * 3 + 1] = s.y - 0.04;
      gp[vi * 3 + 2] = s.z - rz * grassHalf;
      gp[(vi + 1) * 3] = s.x + rx * grassHalf;
      gp[(vi + 1) * 3 + 1] = s.y - 0.04;
      gp[(vi + 1) * 3 + 2] = s.z + rz * grassHalf;
      gu[vi * 2] = 0;
      gu[vi * 2 + 1] = vv * 0.2;
      gu[(vi + 1) * 2] = 1;
      gu[(vi + 1) * 2 + 1] = vv * 0.2;

      const grass = light ? g0 : g1;
      const roadC = light ? r0 : r1;
      let tintR = 1, tintG = 1, tintB = 1;
      if (s.seg && s.seg.index < 6) {
        const stripe = s.seg.index % 2 === 0;
        tintR = stripe ? 1.15 : 1.25;
        tintG = stripe ? 1.15 : 0.35;
        tintB = stripe ? 1.15 : 0.32;
      }
      for (const side of [0, 1]) {
        const ci = (vi + side) * 3;
        rc[ci] = roadC.r * tintR;
        rc[ci + 1] = roadC.g * tintG;
        rc[ci + 2] = roadC.b * tintB;
        gc[ci] = grass.r;
        gc[ci + 1] = grass.g;
        gc[ci + 2] = grass.b;
      }
    }
    for (let i = used; i < maxSta; i++) {
      const vi = i * 2;
      for (const side of [0, 1]) {
        const p = (vi + side) * 3;
        rp[p] = rp[p + 2] = 0;
        rp[p + 1] = -20;
        gp[p] = gp[p + 2] = 0;
        gp[p + 1] = -20;
      }
    }
    this._road.geo.attributes.position.needsUpdate = true;
    this._road.geo.attributes.uv.needsUpdate = true;
    this._road.geo.attributes.color.needsUpdate = true;
    this._grass.geo.attributes.position.needsUpdate = true;
    this._grass.geo.attributes.uv.needsUpdate = true;
    this._grass.geo.attributes.color.needsUpdate = true;
    const segsUsed = Math.max(1, used - 1);
    this._road.geo.setDrawRange(0, segsUsed * 6);
    this._grass.geo.setDrawRange(0, segsUsed * 6);
  }

  _placeSide(engine) {
    this._hidePools();
    const night = !!engine.track?.def?.night;
    const spriteUntil = Math.floor(this.drawN * (this.lowFx ? 0.42 : 0.55));
      const budget = this.lowFx ? 28 : 56;
    let used = 0;
    const nSta = this._nSta;
    for (let i = 0; i < nSta && i < spriteUntil && used < budget; i++) {
      const s = this._stations[i];
      const seg = s.seg;
      if (!seg?.sprites?.length) continue;
      if (s.z < 4) continue;
      let yaw = 0;
      if (i + 1 < nSta) yaw = Math.atan2(this._stations[i + 1].x - s.x, this._stations[i + 1].z - s.z);
      for (const spr of seg.sprites) {
        if (used >= budget) break;
        if (this.lowFx && spr.scale > 2.5 && used > 18 && (i & 1)) continue;
        const px = s.x + spr.offset * ROAD_W;
        this._placeProp(spr.kind, px, s.y, s.z, spr.scale * 0.72, yaw);
        used++;
      }
    }
    let fi = 0;
    for (let i = 0; i < nSta && fi < this._fuelPool.length; i++) {
      const s = this._stations[i];
      const pk = s.seg?.pickup;
      if (!pk || pk.taken) continue;
      if (s.z < 2 || s.z > 90) continue;
      const m = this._fuelPool[fi++];
      m.visible = true;
      m.position.set(s.x + pk.x * ROAD_W, s.y + 0.2, s.z);
      m.rotation.y = (engine._frame || 0) * 0.04;
    }
    for (const kind of PROP_KINDS) {
      if (kind !== "lamp") continue;
      const pool = this._propPool.lamp;
      if (!pool || !night) break;
      for (const it of pool.items) {
        if (!it.visible) continue;
        it.traverse((o) => {
          if (o.material && o.material.emissiveIntensity != null && o.geometry?.type === "SphereGeometry") {
            o.material.emissiveIntensity = 1.15;
          }
        });
      }
    }
  }

  _placeCars(engine) {
    this._ensureCars(engine);
    const len = engine.track.length;
    const p = engine.player;
    for (let i = 0; i < this._carPool.length; i++) {
      const slot = this._carPool[i];
      const c = engine.cars[i];
      if (!c || !slot) {
        if (slot) slot.mesh.visible = false;
        continue;
      }
      if (!c.human) {
        if (Math.abs(engine.progress(c) - engine.progress(p)) > len * 0.45) {
          slot.mesh.visible = false;
          continue;
        }
        const dz = wrapDist(c.z, engine.camZ, len);
        if (dz < 80 || dz > this.drawN * SEG * 0.92) {
          slot.mesh.visible = false;
          continue;
        }
      }
      const relZ = c.human ? PLAYER_Z : wrapZ(c.z - engine.camZ, len);
      if (!c.human && relZ > this.drawN * SEG) {
        slot.mesh.visible = false;
        continue;
      }
      const st = this._stationAtZ(c.human ? PLAYER_Z : relZ);
      const lateral = (c.human ? engine.playerX : c.x) * ROAD_W;
      const mesh = slot.mesh;
      mesh.visible = true;
      mesh.position.set(st.x + lateral, st.y + 0.02, st.z);
      const steer = c.human ? clamp(c.steer || 0, -1, 1) : clamp(c.steer || 0, -0.28, 0.28);
      mesh.rotation.set(0, st.yaw + steer * (c.human ? 0.32 : 0.18), steer * (c.human ? 0.12 : 0.06));
      const boost = c.human && engine.mode === "race" && (c.nitroBurst || 0) > 0 && c.fuel > 0
        ? clamp((c.nitroBurst || 0) / Math.max(0.35, NITRO_BURST * (c.spec?.nitroTank || 1)), 0, 1)
        : 0;
      const flame = mesh.userData.flame;
      if (flame) {
        if (boost > 0.05 && !this.reduceMotion) {
          flame.visible = true;
          flame.material.opacity = 0.35 + boost * 0.5;
          flame.scale.set(0.8 + boost, 0.9 + boost * 1.4, 0.8 + boost);
        } else {
          flame.visible = false;
        }
      }
      if (c.human) {
        this.nitroLight.position.copy(mesh.position);
        this.nitroLight.position.y += 0.8;
        this.nitroLight.intensity = boost > 0.05 && !this.lowFx ? 2.4 * boost : 0;
        this._playerPos = mesh.position;
        this._playerYaw = st.yaw;
      }
    }
  }

  _updateDust(engine) {
    if (!this._dust.length) return;
    const off = Math.abs(engine.playerX) > 1.02;
    const ppos = this._playerPos;
    if (!ppos) return;
    if (off && (engine.player?.speed || 0) > 400 && !this.reduceMotion) {
      for (const d of this._dust) {
        if (d.life > 0) continue;
        d.life = 0.28 + Math.random() * 0.3;
        d.mesh.visible = true;
        d.mesh.position.set(
          ppos.x + (Math.random() - 0.5) * 1.4,
          ppos.y + 0.2,
          ppos.z - 1.2 - Math.random() * 2,
        );
        d.mesh.material.opacity = 0.32;
        break;
      }
    }
    const dt = Math.min(0.05, this._fpsEma / 1000);
    for (const d of this._dust) {
      if (d.life <= 0) {
        d.mesh.visible = false;
        continue;
      }
      d.life -= dt;
      d.mesh.position.y += 0.6 * dt;
      d.mesh.position.z -= 4 * dt;
      d.mesh.material.opacity = Math.max(0, d.life);
      if (d.life <= 0) d.mesh.visible = false;
    }
  }

  _updateCamera(engine) {
    const playerSt = this._stationAtZ(PLAYER_Z);
    const kick = engine.fovKick || 0;
    const shake = engine.hitShake || 0;
    let ox = 0;
    let oy = 0;
    if (shake > 0 && !this.reduceMotion) {
      ox = (Math.random() - 0.5) * shake * 0.35;
      oy = (Math.random() - 0.5) * shake * 0.22;
    }
    const eyeY = playerSt.y + EYE_H - kick * 0.55;
    const back = CAM_BACK - kick * 0.8;
    const yaw = playerSt.yaw || 0;
    const bx = Math.sin(yaw) * back;
    const bz = Math.cos(yaw) * back;
    this.camera.position.set(playerSt.x - bx + ox, eyeY + oy, playerSt.z - bz);
    this._look.set(
      playerSt.x + Math.sin(yaw) * LOOK_AHEAD,
      playerSt.y + 0.9,
      playerSt.z + Math.cos(yaw) * LOOK_AHEAD,
    );
    this.camera.lookAt(this._look);
    const baseFov = this._phone ? 78 : 74;
    this.camera.fov = baseFov + kick * 9;
    this.camera.updateProjectionMatrix();

    this.sky.position.copy(this.camera.position);
    const def = engine.track.def;
    const sun = def.sun;
    this.sunMesh.position.set(
      this.camera.position.x + (sun.x - 0.5) * 90,
      this.camera.position.y + 22 + (0.28 - sun.y) * 40,
      this.camera.position.z + 70,
    );
    this.hills.position.set(this.camera.position.x - engine.camX * 8, playerSt.y - 1.2, this.camera.position.z + 92);
    this.hills.rotation.y = yaw * 0.15;

    if (this.flash) {
      const f = engine.hitFlash || 0;
      if (f > 0.04) {
        this.flash.visible = true;
        this.flash.material.opacity = 0.18 * clamp(f, 0, 1);
        this.flash.material.color.set(kick > 0.2 ? 0x46c8ff : 0xffdcd2);
      } else if (kick > 0.08) {
        this.flash.visible = true;
        this.flash.material.opacity = 0.08 * kick;
        this.flash.material.color.set(0x46c8ff);
      } else {
        this.flash.visible = false;
        this.flash.material.opacity = 0;
      }
    }
  }

  _adaptFps(now) {
    if (!this._lastT) {
      this._lastT = now;
      return;
    }
    const dt = now - this._lastT;
    this._lastT = now;
    if (dt > 250) return;
    this._fpsEma = this._fpsEma * 0.9 + dt * 0.1;
    if (this._fpsEma > 33) this._slow = Math.min(80, this._slow + 1);
    else this._slow = Math.max(0, this._slow - 0.6);
    if (this._slow > 36 && !this.lowFx) {
      this.lowFx = true;
      this._dprCap = 1;
      this.renderer.setPixelRatio(1);
      if (this.scene?.fog) this.scene.fog.density *= 1.15;
    }
  }

  draw(engine) {
    if (!this.ok || !this.renderer) return;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    this._adaptFps(now);
    if (!engine.track) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (engine._phone && !this._phone) this._refreshFx(true);
    const def = engine.track.def;
    if (this._trackId !== def.id) {
      this._trackId = def.id;
      this._applyTrackVisuals(def);
    }
    this.drawN = this.lowFx || this._phone
      ? (this._slow > 40 ? 96 : 128)
      : (this._slow > 28 ? 160 : 200);
    this.drawN = Math.min(this.drawN, MAX_DRAW);
    this.camera.far = this.lowFx ? 200 : 320;
    this._updateRibbon(engine);
    this._placeSide(engine);
    this._placeCars(engine);
    this._updateDust(engine);
    this._updateCamera(engine);
    this.renderer.render(this.scene, this.camera);
  }
}

export function tryCreateRenderer3D(canvas, opts = {}) {
  const r = new Renderer3D();
  if (!r.init(canvas, opts)) return null;
  return r;
}

export function showWebglFallbackNote() {
  const note = document.getElementById("webgl-note");
  if (note) note.classList.remove("hidden");
}

export function replaceCanvas(old) {
  const n = document.createElement("canvas");
  n.id = old.id || "view";
  n.tabIndex = old.tabIndex || 0;
  old.parentNode?.replaceChild(n, old);
  return n;
}
