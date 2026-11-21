// "Google Earth"-style ground: Esri World Imagery draped on real elevation (AWS Terrain Tiles,
// Terrarium encoding), in nested level-of-detail rings around the flight so it is sharp near the
// field and reaches the horizon. World frame: x = east, y = up, z = -north, feet, origin at the pad.

import * as THREE from "three";

const IMAGERY = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const TERRAIN = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export { EARTH_ATTRIBUTION } from "./earthAttrib";

const FT_PER_M = 3.28084;
const EARTH_R_FT = 6371008.8 * FT_PER_M;
const TERRAIN_MAX_Z = 15;
const SEG = 24; // grid segments per tile edge

// ---- tile math (Web Mercator) ----
const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const y2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

interface DemTile { z: number; x: number; y: number; h: Float32Array } // metres, 256 x 256

export class EarthTerrain {
  readonly group = new THREE.Group();
  private dem = new Map<string, Promise<DemTile | null>>();
  private cosLat: number;
  private padElevM = 0;
  private disposed = false;
  loaded = 0;
  total = 0;

  constructor(private padLat: number, private padLon: number) {
    this.cosLat = Math.cos((padLat * Math.PI) / 180);
    this.group.name = "earth";
  }

  /** local feet (east, north) of a lat/lon, using the same flat-earth model as the GPS track */
  private toLocal(lat: number, lon: number): [number, number] {
    return [
      ((lon - this.padLon) * Math.PI / 180) * EARTH_R_FT * this.cosLat,
      ((lat - this.padLat) * Math.PI / 180) * EARTH_R_FT,
    ];
  }
  private toLatLon(e: number, n: number): [number, number] {
    return [this.padLat + (n / EARTH_R_FT) * (180 / Math.PI), this.padLon + (e / (EARTH_R_FT * this.cosLat)) * (180 / Math.PI)];
  }

