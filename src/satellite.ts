// Satellite imagery under the 3D scene, built from Esri World Imagery tiles around the GPS pad.

import * as THREE from "three";

const TILE_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const SAT_ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community";

const FT_PER_M = 3.28084;
const EARTH_R_FT = 6371008.8 * FT_PER_M;

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const y2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
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

/**
 * Build a textured ground plane centred on the pad covering +-halfFt feet.
 * World frame: x = east, z = -north (feet). Returns null if no tiles could be loaded.
 */
export async function buildSatelliteGround(padLat: number, padLon: number, halfFt: number): Promise<THREE.Mesh | null> {
  const cosLat = Math.cos((padLat * Math.PI) / 180);
  const dLat = (halfFt / EARTH_R_FT) * (180 / Math.PI);
  const dLon = dLat / cosLat;
  // largest zoom that keeps the mosaic at most 8 x 8 tiles
  let z = 18;
  for (; z > 10; z--) {
    const nx = Math.floor(lon2x(padLon + dLon, z)) - Math.floor(lon2x(padLon - dLon, z)) + 1;
    const ny = Math.floor(lat2y(padLat - dLat, z)) - Math.floor(lat2y(padLat + dLat, z)) + 1;
    if (nx <= 8 && ny <= 8) break;
  }
  const x0 = Math.floor(lon2x(padLon - dLon, z)), x1 = Math.floor(lon2x(padLon + dLon, z));
  const y0 = Math.floor(lat2y(padLat + dLat, z)), y1 = Math.floor(lat2y(padLat - dLat, z));
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;

  const canvas = document.createElement("canvas");
  canvas.width = nx * 256;
  canvas.height = ny * 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#111723";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const jobs: Promise<boolean>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push(loadImage(TILE_URL(z, tx, ty)).then((img) => {
        if (!img) return false;
        ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256);
        return true;
      }));
    }
  }
  const ok = (await Promise.all(jobs)).filter(Boolean).length;
  if (ok === 0) return null;

  // mosaic corners in local feet
  const west = x2lon(x0, z), east = x2lon(x1 + 1, z);
  const north = y2lat(y0, z), south = y2lat(y1 + 1, z);
  const toE = (lon: number) => ((lon - padLon) * Math.PI / 180) * EARTH_R_FT * cosLat;
  const toN = (lat: number) => ((lat - padLat) * Math.PI / 180) * EARTH_R_FT;
  const eW = toE(west), eE = toE(east), nS = toN(south), nN = toN(north);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(eE - eW, nN - nS),
    new THREE.MeshBasicMaterial({ map: tex, color: 0xb8bcc8 }),
  );
  mesh.rotation.x = -Math.PI / 2; // plane +Y -> world -Z (north)
  mesh.position.set((eE + eW) / 2, -0.5, -(nN + nS) / 2);
  mesh.name = "satellite";
  return mesh;
}
