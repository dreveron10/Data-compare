// Mach number and dynamic pressure along the flight, from the logged air data.
// Speed: along the rocket axis on the way up (vertical speed / cos tilt; the inertial sideways
// speed drifts), and the baro descent rate after apogee.
import type { Analysis } from "./analysis";
import { lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";

const R_AIR = 1716.5, LAPSE = 0.00356616, GAMMA = 1.4;

export interface Aero { mach: Float32Array; qPsf: Float32Array; iMaxQ: number; maxQ: number; maxMach: number }

export function aeroSeries(f: BlueRavenFlight, a: Analysis): Aero | null {
  const lr = f.lr;
  if (!lr) return null;
  const ev = (k: string) => a.events.find((e) => e.key === k)?.t;
  const lift = ev("liftoff") ?? 0, apo = ev("apogee") ?? lr.t[lr.n - 1], land = ev("landing") ?? lr.t[lr.n - 1];
  const padTempR = lr.tempF[Math.max(0, lowerBound(lr.t, lift) - 1)] + 459.67;
  const mach = new Float32Array(lr.n), qPsf = new Float32Array(lr.n);
  let iMaxQ = -1, maxQ = 0, maxMach = 0;
  for (let i = 0; i < lr.n; i++) {
    const t = lr.t[i];
    if (t < lift || t > land) { mach[i] = NaN; qPsf[i] = NaN; continue; }
    let v: number;
    if (t <= apo) {
      const tilt = lr.tilt[i];
      v = lr.velUp[i] / Math.cos(((tilt >= 0 && tilt < 60 ? tilt : 0) * Math.PI) / 180);
    } else v = -a.baroVel[i];
    v = Math.max(0, v);
    const tempR = padTempR - LAPSE * Math.max(0, a.altSmooth[i]);
    const rho = (lr.pressAtm[i] * 2116.22) / (R_AIR * tempR);
    mach[i] = v / Math.sqrt(GAMMA * R_AIR * tempR);
    qPsf[i] = 0.5 * rho * v * v;
    if (qPsf[i] > maxQ) { maxQ = qPsf[i]; iMaxQ = i; }
    if (mach[i] > maxMach) maxMach = mach[i];
  }
  return iMaxQ < 0 ? null : { mach, qPsf, iMaxQ, maxQ, maxMach };
}
