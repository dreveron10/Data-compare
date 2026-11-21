// Thrust curve from the accelerometer during boost.
// In flight the axial accelerometer reads (T - D) / m, so T = m * a * g0 + D.
// Mass falls as propellant burns; we take burn rate proportional to thrust (constant Isp), which
// needs the total impulse, so the curve is solved twice. Drag uses the coast Cd.
import type { Analysis } from "./analysis";
import { lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";

const G0 = 32.174; // ft/s^2
const R_AIR = 1716.5;
const LAPSE = 0.00356616;
const LBF_TO_N = 4.448222;

export interface ThrustCurve {
  t: number[]; // s, flight time
  thrustLbf: number[];
  impulseNs: number;
  avgN: number;
  peakN: number;
  burnTime: number;
  motorClass: string; // e.g. "71% K"
}

/** 1.25 N·s and up: A, B, C ... each class doubles */
export function motorClass(ns: number): string {
  if (!(ns > 0.3125)) return "";
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const idx = Math.min(letters.length - 1, Math.max(0, Math.ceil(Math.log2(ns / 2.5))));
  const top = 2.5 * 2 ** idx;
  const pct = Math.round(((ns - top / 2) / (top / 2)) * 100);
  return `${Math.max(1, Math.min(100, pct))}% ${letters[idx]}`;
}

export function thrustCurve(f: BlueRavenFlight, a: Analysis, burnoutMassLb: number, propLb: number, diaIn: number, cd: number): ThrustCurve | null {
  const lr = f.lr, hr = f.hr;
  if (!lr || !hr || !a.axialAccel || !(burnoutMassLb > 0) || !(propLb >= 0)) return null;
  const ev = (k: string) => a.events.find((e) => e.key === k)?.t;
  const lift = ev("liftoff"), bo = ev("burnout");
  if (lift === undefined || bo === undefined || bo <= lift) return null;
  const area = Math.PI * (diaIn / 24) ** 2;
  const padTempR = lr.tempF[Math.max(0, lowerBound(lr.t, lift) - 1)] + 459.67;
  // window: from when the motor comes up to pressure on the rail, to just after burnout
  let j0 = lowerBound(hr.t, lift - 1);
  const jL = lowerBound(hr.t, lift);
  for (let j = jL; j >= j0; j--) if (a.axialAccel[j] < 1.3) { j0 = j + 1; break; }
  const j1 = lowerBound(hr.t, bo + 0.3);
  if (j1 - j0 < 20) return null;

  // drag (lbf) at each sample, from the coast Cd
  const drag: number[] = [];
  for (let j = j0; j < j1; j++) {
    const i = Math.min(lr.n - 1, lowerBound(lr.t, hr.t[j]));
    const tilt = lr.tilt[i];
    const v = hr.t[j] < lift ? 0 : Math.max(0, lr.velUp[i] / Math.cos(((tilt >= 0 && tilt < 60 ? tilt : 0) * Math.PI) / 180));
    const tempR = padTempR - LAPSE * Math.max(0, a.altSmooth[i]);
    const rho = (lr.pressAtm[i] * 2116.22) / (R_AIR * tempR);
    drag.push(0.5 * rho * v * v * cd * area);
  }
  const ax = a.axialAccel;
  const solve = (itotLbfs: number) => {
    const T: number[] = [];
    let burned = 0; // lbf*s delivered so far
    for (let k = 0, j = j0; j < j1; j++, k++) {
      const m = (burnoutMassLb + propLb * Math.max(0, 1 - (itotLbfs > 0 ? burned / itotLbfs : 0))) / G0; // slugs
      // on the rail before first motion the rail carries the weight (1 g of the reading)
      const aG = ax[j] - (hr.t[j] < lift ? 1 : 0);
      const thr = Math.max(0, m * aG * G0 + drag[k]);
      T.push(thr);
      const dt = j + 1 < hr.n ? hr.t[j + 1] - hr.t[j] : 0;
      burned += thr * dt;
    }
    return { T, itot: burned };
  };
  let s = solve(0);
  for (let it = 0; it < 3; it++) s = solve(s.itot);
  const t = Array.from(hr.t.slice(j0, j1));
  // burn time: span where thrust is above 5% of peak
  const peak = Math.max(...s.T);
  const on = s.T.map((x) => x > 0.05 * peak);
  const first = on.indexOf(true), last = on.lastIndexOf(true);
  const burnTime = first >= 0 ? t[last] - t[first] : 0;
  const ns = s.itot * LBF_TO_N;
  return { t, thrustLbf: s.T, impulseNs: ns, avgN: burnTime > 0 ? ns / burnTime : 0, peakN: peak * LBF_TO_N, burnTime, motorClass: motorClass(ns) };
}
