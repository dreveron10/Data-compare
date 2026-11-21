// Descent analysis: steady descent rate per phase, air density from the logged pressure and
// temperature, sea-level equivalent rate and the parachute CdA it implies.

import type { Analysis } from "./analysis";
import { lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";

export interface DescentPhase {
  name: string;
  t0: number;
  t1: number;
  altTop: number;
  altBottom: number;
  rate: number; // ft/s, positive down (median of the phase)
  rho: number; // slug/ft^3 at the phase middle
  seaLevelRate: number; // ft/s at standard sea-level density
  cdA: number | null; // ft^2, needs the vehicle weight
}

const RHO0 = 0.0023769; // slug/ft^3, standard sea level
const R_AIR = 1716.5; // ft*lbf/(slug*R)
const LAPSE = 0.00356616; // R per ft (standard lapse rate)

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

export function descentPhases(f: BlueRavenFlight, a: Analysis, weightLb: number | null): DescentPhase[] {
  const lr = f.lr!;
  const ev = (k: string) => a.events.find((e) => e.key === k)?.t;
  const tApo = ev("apogee");
  const tMain = ev("fire_Main");
  const tLand = ev("landing");
  if (tApo === undefined || tLand === undefined) return [];
  const lift = ev("liftoff") ?? 0;
  const padTempR = lr.tempF[Math.max(0, lowerBound(lr.t, lift) - 1)] + 459.67;

  const phase = (name: string, t0: number, t1: number): DescentPhase | null => {
    if (t1 - t0 < 2) return null;
    const i0 = lowerBound(lr.t, t0), i1 = lowerBound(lr.t, t1);
    const rates: number[] = [];
    for (let i = i0; i < i1; i++) rates.push(-a.baroVel[i]);
    const rate = median(rates);
    const im = Math.floor((i0 + i1) / 2);
    const pPsf = lr.pressAtm[im] * 2116.22; // lbf/ft^2
    const tempR = padTempR - LAPSE * Math.max(0, a.altSmooth[im]);
    const rho = pPsf / (R_AIR * tempR);
    return {
      name, t0, t1,
      altTop: a.altSmooth[i0], altBottom: a.altSmooth[Math.max(i0, i1 - 1)],
      rate, rho,
      seaLevelRate: rate * Math.sqrt(rho / RHO0),
      cdA: weightLb && rate > 0 ? (2 * weightLb) / (rho * rate * rate) : null,
    };
  };
  const out: DescentPhase[] = [];
  if (tMain !== undefined && tMain > tApo) {
    const d = phase("Drogue", tApo + 3, tMain - 0.5);
    const m = phase("Main", tMain + 4, tLand - 1);
    if (d) out.push(d);
    if (m) out.push(m);
  } else {
    const d = phase("Descent", tApo + 3, tLand - 1);
    if (d) out.push(d);
  }
  return out;
}

/** descent rate vs altitude after apogee, sorted by altitude for plotting */
export function rateVsAltitude(f: BlueRavenFlight, a: Analysis) {
  const lr = f.lr!;
  const tApo = a.events.find((e) => e.key === "apogee")?.t ?? 0;
  const tLand = a.events.find((e) => e.key === "landing")?.t ?? lr.t[lr.n - 1];
  const pts: [number, number][] = [];
  for (let i = lowerBound(lr.t, tApo + 1); i < lr.n && lr.t[i] <= tLand; i += 2) {
    pts.push([Math.max(0, a.altSmooth[i]), -a.baroVel[i]]);
  }
  pts.sort((p, q) => p[0] - q[0]);
  // uPlot needs strictly increasing x: drop duplicates
  const x: number[] = [], y: number[] = [];
  for (const [alt, r] of pts) {
    if (x.length && alt <= x[x.length - 1]) continue;
    x.push(alt); y.push(r);
  }
  return { x, y };
}
