// Ejection timing: how long after each pyro fire the deployment shock shows up in the
// accelerometer, and how hard it was. A slow or missing shock points at a weak charge,
// a tight fit or shear pins that held too long.
import type { Analysis } from "./analysis";
import { lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";

export interface Ejection {
  key: string; label: string; fireT: number;
  /** first jolt after the fire: the charge separating the airframe */
  delay: number | null; peakG: number | null;
  /** biggest load in the 6 s after the fire: usually the parachute snatching open */
  openT: number | null; openG: number | null;
}

export function ejectionTimes(f: BlueRavenFlight, a: Analysis): Ejection[] {
  const hr = f.hr, m = a.accelMag;
  if (!hr || !m) return [];
  const out: Ejection[] = [];
  for (const e of a.events.filter((x) => x.key.startsWith("fire_"))) {
    // baseline: median |accel| in the 0.5 s before the fire
    const b0 = lowerBound(hr.t, e.t - 0.5), b1 = lowerBound(hr.t, e.t);
    const base = [...m.subarray(b0, b1)].filter(Number.isFinite).sort((x, y) => x - y);
    const med = base.length ? base[Math.floor(base.length / 2)] : 1;
    const thr = Math.max(med + 3, med * 2);
    let onset = -1;
    const j1 = lowerBound(hr.t, e.t + 3);
    for (let j = b1; j < j1; j++) if (m[j] > thr) { onset = j; break; }
    // largest load in the next 6 s (stop before touchdown so the landing hit isn't counted)
    const land = a.events.find((x) => x.key === "landing")?.t ?? Infinity;
    let openG = 0, openJ = -1;
    for (let j = b1, je = lowerBound(hr.t, Math.min(e.t + 6, land - 0.3)); j < je; j++) if (m[j] > openG) { openG = m[j]; openJ = j; }
    const open = openJ >= 0 && openG > thr ? { openT: hr.t[openJ] - e.t, openG } : { openT: null, openG: null };
    if (onset < 0) { out.push({ key: e.key, label: e.label, fireT: e.t, delay: null, peakG: null, ...open }); continue; }
    let peak = 0;
    for (let j = onset, jp = lowerBound(hr.t, hr.t[onset] + 0.3); j < jp; j++) if (m[j] > peak) peak = m[j];
    out.push({ key: e.key, label: e.label, fireT: e.t, delay: hr.t[onset] - e.t, peakG: peak, ...open });
  }
  return out;
}
