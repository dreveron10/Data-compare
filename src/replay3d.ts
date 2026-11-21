// 3D flight replay: trajectory, rocket attitude (tilt + roll), events, and an attitude inset.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Analysis } from "./analysis";
import { indexAt, lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";
import { sampleAt, type CompareTrace } from "./compare";
import { buildSatelliteGround } from "./satellite";

export type CameraMode = "follow" | "overview" | "ground";

const COLORS = {
  bg: 0x0b0f17,
  ground: 0x111723,
  grid: 0x24304a,
  gridMajor: 0x34436a,
  descent: 0xffa64d,
  shadow: 0x5a6a8a,
};

function buildRocket(): THREE.Group {
  // Unit rocket: length 1 along +Y, origin at the centre of mass (about 55% from the nose).
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8ecf4, metalness: 0.2, roughness: 0.45 });
  const r = 0.045;
  const bodyLen = 0.78;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, bodyLen, 24), bodyMat);
  body.position.y = -0.05;
  g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(r, 0.22, 24), new THREE.MeshStandardMaterial({ color: 0x3c4b6e, metalness: 0.3, roughness: 0.4 }));
  nose.position.y = -0.05 + bodyLen / 2 + 0.11;
  g.add(nose);
  // roll reference stripe along one side of the body
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.012, bodyLen * 0.92, 0.02), new THREE.MeshStandardMaterial({ color: 0xff4d6d }));
  stripe.position.set(0, -0.05, r);
  g.add(stripe);
  // fins: one red (roll reference), three dark
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(0.11, -0.05);
  finShape.lineTo(0.11, -0.13);
  finShape.lineTo(0, -0.16);
  finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.008, bevelEnabled: false });
  finGeo.translate(0, 0, -0.004);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(finGeo, new THREE.MeshStandardMaterial({ color: k === 0 ? 0xff4d6d : 0x2a3550, side: THREE.DoubleSide }));
    const holder = new THREE.Group();
    fin.position.set(r, -0.05 - bodyLen / 2 + 0.16, 0);
    holder.add(fin);
    holder.rotation.y = (k * Math.PI) / 2 - Math.PI / 2; // fin 0 lines up with the stripe
    g.add(holder);
  }
  // motor flame, shown during boost
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(r * 0.9, 0.3, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85 }),
  );
  flame.rotation.x = Math.PI;
  flame.position.y = -0.05 - bodyLen / 2 - 0.15;
  flame.name = "flame";
  g.add(flame);
  return g;
}

function textSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = "600 34px Inter, system-ui, sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  c.width = w; c.height = 52;
  ctx.font = font;
  ctx.fillStyle = "rgba(11,15,23,0.78)";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 52, 12);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 14, 27);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.userData.aspect = w / 52;
  s.renderOrder = 10;
  return s;
}

function speedColor(v: number, vmax: number, out: THREE.Color) {
  // blue -> cyan -> yellow -> red
  const x = Math.min(1, Math.max(0, v / Math.max(1, vmax)));
  out.setHSL(0.62 - 0.62 * x, 0.85, 0.58);
  return out;
}

