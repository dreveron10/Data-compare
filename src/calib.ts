// Where does a sim's apogee miss come from: the boost (thrust and mass) or the coast (drag)?
// Splits the apogee gap using the vertical speed and altitude at burnout, then suggests the
// OpenRocket change that would close the larger part.
import type { Analysis } from "./analysis";
import { indexAt } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";
import { sampleAt, type CompareTrace } from "./compare";
import { show } from "./units";

export interface CalibHint {
  gap: number; // ft, real apogee minus sim apogee
  fromBoost: number; // ft of the gap explained by burnout state
  fromCoast: number; // ft left over, from drag during coast
  vReal: number; vSim: number; // vertical ft/s at burnout
  lines: string[];
}

export function calibHint(f: BlueRavenFlight, a: Analysis, sim: CompareTrace, measuredCd: number | null): CalibHint | null {
  const lr = f.lr!;
  const ev = (k: string) => a.events.find((e) => e.key === k)?.t;
  const bo = ev("burnout"), apo = ev("apogee");
  const k = sim.key;
  if (bo === undefined || apo === undefined || !sim.alt || !sim.vVert || k.apogee === null || k.burnout === null) return null;
  const iB = indexAt(lr.t, bo);
  const vReal = lr.velUp[iB], hReal = a.altSmooth[iB];
  const realApo = a.altSmooth[indexAt(lr.t, apo)];
  const vSim = sampleAt(sim.t, sim.vVert, k.burnout), hSim = sampleAt(sim.t, sim.alt, k.burnout);
  if (!(vReal > 0 && vSim > 0)) return null;
  const simCoast = k.apogee - hSim;
  // vertical coast with quadratic drag: h(v) = ln(1 + k v^2 / g) / (2k). Fit k to the sim's own coast,
  // then ask how high the sim's rocket would coast from the real burnout speed.
  const G = 32.174;
  const hOf = (kk: number, v: number) => (kk < 1e-9 ? (v * v) / (2 * G) : Math.log(1 + (kk * v * v) / G) / (2 * kk));
  let lo = 0, hi = 1;
  if (simCoast >= hOf(0, vSim)) hi = 0; // no drag at all fits (or better): keep k = 0
  else for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (hOf(mid, vSim) > simCoast) lo = mid; else hi = mid; }
  const kFit = (lo + hi) / 2;
  const simCoastAtRealV = hOf(kFit, vReal);
  const gap = realApo - k.apogee;
  const fromBoost = (hReal - hSim) + (simCoastAtRealV - simCoast);
  const fromCoast = gap - fromBoost;
  const lines: string[] = [];
  const pct = (x: number) => `${Math.abs(x * 100).toFixed(0)}%`;
  const dv = vReal / vSim - 1;
  const tiltB = lr.tilt[iB];
  lines.push(`At burnout the real rocket was climbing at ${show(vReal, "ft/s")}, ${dv < 0 ? "slower" : "faster"} than the sim's ${show(vSim, "ft/s")} by ${pct(dv)}.`);
  const boostWord = fromBoost < 0 ? `cost about ${show(Math.abs(fromBoost), "ft")}` : `added about ${show(fromBoost, "ft")}`;
  const coastWord = fromCoast < 0 ? `lost another ${show(Math.abs(fromCoast), "ft")} to more drag than the sim` : `gave back ${show(fromCoast, "ft")} with less drag than the sim`;
  lines.push(`That burnout state alone ${boostWord}; the coast ${coastWord}. Net: ${show(Math.abs(gap), "ft")} ${gap < 0 ? "below" : "above"} the sim's apogee.`);
  if (tiltB > 10) lines.push(`Part of the slower climb is the ${tiltB.toFixed(0)}° tilt at burnout: speed went sideways instead of up. If the sim used little wind or no rail cant, add the launch-day wind to it.`);
  if (Math.abs(fromBoost) >= Math.abs(fromCoast)) {
    // compare total (along-axis) speed so the tilt isn't blamed on mass
    const vRealTot = vReal / Math.cos(((tiltB >= 0 && tiltB < 60 ? tiltB : 0) * Math.PI) / 180);
    const vSimTot = k.maxVel ?? vSim;
    const dm = vSimTot / vRealTot - 1;
    lines.push(`Fix the boost first: along the rocket axis the real burnout speed was ${show(vRealTot, "ft/s")} against the sim's ${show(vSimTot, "ft/s")}. In OpenRocket, ${dm > 0 ? "raise" : "lower"} the liftoff mass by about ${pct(dm)}, or check the motor file and its delivered impulse (the Motor panel measures it), since burnout speed goes roughly as impulse over mass.`);
  } else {
    lines.push(`Fix the drag first: ${fromCoast < 0 ? "raise" : "lower"} the sim's Cd${measuredCd ? `; the coast measurement gives Cd ≈ ${measuredCd.toFixed(2)} with your mass and diameter, so try overriding Cd to that` : " (override it on the Override tab)"}, and check surface finish and fin shape.`);
  }
  return { gap, fromBoost, fromCoast, vReal, vSim, lines };
}