  private demTile(z: number, x: number, y: number): Promise<DemTile | null> {
    const key = `${z}/${x}/${y}`;
    let p = this.dem.get(key);
    if (!p) {
      p = loadImage(TERRAIN(z, x, y)).then((img) => {
        if (!img) return null;
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, 256, 256).data;
        const h = new Float32Array(256 * 256);
        for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        return { z, x, y, h };
      });
      this.dem.set(key, p);
    }
    return p;
  }

  /** elevation in metres at lat/lon, bilinear, from the DEM tile at zoom zt */
  private async elevation(lat: number, lon: number, zt: number): Promise<number | null> {
    const fx = lon2x(lon, zt), fy = lat2y(lat, zt);
    const t = await this.demTile(zt, Math.floor(fx), Math.floor(fy));
    return t ? sampleDem(t, fx, fy) : null;
  }

  /**
   * Build the rings. center: local feet of the middle of the flight; finest zoom covers about 6 tiles across.
   * Tiles appear as they load, coarse to fine.
   */
  async build(centerE: number, centerN: number, finest = 16, coarsest = 11, onProgress?: (done: number, total: number) => void) {
    this.padElevM = (await this.elevation(this.padLat, this.padLon, TERRAIN_MAX_Z)) ?? 0;
    const [cLat, cLon] = this.toLatLon(centerE, centerN);

    // nested regions: each level is a 6x6 block whose middle 3x3 is replaced by the next finer level
    type Level = { z: number; x0: number; y0: number; hole?: [number, number] };
    const levels: Level[] = [];
    let x0 = Math.floor(lon2x(cLon, coarsest)) - 3;
    let y0 = Math.floor(lat2y(cLat, coarsest)) - 3;
    for (let z = coarsest; z <= finest; z++) {
      const lvl: Level = { z, x0, y0 };
      if (z < finest) {
        const fx = lon2x(cLon, z), fy = lat2y(cLat, z);
        const sx = Math.min(x0 + 3, Math.max(x0, Math.floor(fx) - 1));
        const sy = Math.min(y0 + 3, Math.max(y0, Math.floor(fy) - 1));
        lvl.hole = [sx, sy];
        x0 = sx * 2; y0 = sy * 2;
      }
      levels.push(lvl);
    }
    const jobs: { z: number; x: number; y: number; fine: boolean }[] = [];
    for (const l of levels) {
      for (let y = l.y0; y < l.y0 + 6; y++) {
        for (let x = l.x0; x < l.x0 + 6; x++) {
          if (l.hole && x >= l.hole[0] && x < l.hole[0] + 3 && y >= l.hole[1] && y < l.hole[1] + 3) continue;
          jobs.push({ z: l.z, x, y, fine: l.z === finest });
        }
      }
    }
    this.total = jobs.length;
    // a few at a time so the browser stays responsive
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !this.disposed) {
        const j = jobs[next++];
        const mesh = await this.buildTile(j.z, j.x, j.y, j.fine);
        if (this.disposed) { mesh?.geometry.dispose(); return; }
        if (mesh) this.group.add(mesh);
        this.loaded++;
        onProgress?.(this.loaded, this.total);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  private async buildTile(z: number, x: number, y: number, fine: boolean): Promise<THREE.Mesh | null> {
    // imagery: finest level gets 4 sub-tiles (512 px) for extra sharpness near the field
    let tex: THREE.Texture | null = null;
    if (fine) {
      const c = document.createElement("canvas");
      c.width = c.height = 512;
      const ctx = c.getContext("2d")!;
      const subs = await Promise.all([0, 1, 2, 3].map((k) => loadImage(IMAGERY(z + 1, x * 2 + (k & 1), y * 2 + (k >> 1)))));
      if (subs.every((s) => !s)) return null;
      subs.forEach((img, k) => img && ctx.drawImage(img, (k & 1) * 256, (k >> 1) * 256));
      tex = new THREE.CanvasTexture(c);
    } else {
      const img = await loadImage(IMAGERY(z, x, y));
      if (!img) return null;
      tex = new THREE.Texture(img);
      tex.needsUpdate = true;
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

    // elevation for this tile from the matching (or parent) DEM tile
    const zt = Math.min(z, TERRAIN_MAX_Z);
    const scale = 2 ** (z - zt);
    const dem = await this.demTile(zt, Math.floor(x / scale), Math.floor(y / scale));

    const n = SEG + 1;
    const vCount = n * n + 4 * n; // grid + skirt
    const pos = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const edgeDrop = 30 * FT_PER_M * Math.max(1, 2 ** (14 - z)); // skirt depth grows with tile size
    let k = 0;
    const put = (u: number, v: number, drop: number) => {
      const tx = x + u, ty = y + v;
      const lon = x2lon(tx, z), lat = y2lat(ty, z);
      const [e, nn] = this.toLocal(lat, lon);
      let hM = this.padElevM;
      if (dem) hM = sampleDem(dem, tx / scale, ty / scale);
      const curv = (e * e + nn * nn) / (2 * EARTH_R_FT);
      pos[k * 3] = e;
      pos[k * 3 + 1] = (hM - this.padElevM) * FT_PER_M - curv - drop;
      pos[k * 3 + 2] = -nn;
      uv[k * 2] = u;
      uv[k * 2 + 1] = 1 - v;
      k++;
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(i / SEG, j / SEG, 0);
    // skirts: one lowered copy of each edge (top, bottom, left, right)
    const skirtStart = k;
    for (let i = 0; i < n; i++) put(i / SEG, 0, edgeDrop);
    for (let i = 0; i < n; i++) put(i / SEG, 1, edgeDrop);
    for (let j = 0; j < n; j++) put(0, j / SEG, edgeDrop);
    for (let j = 0; j < n; j++) put(1, j / SEG, edgeDrop);

    const idx: number[] = [];
    const g = (i: number, j: number) => j * n + i;
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = g(i, j), b = g(i + 1, j), c = g(i, j + 1), d = g(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
    const skirt = (edge: (s: number) => number, base: number) => {
      for (let s = 0; s < SEG; s++) {
        const a = edge(s), b = edge(s + 1), c = base + s, d = base + s + 1;
        idx.push(a, c, b, b, c, d, a, b, c, b, d, c); // both windings so it shows from either side
      }
    };
    skirt((s) => g(s, 0), skirtStart);
    skirt((s) => g(s, SEG), skirtStart + n);
    skirt((s) => g(0, s), skirtStart + 2 * n);
    skirt((s) => g(SEG, s), skirtStart + 3 * n);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
    mesh.userData.z = z;
    return mesh;
  }

  dispose() {
    this.disposed = true;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
    });
    this.group.clear();
  }
}

function sampleDem(t: DemTile, fx: number, fy: number): number {
  // fx, fy are fractional tile coordinates at the DEM's zoom
  const px = Math.min(255, Math.max(0, (fx - t.x) * 256 - 0.5));
  const py = Math.min(255, Math.max(0, (fy - t.y) * 256 - 0.5));
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
  const u = px - x0, v = py - y0;
  const h = (x: number, y: number) => t.h[y * 256 + x];
  return (h(x0, y0) * (1 - u) + h(x1, y0) * u) * (1 - v) + (h(x0, y1) * (1 - u) + h(x1, y1) * u) * v;
}
