// A comparison trace: an OpenRocket sim or a second flight, reduced to the series and
// key numbers needed to overlay it on the main flight.

import type { Analysis } from "./analysis";
import { indexAt, lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";
import type { SimData } from "./parsers/openRocket";

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
  /** path is in true east/north (true for sims with position data and GPS-aligned flights) */
  compass: boolean;
  events: { label: string; t: number }[];
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
  const pt = new Float64Array(a.path.t.length);
  for (let i = 0; i < pt.length; i++) pt[i] = a.path.t[i] - lift;
  return {
    kind: "flight",
    name: `${f.name}${lr.date ? ` (${lr.date})` : ""}`,
    t, alt: a.altSmooth, vVert: lr.velUp,
    accT, acc: a.axialAccel,
    path: { t: pt, x: a.path.x, y: a.path.y, z: a.path.z },
    compass: a.compass,
    events: a.events.filter((e) => e.key !== "apogee_det").map((e) => ({ label: e.label, t: e.t - lift })),
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
