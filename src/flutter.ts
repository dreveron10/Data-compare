// Fin flutter speed, the simplified NACA TN 4197 form popularised in Apogee's Peak of Flight #291:
//   Vf = a * sqrt( G / ( 1.337 AR^3 P (λ + 1) / ( 2 (AR + 2) (t/c)^3 ) ) )
// a: speed of sound, G: shear modulus (psi), P: air pressure (psi), AR = span² / fin area,
// λ = tip/root chord, t/c = thickness / root chord. Evaluated along the logged climb.
import type { Analysis } from "./analysis";
import { lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";

export interface Fin { rootIn: number; tipIn: number; spanIn: number; thickIn: number; gPsi: number }
export const MATERIALS: { name: string; gPsi: number }[] = [
  { name: "G10 / FR4 fiberglass (about 425,000 psi)", gPsi: 425_000 },
  { name: "Aluminum 6061 (about 3,800,000 psi)", gPsi: 3_800_000 },
  { name: "Birch plywood (about 90,000 psi)", gPsi: 90_000 },
];

export function flutterSpeed(fin: Fin, pressurePsi: number, tempR: number): number {
  const area = 0.5 * (fin.rootIn + fin.tipIn) * fin.spanIn;
  const ar = (fin.spanIn * fin.spanIn) / area;
  const lam = fin.tipIn / fin.rootIn;
  const tc = fin.thickIn / fin.rootIn;
  const a = Math.sqrt(1.4 * 1716.5 * tempR); // ft/s
  const denom = (1.337 * ar ** 3 * pressurePsi * (lam + 1)) / (2 * (ar + 2) * tc ** 3);
  return a * Math.sqrt(fin.gPsi / denom);
}

export interface FlutterResult { minRatio: number; tAt: number; vAt: number; vfAt: number; altAt: number; maxV: number }

/** the closest the climb came to flutter: smallest flutter speed / actual speed */
export function flutterMargin(f: BlueRavenFlight, a: Analysis, fin: Fin): FlutterResult | null {
  const lr = f.lr;
  if (!lr || !(fin.rootIn > 0 && fin.spanIn > 0 && fin.thickIn > 0 && fin.gPsi > 0)) return null;
  const ev = (k: string) => a.events.find((e) => e.key === k)?.t;
  const lift = ev("liftoff") ?? 0, apo = ev("apogee") ?? lr.t[lr.n - 1];
  const padTempR = lr.tempF[Math.max(0, lowerBound(lr.t, lift) - 1)] + 459.67;
  let best: FlutterResult | null = null;
  let maxV = 0;
  for (let i = lowerBound(lr.t, lift); i < lr.n && lr.t[i] <= apo; i++) {
    const tilt = lr.tilt[i];
    const v = lr.velUp[i] / Math.cos(((tilt >= 0 && tilt < 60 ? tilt : 0) * Math.PI) / 180);
    if (!(v > 50)) continue;
    maxV = Math.max(maxV, v);
    const tempR = padTempR - 0.00356616 * Math.max(0, a.altSmooth[i]);
    const vf = flutterSpeed(fin, lr.pressAtm[i] * 14.6959, tempR);
    const r = vf / v;
    if (!best || r < best.minRatio) best = { minRatio: r, tAt: lr.t[i], vAt: v, vfAt: vf, altAt: a.altSmooth[i], maxV: 0 };
  }
  if (best) best.maxV = maxV;
  return best;
}
