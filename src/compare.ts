// A comparison trace: an OpenRocket sim or a second flight, reduced to the series and
// key numbers needed to overlay it on the main flight.

import type { Analysis } from "./analysis";
import { indexAt, lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";
import type { SimData } from "./parsers/openRocket";
import { conv } from "./units";
import type { AltTrace } from "./parsers/genericAlt";

export interface KeyNumbers {
  apogee: number | null; // ft AGL
  tApogee: number | null; // s after liftoff
  maxVel: number | null; // ft/s
  maxAccel: number | null; // g
  burnout: number | null; // s
  drogueRate: number | null; // ft/s
  mainAlt: number | null; // ft AGL
  mainRate: number | null; // ft/s
  flightTime: number | null; // s
  drift: number | null; // ft
}

export const CMP_COLORS = ["#ff9de2", "#c6f07a", "#b9a3ff"];
export const MAX_COMPARES = 3;

/** a comparison currently shown: its trace, source files (for saving), time offset and colour */
export interface ActiveCompare {
  id: string;
  trace: CompareTrace;
  files: { name: string; text?: string; buffer?: ArrayBuffer }[];
  /** seconds added to the comparison's time (positive = later) */
  offset: number;
  color: string;
}

export interface CompareTrace {
  kind: "sim" | "flight";
  name: string;
  /** main series, time is seconds after liftoff */
  t: Float64Array;
  alt?: ArrayLike<number>;
  vVert?: ArrayLike<number>;
  /** acceleration series on its own time base, as an accelerometer would read it (g) */
  accT?: ArrayLike<number>;
  acc?: ArrayLike<number>;
  path?: { t: ArrayLike<number>; x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number> };
  /** world attitude per sample (x,y,z,w), times relative to liftoff; flights only */
  attitude?: { t: Float64Array; quat: Float32Array };
  /** path is in true east/north (true for sims with position data and GPS-aligned flights) */
  compass: boolean;
  events: { label: string; t: number }[];
  /** times after liftoff used to line comparisons up at other events */
  align: { apogee: number | null; main: number | null };
  key: KeyNumbers;
  notes: string[];
}

export const KEY_ROWS: { k: keyof KeyNumbers; label: string; unit: string }[] = [
  { k: "apogee", label: "Apogee AGL", unit: "ft" },
  { k: "tApogee", label: "Time to apogee", unit: "s" },
  { k: "maxVel", label: "Max velocity", unit: "ft/s" },
  { k: "maxAccel", label: "Max boost accel", unit: "g" },
  { k: "burnout", label: "Burnout", unit: "s" },
  { k: "drogueRate", label: "Drogue descent rate", unit: "ft/s" },
  { k: "mainAlt", label: "Main deploy altitude", unit: "ft" },
  { k: "mainRate", label: "Main descent rate", unit: "ft/s" },
  { k: "flightTime", label: "Flight time", unit: "s" },
  { k: "drift", label: "Drift at landing", unit: "ft" },
];

function slope(t: ArrayLike<number>, y: ArrayLike<number>, t0: number, t1: number): number | null {
  let n = 0, st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = lowerBound(t, t0); i < t.length && t[i] <= t1; i++) {
    if (!Number.isFinite(y[i])) continue;
    n++; st += t[i]; sy += y[i]; stt += t[i] * t[i]; sty += t[i] * y[i];
  }
  if (n < 3) return null;
  const d = n * stt - st * st;
  return d === 0 ? null : (n * sty - st * sy) / d;
}

const metric = (a: Analysis, label: string) => a.metrics.find((m) => m.label === label)?.site ?? null;
const ev = (a: Analysis, key: string) => a.events.find((e) => e.key === key)?.t ?? null;

/** Key numbers of an analyzed flight (used for both the main flight and a comparison flight). */
export function keyNumbersOf(a: Analysis): KeyNumbers {
  const lift = ev(a, "liftoff") ?? 0;
  const land = ev(a, "landing");
  return {
    apogee: metric(a, "Apogee (baro)"),
    tApogee: metric(a, "Time to apogee"),
    maxVel: metric(a, "Max velocity"),
    maxAccel: metric(a, "Max boost accel"),
    burnout: metric(a, "Burnout time"),
    drogueRate: metric(a, "Drogue descent rate"),
    mainAlt: metric(a, "Main deploy altitude"),
    mainRate: metric(a, "Main descent rate"),
    flightTime: land !== null ? land - lift : null,
    drift: a.gps?.landing.distance ?? null,
  };
}