export class Replay3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private rocket = buildRocket();
  private worldGroup = new THREE.Group();
  private trail?: Line2;
  private trailGeo?: LineGeometry;
  private lineMats: LineMaterial[] = [];
  private labels: THREE.Sprite[] = [];
  private dropLine: THREE.Line;
  private groundRing: THREE.Mesh;
  private chute: THREE.Group;
  private mode: CameraMode = "follow";
  private lastRocketPos = new THREE.Vector3();
  private extent = 5000;

  // inset
  private insetRenderer: THREE.WebGLRenderer;
  private insetScene = new THREE.Scene();
  private insetCam: THREE.PerspectiveCamera;
  private insetRocket = buildRocket();

  private cmpGroup = new THREE.Group();
  private satMesh?: THREE.Mesh;
  private satOn = true;
  private grid?: THREE.GridHelper;
  private loadToken = 0;
  /** called when satellite imagery finishes loading (true) or is unavailable (false) */
  onSatellite?: (loaded: boolean) => void;
  private cmpMarker?: THREE.Mesh;
  private cmp?: CompareTrace;
  private a?: Analysis;
  private f?: BlueRavenFlight;
  private t = 0;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private insetHost: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(COLORS.bg);
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 400000);
    this.camera.position.set(-1500, 900, 1500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.fog = new THREE.Fog(COLORS.bg, 20000, 120000);
    this.scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x1a2030, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-3, 5, 2);
    this.scene.add(sun);
    this.scene.add(this.worldGroup);
    this.scene.add(this.cmpGroup);
    this.scene.add(this.rocket);

    this.dropLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: COLORS.shadow, dashSize: 40, gapSize: 30, transparent: true, opacity: 0.8 }),
    );
    this.scene.add(this.dropLine);
    this.groundRing = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1, 40),
      new THREE.MeshBasicMaterial({ color: 0x8fb4ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
    );
    this.groundRing.rotation.x = -Math.PI / 2;
    this.scene.add(this.groundRing);

    this.chute = new THREE.Group();
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.4),
      new THREE.MeshStandardMaterial({ color: 0xff7a3d, side: THREE.DoubleSide, roughness: 0.8 }),
    );
    canopy.name = "canopy";
    this.chute.add(canopy);
    this.chute.visible = false;
    this.scene.add(this.chute);

    // inset (attitude) view: rocket alone with world axes, camera fixed beside it
    this.insetRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.insetRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    insetHost.appendChild(this.insetRenderer.domElement);
    this.insetCam = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
    this.insetCam.position.set(0, 0.35, 2.6);
    this.insetCam.lookAt(0, 0, 0);
    this.insetScene.add(new THREE.HemisphereLight(0xdde7ff, 0x202838, 1.3));
    const s2 = new THREE.DirectionalLight(0xffffff, 1.4);
    s2.position.set(-2, 3, 3);
    this.insetScene.add(s2);
    this.insetScene.add(this.insetRocket);
    const axis = (dir: THREE.Vector3, color: number) =>
      this.insetScene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0, -0.62, 0), 0.42, color, 0.07, 0.04));
    axis(new THREE.Vector3(0, 1, 0), 0x7bd88f); // up
    axis(new THREE.Vector3(1, 0, 0), 0x5cc8ff); // downrange
    axis(new THREE.Vector3(0, 0, -1), 0xf5c26b); // crossrange
    const ringGeo = new THREE.RingGeometry(0.55, 0.56, 64);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x34436a, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.62;
    this.insetScene.add(ring);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.ro.observe(insetHost);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const m of this.lineMats) m.resolution.set(w, h);
    const iw = this.insetHost.clientWidth, ih = this.insetHost.clientHeight;
    if (iw && ih) {
      this.insetRenderer.setSize(iw, ih, false);
      this.insetCam.aspect = iw / ih;
      this.insetCam.updateProjectionMatrix();
    }
  }

  setFlight(a: Analysis, f: BlueRavenFlight) {
    this.a = a;
    this.f = f;
    // clear previous world
    this.worldGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
    });
    this.worldGroup.clear();
    this.lineMats = [];
    this.labels = [];

    const p = a.path;
    const iA = p.apogeeIdx;
    const iL = lowerBound(p.t, a.events.find((e) => e.key === "liftoff")?.t ?? 0);
    // extent of the scene
    let maxR = 0, maxY = 0;
    for (let i = 0; i < p.t.length; i++) {
      maxR = Math.max(maxR, Math.hypot(p.x[i], p.z[i]));
      maxY = Math.max(maxY, p.y[i]);
    }
    if (a.gps) for (let i = 0; i < a.gps.x.length; i++) maxR = Math.max(maxR, Math.hypot(a.gps.x[i], a.gps.z[i]));
    this.extent = Math.max(3000, maxR * 1.6, maxY * 1.2);

    // ground + grid
    const size = Math.ceil((this.extent * 2.4) / 1000) * 1000;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    this.worldGroup.add(ground);
    const grid = new THREE.GridHelper(size, size / 250, COLORS.gridMajor, COLORS.grid);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.worldGroup.add(grid);
    this.grid = grid;

    // satellite imagery (needs GPS for the pad location); loads in the background
    this.satMesh = undefined;
    const token = ++this.loadToken;
    if (a.gps && f.gps) {
      buildSatelliteGround(f.gps.padLat, f.gps.padLon, size / 2).then((mesh) => {
        if (token !== this.loadToken) { mesh?.geometry.dispose(); return; }
        if (!mesh) { this.onSatellite?.(false); return; }
        this.satMesh = mesh;
        this.worldGroup.add(mesh);
        this.applySatellite();
        this.onSatellite?.(true);
      });
    } else {
      this.onSatellite?.(false);
    }

    // pad
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 4, 24), new THREE.MeshStandardMaterial({ color: 0x7bd88f }));
    pad.position.y = 2;
    this.worldGroup.add(pad);
    const padLabel = textSprite("Pad", "#7bd88f");
    padLabel.position.set(0, 120, 0);
    this.addLabel(padLabel);

    // axis arrows at the pad. Without GPS the Blue Raven has no compass, so directions are
    // downrange/crossrange; with GPS the scene is rotated to true east/north.
    const arrowLen = Math.min(1500, this.extent * 0.25);
    const dr = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 6, 0), arrowLen, 0x5cc8ff, arrowLen * 0.08, arrowLen * 0.04);
    const cr = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 6, 0), arrowLen, 0xf5c26b, arrowLen * 0.08, arrowLen * 0.04);
    this.worldGroup.add(dr, cr);
    const drL = textSprite(a.compass ? "East" : "Downrange", "#5cc8ff");
    drL.position.set(arrowLen * 1.1, 60, 0);
    const crL = textSprite(a.compass ? "North" : `Crossrange${a.frame && a.frame.crSign < 0 ? " (-)" : ""}`, "#f5c26b");
    crL.position.set(0, 60, -arrowLen * 1.1);
    this.addLabel(drL);
    this.addLabel(crL);

    // ascent path, coloured by speed
    const pos: number[] = [], col: number[] = [];
    let vmax = 1;
    for (let i = iL; i <= iA; i++) vmax = Math.max(vmax, a.totalVel[i]);
    const c = new THREE.Color();
    const step = 2; // 25 Hz is plenty for the line
    const pushPt = (i: number, color: THREE.Color) => {
      pos.push(p.x[i], p.y[i], p.z[i]);
      col.push(color.r, color.g, color.b);
    };
    for (let i = Math.max(0, iL - 1); i <= iA; i += step) pushPt(i, speedColor(a.totalVel[i], vmax, c));
    pushPt(iA, speedColor(a.totalVel[iA], vmax, c));
    const ghostGeo = new LineGeometry();
    ghostGeo.setPositions(pos);
    ghostGeo.setColors(col);
    const ghostMat = new LineMaterial({ vertexColors: true, linewidth: 2, transparent: true, opacity: 0.28 });
    this.lineMats.push(ghostMat);
    this.worldGroup.add(new Line2(ghostGeo, ghostMat));

    // trail (drawn up to the current time), full ascent + descent
    const tp: number[] = [], tc: number[] = [];
    const trailT: number[] = [];
    for (let i = Math.max(0, iL - 1); i < p.t.length; i += step) {
      tp.push(p.x[i], p.y[i], p.z[i]);
      if (i <= iA) speedColor(a.totalVel[i], vmax, c); else c.setHex(COLORS.descent);
      tc.push(c.r, c.g, c.b);
      trailT.push(p.t[i]);
    }
    this.trailGeo = new LineGeometry();
    this.trailGeo.setPositions(tp);
    this.trailGeo.setColors(tc);
    this.trailGeo.userData.t = trailT;
    const trailMat = new LineMaterial({ vertexColors: true, linewidth: 4 });
    this.lineMats.push(trailMat);
    this.trail = new Line2(this.trailGeo, trailMat);
    this.trail.frustumCulled = false;
    this.worldGroup.add(this.trail);

    // GPS track (raw GPS position and GPS altitude), for comparison with the fused path
    if (a.gps) {
      const gp: number[] = [];
      for (let i = 0; i < a.gps.x.length; i++) gp.push(a.gps.x[i], a.gps.y[i], a.gps.z[i]);
      const gGeo = new LineGeometry();
      gGeo.setPositions(gp);
      const gMat = new LineMaterial({ color: 0xffffff, linewidth: 1.5, transparent: true, opacity: 0.55, dashed: true, dashSize: 40, gapSize: 30 });
      this.lineMats.push(gMat);
      const gLine = new Line2(gGeo, gMat);
      gLine.computeLineDistances();
      this.worldGroup.add(gLine);
      // landing pin with distance
      const L = a.gps.landing;
      const li = a.gps.x.length - 1;
      const pin = new THREE.Mesh(new THREE.ConeGeometry(18, 60, 16), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      pin.rotation.x = Math.PI;
      pin.position.set(a.gps.x[li], 30, a.gps.z[li]);
      this.worldGroup.add(pin);
      const gl = textSprite(`GPS landing  ${L.distance.toFixed(0)} ft @ ${L.bearing.toFixed(0)}°`, "#ffffff");
      gl.position.set(a.gps.x[li], 140, a.gps.z[li]);
      gl.userData.small = true;
      this.addLabel(gl);
      const gpsApo = a.gps.rows.find((r) => r.label === "Apogee AGL")?.gps;
      let gi = 0;
      for (let i = 0; i < a.gps.y.length; i++) if (a.gps.y[i] > a.gps.y[gi]) gi = i;
      const ga = textSprite(`GPS apogee ${gpsApo?.toFixed(0)} ft`, "#ffffff");
      ga.position.set(a.gps.x[gi], a.gps.y[gi], a.gps.z[gi]);
      ga.userData.small = true;
      ga.userData.offset = true;
      this.addLabel(ga);
    }

    // descent: without GPS the horizontal position is unknown, so it is drawn straight down from apogee
    const apo = new THREE.Vector3(p.x[iA], p.y[iA], p.z[iA]);
    if (!a.gps) {
    const descGeo = new THREE.BufferGeometry().setFromPoints([apo, new THREE.Vector3(apo.x, 0, apo.z)]);
    const descLine = new THREE.Line(descGeo, new THREE.LineDashedMaterial({ color: COLORS.descent, dashSize: 60, gapSize: 50, transparent: true, opacity: 0.5 }));
    descLine.computeLineDistances();
    this.worldGroup.add(descLine);
    const noGps = textSprite("Descent: altitude only (no GPS)", "#ffa64d");
    noGps.position.set(apo.x, apo.y * 0.45, apo.z);
    noGps.userData.small = true;
    this.addLabel(noGps);
    }

    // event markers (events within 0.05 s share one marker, e.g. "Main + 4th fired")
    const groups: { t: number; color: string; fires: string[]; others: string[] }[] = [];
    for (const e of a.events) {
      if (e.key === "liftoff" || e.key === "apogee_det") continue;
      let g = groups.find((x) => Math.abs(x.t - e.t) < 0.05);
      if (!g) { g = { t: e.t, color: e.color, fires: [], others: [] }; groups.push(g); }
      if (e.key.startsWith("fire_")) g.fires.push(e.label.replace(" fired", ""));
      else g.others.push(e.label);
    }
    const markers = groups.map((g) => ({
      t: g.t, color: g.color,
      label: [...g.others, ...(g.fires.length ? [`${g.fires.join(" + ")} fired`] : [])].join(" · "),
    }));
    for (const e of markers) {
      const i = indexAt(p.t, e.t);
      const at = new THREE.Vector3(p.x[i], p.y[i], p.z[i]);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: e.color }));
      dot.position.copy(at);
      dot.userData.marker = true;
      this.worldGroup.add(dot);
      const label = textSprite(`${e.label}  T+${e.t.toFixed(1)}s`, e.color);
      label.position.copy(at);
      label.userData.offset = true;
      this.addLabel(label);
    }

    this.resize();
    this.setCameraMode(this.mode, true);
    this.setTime(a.tStart);
  }

  private addLabel(s: THREE.Sprite) {
    this.labels.push(s);
    this.worldGroup.add(s);
  }

  setSatellite(on: boolean) {
    this.satOn = on;
    this.applySatellite();
  }

  private applySatellite() {
    const show = !!this.satMesh && this.satOn;
    if (this.satMesh) this.satMesh.visible = show;
    if (this.grid) (this.grid.material as THREE.Material).opacity = show ? 0.18 : 0.55;
  }

  /** Draw a comparison path (sim or another flight) with a marker that moves in sync. */
  setCompare(cmp?: CompareTrace) {
    this.cmpGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
    this.cmpGroup.clear();
    this.lineMats = this.lineMats.filter((m) => !m.userData.cmp);
    this.labels = this.labels.filter((l) => !l.userData.cmp);
    this.cmp = cmp;
    this.cmpMarker = undefined;
    if (!cmp?.path || !this.a) return;
    const p = cmp.path;
    const pos: number[] = [];
    const step = Math.max(1, Math.floor(p.t.length / 3000));
    for (let i = 0; i < p.t.length; i += step) pos.push(p.x[i], p.y[i], p.z[i]);
    const geo = new LineGeometry();
    geo.setPositions(pos);
    const mat = new LineMaterial({ color: 0xff9de2, linewidth: 2.5, transparent: true, opacity: 0.85, dashed: true, dashSize: 60, gapSize: 35 });
    mat.userData.cmp = true;
    mat.resolution.set(this.host.clientWidth, this.host.clientHeight);
    this.lineMats.push(mat);
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    this.cmpGroup.add(line);
    let iA = 0;
    for (let i = 0; i < p.y.length; i++) if (p.y[i] > p.y[iA]) iA = i;
    const sameFrame = cmp.compass === this.a.compass;
    const label = textSprite(`${cmp.kind === "sim" ? "Sim" : cmp.name} apogee ${p.y[iA].toFixed(0)} ft${sameFrame ? "" : " (heading not aligned)"}`, "#ff9de2");
    label.position.set(p.x[iA], p.y[iA], p.z[iA]);
    label.userData.small = true;
    label.userData.offset = true;
    label.userData.cmp = true;
    this.labels.push(label);
    this.cmpGroup.add(label);
    this.cmpMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff9de2 }));
    this.cmpGroup.add(this.cmpMarker);
    this.setTime(this.t);
  }

  setCameraMode(mode: CameraMode, reset = false) {
    this.mode = mode;
    if (!this.a) return;
    const p = this.a.path;
    const iA = p.apogeeIdx;
    if (mode === "overview" || reset) {
      const cx = p.x[iA] * 0.5, cz = p.z[iA] * 0.5, cy = p.y[iA] * 0.45;
      this.controls.target.set(cx, cy, cz);
      const d = this.extent * 1.25;
      // look from the side of the trajectory, perpendicular to its ground track
      const track = new THREE.Vector3(p.x[iA], 0, p.z[iA]);
      const side = track.lengthSq() > 1 ? new THREE.Vector3(-track.z, 0, track.x).normalize() : new THREE.Vector3(0, 0, 1);
      this.camera.position.set(cx + side.x * d, cy + d * 0.35, cz + side.z * d);
    }
    if (mode === "follow") {
      const rp = this.rocket.position;
      this.controls.target.copy(rp);
      this.camera.position.copy(rp).add(new THREE.Vector3(-260, 120, 260));
    }
    if (mode === "ground") {
      const d = Math.max(800, this.extent * 0.3);
      this.camera.position.set(-d * 0.7, 6, d * 0.7);
      this.controls.target.copy(this.rocket.position);
    }
    this.lastRocketPos.copy(this.rocket.position);
    this.controls.update();
  }

  /** world position on the path at time t */
  private pathPos(t: number, out: THREE.Vector3) {
    const p = this.a!.path;
    const i = indexAt(p.t, t);
    const j = Math.min(p.t.length - 1, i + 1);
    const span = p.t[j] - p.t[i];
    const u = span > 0 ? Math.min(1, Math.max(0, (t - p.t[i]) / span)) : 0;
    out.set(
      p.x[i] + (p.x[j] - p.x[i]) * u,
      p.y[i] + (p.y[j] - p.y[i]) * u,
      p.z[i] + (p.z[j] - p.z[i]) * u,
    );
    return out;
  }

  private quatAt(t: number, out: THREE.Quaternion) {
    const fr = this.a?.frame;
    const hr = this.f?.hr;
    if (!fr || !hr) return out.identity();
    const i = indexAt(hr.t, t);
    const j = Math.min(hr.n - 1, i + 1);
    const span = hr.t[j] - hr.t[i];
    const u = span > 0 ? Math.min(1, Math.max(0, (t - hr.t[i]) / span)) : 0;
    const q = fr.worldQuat;
    const qa = new THREE.Quaternion(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]);
    const qb = new THREE.Quaternion(q[j * 4], q[j * 4 + 1], q[j * 4 + 2], q[j * 4 + 3]);
    return out.slerpQuaternions(qa, qb, u);
  }

  setTime(t: number) {
    this.t = t;
    if (!this.a) return;
    const pos = this.pathPos(t, new THREE.Vector3());
    this.rocket.position.copy(pos);
    const q = this.quatAt(t, new THREE.Quaternion());
    this.rocket.quaternion.copy(q);
    this.insetRocket.quaternion.copy(q);

    const ev = (k: string) => this.a!.events.find((e) => e.key === k)?.t;
    const liftoff = ev("liftoff") ?? 0;
    const burnout = ev("burnout") ?? liftoff + 2;
    const burning = t >= liftoff && t <= burnout;
    (this.rocket.getObjectByName("flame") as THREE.Object3D).visible = burning;
    (this.insetRocket.getObjectByName("flame") as THREE.Object3D).visible = burning;

    // parachute: drogue after Apo fire, main after Main fire
    const tApoFire = ev("fire_Apo");
    const tMainFire = ev("fire_Main");
    const tLand = ev("landing") ?? Infinity;
    this.chute.visible = tApoFire !== undefined && t >= tApoFire && t < tLand;
    this.chute.userData.size = tMainFire !== undefined && t >= tMainFire ? 1 : 0.4;

    // trail
    if (this.trailGeo) {
      const tt = this.trailGeo.userData.t as number[];
      const k = Math.max(0, lowerBound(tt, t) - 1);
      this.trailGeo.instanceCount = Math.max(0, k);
    }

    // drop line + ground ring
    const g = this.dropLine.geometry as THREE.BufferGeometry;
    const arr = g.attributes.position.array as Float32Array;
    arr.set([pos.x, pos.y, pos.z, pos.x, 0, pos.z]);
    g.attributes.position.needsUpdate = true;
    this.dropLine.computeLineDistances();
    this.groundRing.position.set(pos.x, 1, pos.z);

    if (this.cmpMarker && this.cmp?.path) {
      const lift = this.a.events.find((e) => e.key === "liftoff")?.t ?? 0;
      const p = this.cmp.path;
      const tc = Math.min(p.t[p.t.length - 1], Math.max(p.t[0], t - lift));
      this.cmpMarker.position.set(sampleAt(p.t, p.x, tc), sampleAt(p.t, p.y, tc), sampleAt(p.t, p.z, tc));
    }
  }

  private frame() {
    if (this.a) {
      // follow mode: carry the camera along with the rocket so orbiting still works
      if (this.mode === "follow") {
        const d = new THREE.Vector3().subVectors(this.rocket.position, this.lastRocketPos);
        this.camera.position.add(d);
        this.controls.target.add(d);
      } else if (this.mode === "ground") {
        this.controls.target.copy(this.rocket.position);
      }
      this.lastRocketPos.copy(this.rocket.position);

      // keep the rocket and markers a readable size at any zoom
      const camDist = this.camera.position.distanceTo(this.rocket.position);
      const len = Math.max(9, camDist * 0.07);
      this.rocket.scale.setScalar(len);
      if (this.chute.visible) {
        const s = len * (this.chute.userData.size as number) * 0.5;
        this.chute.scale.setScalar(s);
        this.chute.position.copy(this.rocket.position).add(new THREE.Vector3(0, len * 0.9 + s, 0));
      }
      this.groundRing.scale.setScalar(Math.max(15, camDist * 0.02));
      if (this.cmpMarker) this.cmpMarker.scale.setScalar(Math.max(5, this.camera.position.distanceTo(this.cmpMarker.position) * 0.008));
      for (const o of this.worldGroup.children) {
        if (o.userData.marker) o.scale.setScalar(Math.max(6, this.camera.position.distanceTo(o.position) * 0.006));
      }
      for (const s of this.labels) {
        const dist = this.camera.position.distanceTo(s.position);
        const h = dist * (s.userData.small ? 0.022 : 0.028);
        s.scale.set(h * (s.userData.aspect as number), h, 1);
        s.center.set(s.userData.offset ? -0.08 : 0.5, s.userData.offset ? 0.5 : 0);
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.insetRenderer.render(this.insetScene, this.insetCam);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.renderer.dispose();
    this.insetRenderer.dispose();
  }
}
