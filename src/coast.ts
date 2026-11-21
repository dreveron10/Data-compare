// Drag coefficient during coast, from the accelerometer.
// After burnout the only non-gravity force along the rocket axis is drag, so the axial
// accelerometer reading (in g, negative while coasting) gives drag / mass directly:
//   D = -a_axial * g0 * m,   Cd = 2 D / (rho v^2 A)
import type { Analysis } from "./analysis";
import { lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";

const G0 = 32.174; // ft/s^2
const R_AIR = 1716.5; // ft*lbf/(slug*R)
const LAPSE = 0.00356616; // R per ft
const GAMMA = 1.4;

export interface CoastDrag {
  t: number[];
  mach: number[];
  cd: number[];
  /** set when a pyro fired before apogee and the window was cut there */
  cutBy?: { label: string; t: number };
  /** median Cd over the samples used */
  cd50: number;
  machMin: number;
  machMax: number;
  n: number;
}

export function coastDrag(f: BlueRavenFlight, a: Analysis, massLb: number, diaIn: number): CoastDrag | null {
  const lr = f.lr, hr = f.hr;
  if (!lr || !hr || !a.axialAccel || !(massLb > 0) || !(diaIn > 0)) return null;
  const ev = (k: string) => a.events.find((e) => e.key === k)?.t;
  const lift = ev("liftoff") ?? 0;
  const bo = ev("burnout"), apo = ev("apogee");
  if (bo === undefined || apo === undefined || apo - bo < 2) return null;
  // skip the burnout transient, and the last part before apogee where speed and drag are tiny
  // and stop at any pyro fire before apogee (a separation or airbrake changes the drag)
  const t0 = bo + 0.5;
  const early = a.events.filter((e) => e.key.startsWith("fire_") && e.t > t0 && e.t < apo - 1).sort((x, y) => x.t - y.t)[0];
  const t1 = early ? early.t - 0.1 : apo - 1;
  const area = Math.PI * (diaIn / 24) ** 2; // ft^2
  const slugs = massLb / G0;
  const padTempR = lr.tempF[Math.max(0, lowerBound(lr.t, lift) - 1)] + 459.67;
  const out: CoastDrag = { t: [], mach: [], cd: [], cd50: NaN, machMin: Infinity, machMax: 0, n: 0, cutBy: early ? { label: early.label, t: early.t } : undefined };
  for (let i = lowerBound(lr.t, t0); i < lr.n && lr.t[i] <= t1; i++) {
    // speed along the rocket axis from the vertical velocity and tilt; the inertial horizontal
    // velocity drifts too much to trust in coast
    const tilt = lr.tilt[i];
    if (!(tilt >= 0 && tilt < 30)) continue;
    const v = lr.velUp[i] / Math.cos((tilt * Math.PI) / 180);
    if (!(v > 120)) continue; // below ~120 ft/s drag is too small to read reliably
    // average the 500 Hz accelerometer over +/- 0.05 s around this low-rate sample
    const j0 = lowerBound(hr.t, lr.t[i] - 0.05), j1 = lowerBound(hr.t, lr.t[i] + 0.05);
    let s = 0, n = 0;
    for (let j = j0; j < j1; j++) { const x = a.axialAccel[j]; if (Number.isFinite(x)) { s += x; n++; } }
    if (!n) continue;
    const decel = -(s / n) * G0; // ft/s^2 of drag
    if (!(decel > 0)) continue;
    const tempR = padTempR - LAPSE * Math.max(0, a.altSmooth[i]);
    const rho = (lr.pressAtm[i] * 2116.22) / (R_AIR * tempR);
    const cd = (2 * slugs * decel) / (rho * v * v * area);
    if (!Number.isFinite(cd) || cd <= 0 || cd > 3) continue;
    const mach = v / Math.sqrt(GAMMA * R_AIR * tempR);
    out.t.push(lr.t[i]); out.mach.push(mach); out.cd.push(cd);
    out.machMin = Math.min(out.machMin, mach); out.machMax = Math.max(out.machMax, mach);
  }
  out.n = out.cd.length;
  if (out.n < 10) return null;
  const sorted = [...out.cd].sort((x, y) => x - y);
  out.cd50 = sorted[Math.floor(sorted.length / 2)];
  return out;
}