export function traceFromFlight(a: Analysis, f: BlueRavenFlight): CompareTrace {
  const lift = ev(a, "liftoff") ?? 0;
  const lr = f.lr!;
  const t = new Float64Array(lr.n);
  for (let i = 0; i < lr.n; i++) t[i] = lr.t[i] - lift;
  let accT: Float64Array | undefined;
  if (f.hr && a.axialAccel) {
    accT = new Float64Array(f.hr.n);
    for (let i = 0; i < f.hr.n; i++) accT[i] = f.hr.t[i] - lift;
  }
  let attitude: CompareTrace["attitude"];
  if (f.hr && a.frame) {
    const at = new Float64Array(f.hr.n);
    for (let i = 0; i < f.hr.n; i++) at[i] = f.hr.t[i] - lift;
    attitude = { t: at, quat: a.frame.worldQuat };
  }
  const pt = new Float64Array(a.path.t.length);
  for (let i = 0; i < pt.length; i++) pt[i] = a.path.t[i] - lift;
  return {
    kind: "flight",
    name: `${f.name}${lr.date ? ` (${lr.date})` : ""}`,
    t, alt: a.altSmooth, vVert: lr.velUp,
    accT, acc: a.axialAccel,
    path: { t: pt, x: a.path.x, y: a.path.y, z: a.path.z },
    attitude,
    compass: a.compass,
    events: a.events.filter((e) => e.key !== "apogee_det").map((e) => ({ label: e.label, t: e.t - lift })),
    align: {
      apogee: ev(a, "apogee") !== null ? ev(a, "apogee")! - lift : null,
      main: ev(a, "fire_Main") !== null ? ev(a, "fire_Main")! - lift : null,
    },
    key: keyNumbersOf(a),
    notes: [],
  };
}

export function traceFromSim(s: SimData): CompareTrace {
  const notes: string[] = [];
  const evT = (name: string, k = 0) => s.events.filter((e) => e.name === name)[k]?.t ?? null;
  const alt = s.alt;
  if (!alt) throw new Error("the OpenRocket export needs an Altitude column");
  let iA = 0;
  for (let i = 0; i < s.n; i++) if (alt[i] > alt[iA]) iA = i;
  const tApo = evT("APOGEE") ?? s.t[iA];
  const deploys = s.events.filter((e) => e.name === "RECOVERY_DEVICE_DEPLOYMENT").map((e) => e.t).sort((a, b) => a - b);
  const tMain = deploys.length >= 2 ? deploys[deploys.length - 1] : null;
  const tGround = evT("GROUND_HIT") ?? s.t[s.n - 1];
  const maxOf = (a?: ArrayLike<number>, t1 = Infinity) => {
    if (!a) return null;
    let m = -Infinity;
    for (let i = 0; i < s.n && s.t[i] <= t1; i++) if (a[i] > m) m = a[i];
    return Number.isFinite(m) ? m : null;
  };
  // an accelerometer reads kinematic acceleration plus 1 g while the rocket points up
  let acc: Float32Array | undefined;
  const kin = s.accTotal ?? s.accVert;
  if (kin) {
    acc = new Float32Array(s.n);
    const tB = evT("BURNOUT") ?? 3;
    for (let i = 0; i < s.n; i++) acc[i] = s.t[i] <= tB + 0.5 && s.t[i] >= 0 ? kin[i] + 1 : kin[i];
    notes.push("Sim acceleration shown as an accelerometer would read it during boost (kinematic + 1 g).");
  }
  let path: CompareTrace["path"];
  if (s.east && s.north) {
    const x = new Float32Array(s.n), z = new Float32Array(s.n), y = new Float32Array(s.n);
    for (let i = 0; i < s.n; i++) { x[i] = s.east[i]; z[i] = -s.north[i]; y[i] = Math.max(0, alt[i]); }
    path = { t: s.t, x, y, z };
  } else {
    notes.push("Export 'Position East/North of launch' to see the sim path in 3D.");
  }
  const iEnd = s.n - 1;
  return {
    kind: "sim",
    name: s.name,
    t: s.t, alt, vVert: s.vVert, accT: acc ? s.t : undefined, acc,
    path, compass: !!path,
    events: s.events.filter((e) => !["LAUNCH", "IGNITION", "SIMULATION_END", "LAUNCHROD"].includes(e.name))
      .map((e) => ({ label: e.name.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), t: e.t })),
    align: { apogee: tApo, main: tMain },
    key: {
      apogee: alt[iA],
      tApogee: tApo,
      maxVel: maxOf(s.vTotal ?? s.vVert, tApo),
      maxAccel: acc ? maxOf(acc, (evT("BURNOUT") ?? 3) + 0.5) : null,
      burnout: evT("BURNOUT"),
      drogueRate: tMain !== null ? slope(s.t, alt, tApo + 3, tMain - 0.5) : slope(s.t, alt, tApo + 3, tGround - 1),
      mainAlt: tMain !== null ? alt[indexAt(s.t, tMain)] : null,
      mainRate: tMain !== null ? slope(s.t, alt, tMain + 4, tGround - 1) : null,
      flightTime: tGround,
      drift: s.east && s.north ? Math.hypot(s.east[iEnd], s.north[iEnd]) : null,
    },
    notes,
  };
}

