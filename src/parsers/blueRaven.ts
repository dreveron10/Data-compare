// Featherweight Blue Raven export parsers.
// Handles the four files the Featherweight app exports per flight:
//   *_HR_*.csv        high rate (500 Hz): gyro, accel, quaternion, aux volts, current
//   *_LR_*.csv        low rate (50 Hz): baro, temps, volts, inertial nav, angles, flags
//   *_summary_*.csv   key,value flight summary
//   BR_deploy_settings_*.xlsx  deployment condition matrix and thresholds

import { unzipSync, strFromU8 } from "fflate";
import { isGpsLog, isGpsSummary, parseGpsLog, parseGpsSummary, type GpsData } from "./featherweightGps";

export interface HRData {
  n: number;
  t: Float64Array; // flight time, s (0 = liftoff)
  gyro: Float32Array; // deg/s, xyz interleaved
  accel: Float32Array; // g, xyz interleaved
  quat: Float32Array; // w,x,y,z interleaved
  auxVolts: Float32Array;
  current: Float32Array;
}

export const CHANNELS = ["Apo", "Main", "3rd", "4th"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CONDITION_FLAGS = [
  "LT_AGL1", "GT_AGL2", "LT_FANG1", "GT_FANG2", "GT_FUTANG", "LT_TVAL1",
  "GT_TVAL2", "LT_VEL1", "GT_VEL2", "LT_BVEL1", "GT_BURN", "Armed",
] as const;

export interface LRData {
  n: number;
  t: Float64Array;
  clock: string[]; // logger clock time of day
  date: string; // Y-M-D from the logger clock
  tempF: Float32Array;
  pressAtm: Float32Array;
  baroAsl: Float32Array;
  baroAgl: Float32Array;
  battV: Float32Array;
  chanV: Record<Channel, Float32Array>;
  velUp: Float32Array;
  velDR: Float32Array;
  velCR: Float32Array;
  inAlt: Float32Array;
  inDR: Float32Array;
  inCR: Float32Array;
  tilt: Float32Array;
  futureAngle: Float32Array;
  rollAngle: Float32Array; // cumulative, deg
  flags: Record<string, Uint8Array>; // flight state flags
  conditions: Record<Channel, Record<string, Uint8Array>>; // per-channel condition flags
}

export interface Summary {
  raw: Record<string, string>;
  num: Record<string, number>;
  vec: Record<string, [number, number, number]>;
}

export interface DeploySettings {
  // condition name -> channel -> enabled
  conditions: { name: string; enabled: Record<Channel, boolean> }[];
  options: Record<string, Record<Channel, string>>;
  values: Record<string, Record<Channel, number>>;
}

export interface BlueRavenFlight {
  name: string;
  hr?: HRData;
  lr?: LRData;
  summary?: Summary;
  settings?: DeploySettings;
  /** optional Featherweight GPS tracker log from the same flight */
  gps?: GpsData;
}

export type BRFileKind = "hr" | "lr" | "summary" | "settings" | "unknown";

/** Decide which Blue Raven file this is from its header, not its name. */
export function identifyText(text: string): BRFileKind {
  const first = text.slice(0, 600);
  if (first.startsWith("Rocket Name,")) return "summary";
  const header = first.split(/\r?\n/, 1)[0];
  if (header.includes("Gyro_X") && header.includes("Quat_1")) return "hr";
  if (header.includes("Baro_Press") && header.includes("Flight_Time")) return "lr";
  return "unknown";
}

function lines(text: string): string[] {
  const out = text.split(/\r?\n/);
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

export function parseHR(text: string): HRData {
  const ls = lines(text);
  const h = ls[0].split(",");
  const col = (name: string) => {
    const i = h.indexOf(name);
    if (i < 0) throw new Error(`HR file is missing column ${name}`);
    return i;
  };
  const iT = col("Flight_Time_(s)");
  const iG = [col("Gyro_X"), col("Gyro_Y"), col("Gyro_Z")];
  const iA = [col("Accel_X"), col("Accel_Y"), col("Accel_Z")];
  const iQ = [col("Quat_1"), col("Quat_2"), col("Quat_3"), col("Quat_4")];
  const iAux = h.indexOf("Aux_Volts");
  const iCur = h.indexOf("Current");

  const cap = ls.length - 1;
  const t = new Float64Array(cap);
  const gyro = new Float32Array(cap * 3);
  const accel = new Float32Array(cap * 3);
  const quat = new Float32Array(cap * 4);
  const aux = new Float32Array(cap);
  const cur = new Float32Array(cap);
  let n = 0;
  for (let r = 1; r < ls.length; r++) {
    const f = ls[r].split(",");
    const tt = parseFloat(f[iT]);
    const qw = parseFloat(f[iQ[0]]);
    if (!Number.isFinite(tt) || !Number.isFinite(qw)) continue;
    t[n] = tt;
    for (let k = 0; k < 3; k++) {
      gyro[n * 3 + k] = parseFloat(f[iG[k]]);
      accel[n * 3 + k] = parseFloat(f[iA[k]]);
    }
    for (let k = 0; k < 4; k++) quat[n * 4 + k] = parseFloat(f[iQ[k]]);
    aux[n] = iAux >= 0 ? parseFloat(f[iAux]) : NaN;
    cur[n] = iCur >= 0 ? parseFloat(f[iCur]) : NaN;
    n++;
  }
  return {
    n,
    t: t.subarray(0, n),
    gyro: gyro.subarray(0, n * 3),
    accel: accel.subarray(0, n * 3),
    quat: quat.subarray(0, n * 4),
    auxVolts: aux.subarray(0, n),
    current: cur.subarray(0, n),
  };
}

const LR_FLAGS = [
  "Liftoff", "Apogee", "Press_Increasing", "Burnout_Coast", "Apo_fired",
  "Main_fired", "3rd_fired", "4th_fired", "Normal_Ascent", "Accel_Vel_LE_0",
  "ECI_Vvel_le_0", "Tilt Exceeded 90deg",
];

export function parseLR(text: string): LRData {
  const ls = lines(text);
  const h = ls[0].split(",");
  // First occurrence only: the condition-flag names repeat once per channel.
  const col = (name: string, required = true) => {
    const i = h.indexOf(name);
    if (i < 0 && required) throw new Error(`LR file is missing column ${name}`);
    return i;
  };
  const idx = {
    t: col("Flight_Time_(s)"),
    time: col("Time"),
    y: col("Year"), mo: col("Month"), d: col("Day"),
    temp: col("Temperature_(F)"),
    press: col("Baro_Press_(atm)"),
    asl: col("Baro_Altitude_ASL_(feet)"),
    agl: col("Baro_Altitude_AGL_(feet)"),
    batt: col("Batt_Volts"),
    apoV: col("Apo_Volts"), mainV: col("Main_Volts"), v3: col("3rd_Volts"), v4: col("4th_Volts"),
    vu: col("Velocity_Up"), vdr: col("Velocity_DR"), vcr: col("Velocity_CR"),
    ia: col("Inertial_Altitude"), idr: col("Inertial_DR_Position"), icr: col("Inertial_CR_position"),
    tilt: col("Tilt_Angle_(deg)"), fut: col("Future_Angle_(deg)"), roll: col("Roll_Angle_(deg)"),
  };
  const flagIdx: Record<string, number> = {};
  for (const f of LR_FLAGS) {
    const i = col(f, false);
    if (i >= 0) flagIdx[f] = i;
  }
  // Per-channel condition blocks: each block starts at an LT_AGL1 column.
  const blockStarts: number[] = [];
  h.forEach((name, i) => { if (name === "LT_AGL1") blockStarts.push(i); });

  const cap = ls.length - 1;
  const F = () => new Float32Array(cap);
  const out = {
    t: new Float64Array(cap), temp: F(), press: F(), asl: F(), agl: F(), batt: F(),
    apoV: F(), mainV: F(), v3: F(), v4: F(), vu: F(), vdr: F(), vcr: F(),
    ia: F(), idr: F(), icr: F(), tilt: F(), fut: F(), roll: F(),
  };
  const clock: string[] = [];
  const flags: Record<string, Uint8Array> = {};
  for (const f of Object.keys(flagIdx)) flags[f] = new Uint8Array(cap);
  const conditions = {} as Record<Channel, Record<string, Uint8Array>>;
  CHANNELS.forEach((ch, b) => {
    conditions[ch] = {};
    if (blockStarts[b] === undefined) return;
    for (const c of CONDITION_FLAGS) conditions[ch][c] = new Uint8Array(cap);
  });

  let n = 0;
  let date = "";
  for (let r = 1; r < ls.length; r++) {
    const f = ls[r].split(",");
    const tt = parseFloat(f[idx.t]);
    if (!Number.isFinite(tt)) continue;
    if (!date) date = `${f[idx.y]}-${String(f[idx.mo]).padStart(2, "0")}-${String(f[idx.d]).padStart(2, "0")}`;
    out.t[n] = tt;
    clock.push(f[idx.time]);
    (Object.keys(idx) as (keyof typeof idx)[]).forEach((k) => {
      if (k === "t" || k === "time" || k === "y" || k === "mo" || k === "d") return;
      (out as any)[k][n] = parseFloat(f[idx[k]]);
    });
    for (const [name, i] of Object.entries(flagIdx)) flags[name][n] = f[i] === "1" ? 1 : 0;
    CHANNELS.forEach((ch, b) => {
      const s = blockStarts[b];
      if (s === undefined) return;
      CONDITION_FLAGS.forEach((c, k) => { conditions[ch][c][n] = f[s + k] === "1" ? 1 : 0; });
    });
    n++;
  }
  const cut = <T extends Float32Array | Float64Array | Uint8Array>(a: T) => a.subarray(0, n) as T;
  for (const k of Object.keys(flags)) flags[k] = cut(flags[k]);
  for (const ch of CHANNELS) for (const k of Object.keys(conditions[ch])) conditions[ch][k] = cut(conditions[ch][k]);
  return {
    n, t: cut(out.t), clock, date,
    tempF: cut(out.temp), pressAtm: cut(out.press), baroAsl: cut(out.asl), baroAgl: cut(out.agl),
    battV: cut(out.batt),
    chanV: { Apo: cut(out.apoV), Main: cut(out.mainV), "3rd": cut(out.v3), "4th": cut(out.v4) },
    velUp: cut(out.vu), velDR: cut(out.vdr), velCR: cut(out.vcr),
    inAlt: cut(out.ia), inDR: cut(out.idr), inCR: cut(out.icr),
    tilt: cut(out.tilt), futureAngle: cut(out.fut), rollAngle: cut(out.roll),
    flags, conditions,
  };
}

export function parseSummary(text: string): Summary {
  const raw: Record<string, string> = {};
  const num: Record<string, number> = {};
  const vec: Record<string, [number, number, number]> = {};
  for (const line of lines(text)) {
    const i = line.indexOf(",");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    raw[key] = val;
    const parts = val.split(",").map((s) => parseFloat(s));
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      vec[key] = parts as [number, number, number];
    } else {
      const m = val.match(/^-?\d+(\.\d+)?/);
      if (m) num[key] = parseFloat(m[0]);
    }
  }
  return { raw, num, vec };
}

/** Minimal XLSX reader: first worksheet as a 2D string grid. */
function readXlsxGrid(buf: ArrayBuffer): string[][] {
  const files = unzipSync(new Uint8Array(buf));
  const xml = (path: string) => (files[path] ? strFromU8(files[path]) : "");
  const dp = new DOMParser();
  const shared: string[] = [];
  const ssXml = xml("xl/sharedStrings.xml");
  if (ssXml) {
    const doc = dp.parseFromString(ssXml, "application/xml");
    for (const si of Array.from(doc.getElementsByTagName("si"))) {
      shared.push(Array.from(si.getElementsByTagName("t")).map((t) => t.textContent ?? "").join(""));
    }
  }
  const sheetPath = Object.keys(files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort()[0];
  if (!sheetPath) throw new Error("No worksheet found in settings file");
  const doc = dp.parseFromString(xml(sheetPath), "application/xml");
  const grid: string[][] = [];
  for (const c of Array.from(doc.getElementsByTagName("c"))) {
    const ref = c.getAttribute("r") ?? "";
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    let colN = 0;
    for (const ch of m[1]) colN = colN * 26 + (ch.charCodeAt(0) - 64);
    const row = parseInt(m[2], 10) - 1;
    const type = c.getAttribute("t");
    let v = "";
    if (type === "s") v = shared[parseInt(c.getElementsByTagName("v")[0]?.textContent ?? "0", 10)] ?? "";
    else if (type === "inlineStr") v = Array.from(c.getElementsByTagName("t")).map((t) => t.textContent ?? "").join("");
    else if (type === "b") v = c.getElementsByTagName("v")[0]?.textContent === "1" ? "TRUE" : "FALSE";
    else v = c.getElementsByTagName("v")[0]?.textContent ?? "";
    (grid[row] ??= [])[colN - 1] = v;
  }
  return grid.map((r) => Array.from(r ?? [], (x) => x ?? ""));
}

export function parseSettings(buf: ArrayBuffer): DeploySettings {
  const grid = readXlsxGrid(buf).filter((r) => r.some((x) => x !== ""));
  const header = grid.find((r) => r[0]?.startsWith("Hardware_Channel"));
  if (!header) throw new Error("Settings file has no Hardware_Channel row");
  // Use the primary column of each channel (Apo_Pri, Main_Pri, ...).
  const colOf: Record<Channel, number> = { Apo: -1, Main: -1, "3rd": -1, "4th": -1 };
  for (const ch of CHANNELS) colOf[ch] = header.indexOf(`${ch}_Pri`);
  const conditions: DeploySettings["conditions"] = [];
  const options: DeploySettings["options"] = {};
  const values: DeploySettings["values"] = {};
  for (const r of grid) {
    if (r === header) continue;
    const name = r[0];
    if (!name || name === "Reserved") continue;
    const cells = CHANNELS.map((ch) => r[colOf[ch]] ?? "");
    if (cells.every((c) => c === "Check" || c === "X")) {
      const enabled = {} as Record<Channel, boolean>;
      CHANNELS.forEach((ch, i) => (enabled[ch] = cells[i] === "Check"));
      conditions.push({ name, enabled });
    } else if (cells.every((c) => c === "TRUE" || c === "FALSE")) {
      const o = {} as Record<Channel, string>;
      CHANNELS.forEach((ch, i) => (o[ch] = cells[i]));
      options[name] = o;
    } else if (cells.every((c) => c !== "" && Number.isFinite(parseFloat(c)))) {
      const v = {} as Record<Channel, number>;
      CHANNELS.forEach((ch, i) => (v[ch] = parseFloat(cells[i])));
      values[name] = v;
    }
  }
  return { conditions, options, values };
}

/** Load any mix of Blue Raven and Featherweight GPS files (dropped or fetched) into one flight. */
export async function loadBlueRaven(
  files: { name: string; text?: string; buffer?: ArrayBuffer }[],
): Promise<{ flight: BlueRavenFlight; warnings: string[] }> {
  const flight: BlueRavenFlight = { name: "" };
  const warnings: string[] = [];
  let gpsSummary: Record<string, string> | undefined;
  for (const f of files) {
    if (f.buffer && /\.xlsx$/i.test(f.name)) {
      try { flight.settings = parseSettings(f.buffer); }
      catch (e) { warnings.push(`${f.name}: ${(e as Error).message}`); }
      continue;
    }
    const text = f.text ?? (f.buffer ? new TextDecoder().decode(f.buffer) : "");
    if (/\.kml$/i.test(f.name)) {
      warnings.push(`${f.name}: KML is not needed (the GPS CSV has the same track with correct times), skipped`);
      continue;
    }
    if (isGpsLog(text)) {
      try { flight.gps = parseGpsLog(text, f.name.replace(/_\d\d-\d\d-\d{4}.*$/, "").replace(/\.csv$/i, "")); }
      catch (e) { warnings.push(`${f.name}: ${(e as Error).message}`); }
      continue;
    }
    if (isGpsSummary(text)) {
      gpsSummary = parseGpsSummary(text);
      continue;
    }
    const kind = identifyText(text);
    try {
      if (kind === "hr") flight.hr = parseHR(text);
      else if (kind === "lr") flight.lr = parseLR(text);
      else if (kind === "summary") flight.summary = parseSummary(text);
      else warnings.push(`${f.name}: not a recognized Blue Raven file (skipped)`);
    } catch (e) {
      warnings.push(`${f.name}: ${(e as Error).message}`);
    }
  }
  if (flight.gps && gpsSummary) {
    flight.gps.summary = gpsSummary;
    if (gpsSummary["Rocket Name"]) flight.gps.name = gpsSummary["Rocket Name"];
  } else if (gpsSummary && !flight.gps) {
    warnings.push("GPS summary loaded without the GPS flight CSV; include the GPS log to use it.");
  }
  flight.name =
    flight.summary?.raw["Rocket Name"] ??
    files.map((f) => f.name.match(/BlRv_SN\d+/)?.[0]).find(Boolean) ??
    "Blue Raven flight";
  return { flight, warnings };
}
