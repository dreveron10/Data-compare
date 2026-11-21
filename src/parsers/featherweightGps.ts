// Featherweight GPS tracker exports (Featherweight UI app):
//   <name>_<date>.csv          flight log: UTCTIME, UNIXTIME, ALT, LAT, LON, #SATS, FIX, HORZV, VERTV, ...
//   <name>_summary_<date>.csv  key,value summary (max altitude, pad position, distances)

export interface GpsData {
  name: string;
  n: number;
  t: Float64Array; // s relative to the tracker's own launch detection
  unix: Float64Array; // UNIX time, s
  altAsl: Float32Array; // ft
  altAgl: Float32Array; // ft
  lat: Float64Array;
  lon: Float64Array;
  east: Float32Array; // ft from pad
  north: Float32Array; // ft from pad
  sats: Uint8Array;
  fix: Uint8Array;
  horzV: Float32Array; // ft/s
  vertV: Float32Array; // ft/s
  heading: Float32Array; // deg
  rssi: Float32Array;
  battV: Float32Array;
  distance: Float32Array; // ft from pad
  launchUnix: number;
  apogeeT: number | null;
  landingT: number | null;
  padLat: number;
  padLon: number;
  padAsl: number;
  summary?: Record<string, string>;
}

export function isGpsLog(text: string): boolean {
  const header = text.slice(0, 400).split(/\r?\n/, 1)[0];
  return header.includes("UNIXTIME") && header.includes("LAT") && header.includes("LON");
}

export function isGpsSummary(text: string): boolean {
  const head = text.slice(0, 600);
  return head.startsWith("Rocket Name,") && head.includes("Pad Latitude");
}

export function parseGpsSummary(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(",");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const FT_PER_M = 3.28084;
const EARTH_R_FT = 6371008.8 * FT_PER_M;

export function parseGpsLog(text: string, name = "GPS tracker"): GpsData {
  const ls = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const h = ls[0].split(",").map((s) => s.trim());
  const col = (n: string, req = true) => {
    const i = h.indexOf(n);
    if (i < 0 && req) throw new Error(`GPS file is missing column ${n}`);
    return i;
  };
  const I = {
    unix: col("UNIXTIME"), alt: col("ALT"), lat: col("LAT"), lon: col("LON"),
    sats: col("#SATS", false), fix: col("FIX", false), hv: col("HORZV", false), vv: col("VERTV", false),
    head: col("HEAD", false), rssi: col("RSSI", false), batt: col("BATT", false),
    agl: col("Altitude AGL", false), launch: col("Launch detection", false),
    apo: col("Apogee detection", false), land: col("Landing detection", false), dist: col("Distance (feet)", false),
  };
  const rows = ls.slice(1).map((l) => l.split(",")).filter((f) => Number.isFinite(parseFloat(f[I.unix])) && Number.isFinite(parseFloat(f[I.lat])));
  const n = rows.length;
  if (n < 5) throw new Error("GPS file has too few valid rows");
  const num = (f: string[], i: number) => (i >= 0 ? parseFloat(f[i]) : NaN);
  const flag = (f: string[], i: number) => i >= 0 && /^(true|1)$/i.test(f[i]?.trim() ?? "");

  const unix = new Float64Array(n), altAsl = new Float32Array(n), altAgl = new Float32Array(n);
  const lat = new Float64Array(n), lon = new Float64Array(n);
  const sats = new Uint8Array(n), fix = new Uint8Array(n);
  const horzV = new Float32Array(n), vertV = new Float32Array(n), heading = new Float32Array(n);
  const rssi = new Float32Array(n), battV = new Float32Array(n), distance = new Float32Array(n);
  let launchIdx = -1, apoIdx = -1, landIdx = -1;
  rows.forEach((f, i) => {
    unix[i] = num(f, I.unix); altAsl[i] = num(f, I.alt);
    lat[i] = num(f, I.lat); lon[i] = num(f, I.lon);
    sats[i] = num(f, I.sats) || 0; fix[i] = num(f, I.fix) || 0;
    horzV[i] = num(f, I.hv); vertV[i] = num(f, I.vv); heading[i] = num(f, I.head);
    rssi[i] = num(f, I.rssi); battV[i] = num(f, I.batt); distance[i] = num(f, I.dist);
    altAgl[i] = num(f, I.agl);
    if (launchIdx < 0 && flag(f, I.launch)) launchIdx = i;
    if (apoIdx < 0 && flag(f, I.apo)) apoIdx = i;
    if (landIdx < 0 && flag(f, I.land)) landIdx = i;
  });

  // pad: average of the samples before launch (or the first few samples)
  const padEnd = launchIdx > 0 ? launchIdx : Math.min(n, 10);
  let pLat = 0, pLon = 0, pAlt = 0;
  for (let i = 0; i < padEnd; i++) { pLat += lat[i]; pLon += lon[i]; pAlt += altAsl[i]; }
  pLat /= padEnd; pLon /= padEnd; pAlt /= padEnd;
  if (I.agl < 0) for (let i = 0; i < n; i++) altAgl[i] = altAsl[i] - pAlt;

  // local east/north in feet (flat earth is fine over a few miles)
  const east = new Float32Array(n), north = new Float32Array(n);
  const cosLat = Math.cos((pLat * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    east[i] = ((lon[i] - pLon) * Math.PI / 180) * EARTH_R_FT * cosLat;
    north[i] = ((lat[i] - pLat) * Math.PI / 180) * EARTH_R_FT;
    if (!Number.isFinite(distance[i])) distance[i] = Math.hypot(east[i], north[i]);
  }

  const launchUnix = launchIdx >= 0 ? unix[launchIdx] : unix[0];
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = unix[i] - launchUnix;

  return {
    name, n, t, unix, altAsl, altAgl, lat, lon, east, north, sats, fix, horzV, vertV, heading, rssi, battV, distance,
    launchUnix,
    apogeeT: apoIdx >= 0 ? t[apoIdx] : null,
    landingT: landIdx >= 0 ? t[landIdx] : null,
    padLat: pLat, padLon: pLon, padAsl: pAlt,
  };
}