/** sample a trace series at time x (seconds after liftoff); NaN outside its range */
export function sampleAt(t: ArrayLike<number>, y: ArrayLike<number>, x: number): number {
  if (x < t[0] || x > t[t.length - 1]) return NaN;
  const i = lowerBound(t, x);
  if (i <= 0) return y[0];
  const t0 = t[i - 1], t1 = t[i];
  const u = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
  return y[i - 1] + (y[i] - y[i - 1]) * u;
}

/**
 * One plain sentence on how this flight differs from a comparison: the biggest relative
 * differences first, then which numbers agree. Thresholds: under 5% counts as a match.
 */
export function whatChanged(mine: KeyNumbers, other: KeyNumbers, otherName: string): string {
  type Row = { k: keyof KeyNumbers; more: string; less: string; unit: string; abs?: boolean; digits?: number; noun: string };
  const rows: Row[] = [
    { k: "apogee", more: "peaked {d} higher", less: "peaked {d} lower", unit: "ft", noun: "apogee" },
    { k: "maxVel", more: "was {d} faster at peak", less: "was {d} slower at peak", unit: "ft/s", noun: "top speed" },
    { k: "maxAccel", more: "boosted {d} harder", less: "boosted {d} softer", unit: "g", digits: 1, noun: "boost acceleration" },
    { k: "tApogee", more: "reached apogee {d} later", less: "reached apogee {d} sooner", unit: "s", digits: 1, noun: "time to apogee" },
    { k: "mainAlt", more: "opened the main {d} higher", less: "opened the main {d} lower", unit: "ft", noun: "main deploy altitude" },
    { k: "drogueRate", more: "fell {d} faster under drogue", less: "fell {d} slower under drogue", unit: "ft/s", abs: true, noun: "drogue rate" },
    { k: "mainRate", more: "fell {d} faster under main", less: "fell {d} slower under main", unit: "ft/s", abs: true, digits: 1, noun: "main rate" },
    { k: "flightTime", more: "flew {d} longer", less: "flew {d} shorter", unit: "s", noun: "flight time" },
    { k: "drift", more: "drifted {d} farther", less: "drifted {d} less", unit: "ft", noun: "drift" },
  ];
  const diffs: { rel: number; text: string }[] = [];
  const same: string[] = [];
  for (const r of rows) {
    let a = mine[r.k], b = other[r.k];
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b) < 1e-6) continue;
    if (r.abs) { a = Math.abs(a); b = Math.abs(b); }
    const d = a - b;
    const rel = d / Math.abs(b);
    if (Math.abs(rel) < 0.05) { same.push(r.noun); continue; }
    const [v, u] = conv(Math.abs(d), r.unit);
    const txt = (d > 0 ? r.more : r.less).replace("{d}", `${v.toFixed(r.digits ?? 0)} ${u}`);
    // a percentage of a tiny base (a main that opened at 50 ft) says nothing; show both values instead
    const fmtV = (x: number) => `${conv(x, r.unit)[0].toFixed(r.digits ?? 0)}`;
    const tail = Math.abs(rel) > 2 ? `${fmtV(a)} vs ${fmtV(b)} ${u}` : `${(Math.abs(rel) * 100).toFixed(0)}%`;
    diffs.push({ rel: Math.abs(rel), text: `${txt} (${tail})` });
  }
  diffs.sort((x, y) => y.rel - x.rel);
  const top = diffs.slice(0, 3).map((x) => x.text);
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  let s = top.length ? `Against ${otherName}, this flight ${list(top)}.` : `This flight matches ${otherName} within 5% on every number.`;
  if (top.length && same.length) s += ` ${list(same.slice(0, 3)).replace(/^./, (c) => c.toUpperCase())} ${same.length === 1 ? "matches" : "match"} within 5%.`;
  return s;
}

