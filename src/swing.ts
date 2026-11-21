// Motion under canopy from the high-rate gyro and the logged tilt: how far the rocket hangs from
// vertical, how much it swings, how fast it swings (period) and how fast it spins about its own
// axis. Big swings or fast spin under a chute point at line twist, a chute too small for the
// load or a riser attached off center.

import type { BlueRavenFlight } from "./parsers/blueRaven";
import type { DescentPhase } from "./descent";

export interface Swing {
  name: string;
  /** median angle from vertical, deg */
  hangDeg: number;
  /** half the 10th-to-90th percentile spread of the tilt, deg */
  swingDeg: number;
  /** RMS of the two cross-axis gyro rates, deg/s */
  crossRms: number;
  /** dominant swing period from zero crossings of the tilt, s (null if unclear) */
  periodS: number | null;
  /** mean absolute spin about the rocket axis, deg/s (and rev/s) */
  spinDps: number;
  /** gyro barely moves at all: the log may have frozen rather than the rocket hanging still */
  frozen: boolean;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};

export function canopySwing(f: BlueRavenFlight, phases: DescentPhase[]): Swing[] {
  const hr = f.hr, lr = f.lr;
  if (!hr || !lr) return [];
  const out: Swing[] = [];
  for (const p of phases) {
    // skip the first 2 s after the phase starts: the opening shock is not swing
    const t0 = p.t0 + 2, t1 = p.t1;
    if (t1 - t0 < 4) continue;
    const tilt: number[] = [];
    for (let i = 0; i < lr.n; i++) if (lr.t[i] >= t0 && lr.t[i] <= t1 && Number.isFinite(lr.tilt[i])) tilt.push(lr.tilt[i]);
    const ts: number[] = [], gx: number[] = [], gy: number[] = [], gz: number[] = [];
    for (let i = 0; i < hr.n; i++) {
      if (hr.t[i] < t0 || hr.t[i] > t1) continue;
      ts.push(hr.t[i]); gx.push(hr.gyro[i * 3]); gy.push(hr.gyro[i * 3 + 1]); gz.push(hr.gyro[i * 3 + 2]);
    }
    if (ts.length < 200 || tilt.length < 20) continue;
    const n = ts.length;
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const my = mean(gy), mz = mean(gz);
    let cross = 0;
    for (let i = 0; i < n; i++) cross += (gy[i] - my) ** 2 + (gz[i] - mz) ** 2;
    const crossRms = Math.sqrt(cross / n);
    const spinDps = gx.reduce((s, v) => s + Math.abs(v), 0) / n;
    // period from the tilt itself (the body-axis rates are mixed up by spin): smooth over 0.2 s,
    // remove a 6 s running mean, count sign changes beyond half a degree
    const tt: number[] = [];
    for (let i = 0; i < lr.n; i++) if (lr.t[i] >= t0 && lr.t[i] <= t1 && Number.isFinite(lr.tilt[i])) tt.push(lr.t[i]);
    const dt = (tt[tt.length - 1] - tt[0]) / Math.max(1, tt.length - 1);
    const box = (a: number[], w: number) => {
      const h = Math.max(1, Math.round(w / dt / 2)), o = new Array(a.length).fill(0);
      let sum = 0, lo = 0, hi = -1;
      for (let i = 0; i < a.length; i++) {
        while (hi < Math.min(a.length - 1, i + h)) sum += a[++hi];
        while (lo < i - h) sum -= a[lo++];
        o[i] = sum / (hi - lo + 1);
      }
      return o;
    };
    const sm = box(tilt, 0.2), trend = box(sm, 6);
    let crossings = 0, prev = 0;
    for (let i = 0; i < sm.length; i++) {
      const v = sm[i] - trend[i];
      const sgn = Math.abs(v) < 0.5 ? 0 : Math.sign(v);
      if (sgn !== 0 && prev !== 0 && sgn !== prev) crossings++;
      if (sgn !== 0) prev = sgn;
    }
    const span = tt[tt.length - 1] - tt[0];
    const periodS = crossings >= 4 ? (2 * span) / crossings : null;
    const frozen = crossRms < 3 && spinDps < 3 && pct(tilt, 0.9) - pct(tilt, 0.1) < 2;
    out.push({
      name: p.name,
      hangDeg: pct(tilt, 0.5),
      swingDeg: (pct(tilt, 0.9) - pct(tilt, 0.1)) / 2,
      crossRms, periodS, spinDps, frozen,
    });
  }
  return out;
}