/** comparison trace from another brand of altimeter (time + altitude CSV) */
export function traceFromAltimeter(s: AltTrace): CompareTrace {
  const n = s.t.length;
  let iA = 0;
  for (let i = 0; i < n; i++) if (s.alt[i] > s.alt[iA]) iA = i;
  const tApo = s.t[iA];
  // landing: first time after apogee within 15 ft of the ground
  let iL = n - 1;
  for (let i = iA; i < n; i++) if (s.alt[i] < 15) { iL = i; break; }
  const tGround = s.t[iL];
  // two descent rates when the log shows a clear slow-down (drogue then main)
  const rate = (a: number, b: number) => (b - a > 1 ? slope(s.t, s.alt, a, b) : null);
  let tMain: number | null = null;
  const early = rate(tApo + 3, tApo + 3 + (tGround - tApo - 3) * 0.4);
  const late = rate(tGround - Math.max(2, (tGround - tApo) * 0.3), tGround - 1);
  if (early !== null && late !== null && Math.abs(early) > 1.8 * Math.abs(late)) {
    const mid = (Math.abs(early) + Math.abs(late)) / 2;
    // the main is open once the fall rate stays below the midpoint for 3 s straight
    const rateAt = (i: number) => { let j = i; while (j < iL && s.t[j] - s.t[i] < 1) j++; return s.t[j] > s.t[i] ? Math.abs((s.alt[j] - s.alt[i]) / (s.t[j] - s.t[i])) : Infinity; };
    for (let i = iA; i < iL && tMain === null; i++) {
      if (s.t[i] < tApo + 3 || rateAt(i) >= mid) continue;
      let ok = true;
      for (let k = i; k < iL && s.t[k] - s.t[i] < 3; k++) if (rateAt(k) >= mid) { ok = false; break; }
      if (ok) tMain = s.t[i];
    }
  }
  let maxV: number | null = null;
  for (let i = 0; i <= iA; i++) if (Number.isFinite(s.vVert[i]) && (maxV === null || s.vVert[i] > maxV)) maxV = s.vVert[i];
  return {
    kind: "flight",
    name: s.name,
    t: s.t, alt: s.alt, vVert: s.vVert,
    compass: false,
    events: [{ label: "Apogee", t: tApo }, ...(tMain !== null ? [{ label: "Main (from descent rate)", t: tMain }] : []), { label: "Landing", t: tGround }],
    align: { apogee: tApo, main: tMain },
    key: {
      apogee: s.alt[iA], tApogee: tApo, maxVel: maxV, maxAccel: null, burnout: null,
      drogueRate: tMain !== null ? rate(tApo + 3, tMain - 0.5) : rate(tApo + 3, tGround - 1),
      mainAlt: tMain !== null ? s.alt[indexAt(s.t, tMain)] : null,
      mainRate: tMain !== null ? rate(tMain + 3, tGround - 1) : null,
      flightTime: tGround, drift: null,
    },
    notes: [...s.notes, "Other altimeter: altitude and vertical speed only, no attitude or position."],
  };
}
