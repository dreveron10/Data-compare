// Flight analysis: events, metrics, and the 3D frame alignment used by the replay.

import { Matrix4, Quaternion, Vector3 } from "three";
import type { BlueRavenFlight, Channel, HRData, LRData } from "./parsers/blueRaven";
import type { GpsData } from "./parsers/featherweightGps";
import { CHANNELS } from "./parsers/blueRaven";

export interface FlightEvent {
  key: string;
  label: string;
  t: number;
  color: string;
}

export interface Metric {
  label: string;
  unit: string;
  site: number | null;
  device: number | null; // value the Blue Raven itself reported, when available
  note?: string;
}

export interface Analysis {
  tStart: number;
  tEnd: number;
  events: FlightEvent[];
  padAsl: number;
  metrics: Metric[];
  // derived LR series
  altSmooth: Float32Array;
  baroVel: Float32Array;
  totalVel: Float32Array;
  // derived HR series
  axialAccel?: Float32Array; // g along the rocket axis
  accelMag?: Float32Array;
  rollRate?: Float32Array; // deg/s about the rocket axis
  // 3D replay
  frame?: ReplayFrame;
  path: { t: Float64Array; x: Float32Array; y: Float32Array; z: Float32Array; apogeeIdx: number };
  /** true when the scene is in true east/north (GPS aligned); otherwise downrange/crossrange */
  compass: boolean;
  gps?: GpsAlignment;
  warnings: string[];
}

export interface GpsAlignment {
  /** Blue Raven time = GPS time + offset */
  offset: number;
  autoOffset: number;
  manual: boolean;
  /** rotation applied to the Blue Raven horizontal frame to reach east/north, rad */
  yaw: number;
  /** RMS horizontal mismatch between the rotated Blue Raven ascent and the GPS track, ft */
  ascentRms: number;
  /** GPS time in Blue Raven time */
  t: Float64Array;
  /** GPS track in world coordinates */
  x: Float32Array; y: Float32Array; z: Float32Array;
  /** GPS series resampled on the LR time base (NaN outside the GPS log) */
  altOnLR: Float32Array;
  vertVOnLR: Float32Array;
  apogeeAgl: number;
  apogeeT: number;
  landingT: number | null;
  landing: { lat: number; lon: number; distance: number; bearing: number };
  rows: CompareRow[];
}

export interface CompareRow {
  label: string;
  unit: string;
  br: number | null;
  gps: number | null;
  note?: string;
}

export interface ReplayFrame {
  /** world orientation per HR sample (x,y,z,w interleaved, three.js order) */
  worldQuat: Float32Array;
  /** sign applied to crossrange so position and attitude share one right-handed frame */
  crSign: number;
  /** how well attitude azimuth matched the inertial velocity during ascent (0..1) */
  fitQuality: number;
  convention: "q" | "q*";
}

// ---------- small numeric helpers ----------

export function lowerBound(a: ArrayLike<number>, x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1; else hi = m;
  }
  return lo;
}

/** index of the sample at or just before x (clamped) */
export function indexAt(a: ArrayLike<number>, x: number): number {
  const i = lowerBound(a, x);
  if (i <= 0) return 0;
  if (i >= a.length) return a.length - 1;
  return a[i] === x ? i : i - 1;
}

/** running median, window 2*half+1 samples; removes ejection pressure spikes */
function runningMedian(src: Float32Array, half: number): Float32Array {
  const out = new Float32Array(src.length);
  const w: number[] = [];
  for (let i = 0; i < src.length; i++) {
    w.length = 0;
    for (let k = -half; k <= half; k++) w.push(src[Math.min(src.length - 1, Math.max(0, i + k))]);
    w.sort((a, b) => a - b);
    out[i] = w[half];
  }
  return out;
}

function movingAvg(src: Float32Array, half: number): Float32Array {
  const out = new Float32Array(src.length);
  let sum = 0, cnt = 0;
  // running window [i-half, i+half]
  for (let i = 0; i < Math.min(src.length, half); i++) { sum += src[i]; cnt++; }
  for (let i = 0; i < src.length; i++) {
    const add = i + half, rem = i - half - 1;
    if (add < src.length) { sum += src[add]; cnt++; }
    if (rem >= 0) { sum -= src[rem]; cnt--; }
    out[i] = sum / cnt;
  }
  return out;
}

function derivative(t: ArrayLike<number>, y: Float32Array, halfSpan: number): Float32Array {
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) {
    const a = Math.max(0, i - halfSpan), b = Math.min(y.length - 1, i + halfSpan);
    const dt = t[b] - t[a];
    out[i] = dt > 0 ? (y[b] - y[a]) / dt : 0;
  }
  return out;
}

/** least squares slope of y over t within [t0, t1] */
function slope(t: ArrayLike<number>, y: ArrayLike<number>, t0: number, t1: number): number | null {
  let n = 0, st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = lowerBound(t, t0); i < t.length && t[i] <= t1; i++) {
    n++; st += t[i]; sy += y[i]; stt += t[i] * t[i]; sty += t[i] * y[i];
  }
  if (n < 5) return null;
  const d = n * stt - st * st;
  return d === 0 ? null : (n * sty - st * sy) / d;
}

function firstRise(flag: Uint8Array | undefined, t: Float64Array, after = -Infinity): number | null {
  if (!flag) return null;
  for (let i = 1; i < flag.length; i++) if (flag[i] && !flag[i - 1] && t[i] >= after) return t[i];
  if (flag[0] && t[0] >= after) return t[0];
  return null;
}

const v3 = (a: ArrayLike<number>, i: number) => new Vector3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);

// ---------- main analysis ----------

export interface AnalyzeOptions {
  /** force the GPS time offset (s); auto-detected when omitted */
  gpsOffset?: number;
}

export function analyze(f: BlueRavenFlight, opts: AnalyzeOptions = {}): Analysis {
  const lr = f.lr;
  const hr = f.hr;
  const warnings: string[] = [];
  if (!lr) throw new Error("A Blue Raven LR file is required (it has the baro altitude and flight events).");

  // AGL referenced to the pad altitude the Blue Raven reports, so apogee matches its own definition
  const padAsl = f.summary?.num["Pad altitude ASL"] ?? lr.baroAsl[0] - lr.baroAgl[0];
  const agl = new Float32Array(lr.n);
  for (let i = 0; i < lr.n; i++) agl[i] = lr.baroAsl[i] - padAsl;
  // 1 s running median (kills ejection pressure spikes, no lag on steady climbs) then 0.2 s average
  const altSmooth = movingAvg(runningMedian(agl, 25), 5);
  const baroVel = derivative(lr.t, altSmooth, 12); // ~0.5 s span
  const totalVel = new Float32Array(lr.n);
  for (let i = 0; i < lr.n; i++) totalVel[i] = Math.hypot(lr.velUp[i], lr.velDR[i], lr.velCR[i]);

  // ----- events -----
  const ev: FlightEvent[] = [];
  const push = (key: string, label: string, t: number | null, color: string) => {
    if (t !== null && Number.isFinite(t)) ev.push({ key, label, t, color });
  };
  const liftoff = firstRise(lr.flags["Liftoff"], lr.t) ?? 0;
  push("liftoff", "Liftoff", liftoff, "#7bd88f");
  const burnout = firstRise(lr.flags["Burnout_Coast"], lr.t, liftoff);
  push("burnout", "Burnout", burnout, "#f5c26b");

  // apogee: peak of smoothed baro altitude, searched within 2 s of the inertial apogee
  // (pressure transients from separation can otherwise look like a higher peak)
  let iIn = lowerBound(lr.t, liftoff);
  for (let i = iIn; i < lr.n; i++) if (lr.inAlt[i] > lr.inAlt[iIn]) iIn = i;
  const win0 = lr.t[iIn] - 2, win1 = lr.t[iIn] + 2;
  let iApo = lowerBound(lr.t, Math.max(liftoff, win0));
  for (let i = iApo; i < lr.n && lr.t[i] <= win1; i++) if (altSmooth[i] > altSmooth[iApo]) iApo = i;
  const tApo = lr.t[iApo];
  push("apogee", "Apogee", tApo, "#ff7a90");
  const devApogee = firstRise(lr.flags["Apogee"], lr.t, liftoff);
  if (devApogee !== null) push("apogee_det", "Apogee detect", devApogee, "#ff9eb0");

  const fireColors: Record<Channel, string> = { Apo: "#e86bff", Main: "#5cc8ff", "3rd": "#b48cff", "4th": "#7aa2ff" };
  // Fire time, best source first: the Blue Raven's own summary, then the moment a channel with
  // continuity drops below 1 V, then the LR "fired" flag (which lags the actual fire by ~1.4 s).
  const summaryKey: Record<Channel, string> = {
    Apo: "Time to Apo channel fire", Main: "Time to main channel fire",
    "3rd": "Time to third channel fire", "4th": "Time to fourth channel fire",
  };
  const fireT: Partial<Record<Channel, number>> = {};
  const fireSource: Partial<Record<Channel, string>> = {};
  for (const ch of CHANNELS) {
    const flagT = firstRise(lr.flags[`${ch}_fired`], lr.t, liftoff);
    if (flagT === null) continue; // channel never fired
    const sv = f.summary?.num[summaryKey[ch]];
    let t: number | null = null;
    if (sv !== undefined && sv > 0) { t = liftoff + sv; fireSource[ch] = "Blue Raven summary"; }
    if (t === null) {
      const v = lr.chanV[ch];
      const padV = v[Math.max(0, lowerBound(lr.t, liftoff) - 1)];
      if (padV > 1) {
        for (let i = lowerBound(lr.t, liftoff); i < lr.n && lr.t[i] <= flagT; i++) {
          if (v[i] < 1) { t = lr.t[i]; fireSource[ch] = "continuity drop"; break; }
        }
      }
    }
    if (t === null) { t = flagT; fireSource[ch] = "LR fired flag (lags ~1.4 s)"; }
    fireT[ch] = t;
    push(`fire_${ch}`, `${ch} fired`, t, fireColors[ch]);
  }

  // landing: after the last deployment, first time the rocket stays within 5 ft of its final altitude for 2 s
  const lastFire = Math.max(tApo, ...Object.values(fireT).filter((x): x is number => x !== undefined));
  const iEndAvg = lowerBound(lr.t, lr.t[lr.n - 1] - 2);
  let finalAlt = 0, c = 0;
  for (let i = iEndAvg; i < lr.n; i++) { finalAlt += altSmooth[i]; c++; }
  finalAlt /= Math.max(1, c);
  let tLand: number | null = null;
  for (let i = lowerBound(lr.t, lastFire); i < lr.n; i++) {
    if (Math.abs(altSmooth[i] - finalAlt) < 5) {
      const j = lowerBound(lr.t, lr.t[i] + 2);
      let ok = true;
      for (let k = i; k < Math.min(j, lr.n); k++) if (Math.abs(altSmooth[k] - finalAlt) >= 5) { ok = false; break; }
      if (ok) { tLand = lr.t[i]; break; }
    }
  }
  push("landing", "Landing", tLand, "#cfd6e4");
  ev.sort((a, b) => a.t - b.t);

  // ----- HR derived -----
  let axialAccel: Float32Array | undefined;
  let accelMag: Float32Array | undefined;
  let rollRate: Float32Array | undefined;
  let axisB = new Vector3(1, 0, 0);
  let upR = new Vector3(1, 0, 0);
  if (hr) {
    ({ axisB, upR } = padFrame(f, hr));
    axialAccel = new Float32Array(hr.n);
    accelMag = new Float32Array(hr.n);
    rollRate = new Float32Array(hr.n);
    for (let i = 0; i < hr.n; i++) {
      const a = v3(hr.accel, i), g = v3(hr.gyro, i);
      axialAccel[i] = a.dot(axisB);
      accelMag[i] = a.length();
      rollRate[i] = g.dot(axisB);
    }
  } else {
    warnings.push("No HR file loaded: 3D attitude, roll rate and acceleration are unavailable.");
  }

  // ----- metrics -----
  const S = f.summary?.num ?? {};
  const dev = (k: string) => (k in S ? S[k] : null);
  const maxOver = (a: ArrayLike<number>, t: ArrayLike<number>, t0: number, t1: number) => {
    let m = -Infinity;
    for (let i = lowerBound(t, t0); i < t.length && t[i] <= t1; i++) if (a[i] > m) m = a[i];
    return Number.isFinite(m) ? m : null;
  };
  const minOver = (a: ArrayLike<number>, t: ArrayLike<number>, t0: number, t1: number) => {
    let m = Infinity;
    for (let i = lowerBound(t, t0); i < t.length && t[i] <= t1; i++) if (a[i] < m) m = a[i];
    return Number.isFinite(m) ? m : null;
  };

  const tMain = fireT.Main ?? null;
  const drogueRate = tMain !== null ? slope(lr.t, altSmooth, tApo + 3, tMain - 0.5) : null;
  const mainRate = tMain !== null && tLand !== null ? slope(lr.t, altSmooth, tMain + 4, tLand - 1) : null;
  const mainAlt = tMain !== null ? altSmooth[indexAt(lr.t, tMain)] : null;

  const metrics: Metric[] = [
    { label: "Apogee (baro)", unit: "ft AGL", site: altSmooth[iApo], device: dev("Max Altitude"),
      note: "Peak of median + 0.2 s average filtered baro altitude" },
    { label: "Apogee (inertial)", unit: "ft", site: maxOver(lr.inAlt, lr.t, liftoff, tApo + 5), device: dev("Inertial navigation max alt") },
    { label: "Time to apogee", unit: "s", site: tApo - liftoff, device: null },
    { label: "Max velocity", unit: "ft/s", site: maxOver(totalVel, lr.t, liftoff, tApo), device: dev("Max velocity"),
      note: "Magnitude of the Blue Raven inertial velocity" },
    { label: "Burnout time", unit: "s", site: burnout !== null ? burnout - liftoff : null, device: dev("Time to first burnout") },
    { label: "Max boost accel", unit: "g", site: axialAccel && hr ? maxOver(axialAccel, hr.t, liftoff, (burnout ?? liftoff + 3) + 0.2) : null,
      device: dev("Max motor burn acceleration"), note: "Axial accel from the HR file" },
    { label: "Tilt at burnout", unit: "deg", site: burnout !== null ? lr.tilt[indexAt(lr.t, burnout)] : null, device: dev("Tilt angle at burnout") },
    { label: "Max roll rate (ascent)", unit: "deg/s", site: rollRate && hr ? maxAbs(rollRate, hr.t, liftoff, tApo) : null, device: null },
    { label: "Ascent rolls", unit: "rev", site: Math.abs(lr.rollAngle[iApo] - lr.rollAngle[indexAt(lr.t, liftoff)]) / 360, device: dev("Number of ascent rolls") },
    { label: "Horiz. velocity at apogee", unit: "ft/s", site: Math.hypot(lr.velDR[iApo], lr.velCR[iApo]), device: dev("Horiz. velocity at apogee") },
    { label: "Drogue descent rate", unit: "ft/s", site: drogueRate, device: dev("Drogue descent rate"), note: "Linear fit, apogee + 3 s to main fire" },
    { label: "Main deploy altitude", unit: "ft AGL", site: mainAlt, device: dev("Main chute deploy altitude") },
    { label: "Main descent rate", unit: "ft/s", site: mainRate, device: dev("Main chute descent rate"), note: "Linear fit, main fire + 4 s to landing" },
    { label: "Flight time", unit: "s", site: tLand !== null ? tLand - liftoff : null, device: null },
    { label: "Min battery", unit: "V", site: minOver(lr.battV, lr.t, liftoff, lr.t[lr.n - 1]), device: dev("Min Battery voltage") },
  ];
  if (hr && accelMag) {
    metrics.push({ label: "Peak shock after apogee", unit: "g", site: maxOver(accelMag, hr.t, tApo, hr.t[hr.n - 1]), device: null,
      note: "Largest accel magnitude after apogee, usually a deployment shock" });
  }
  for (const ch of CHANNELS) {
    if (fireT[ch] === undefined) continue;
    metrics.push({ label: `${ch} fire time`, unit: "s", site: fireT[ch]! - liftoff, device: dev(summaryKey[ch]),
      note: `Source: ${fireSource[ch]}` });
  }

  // ----- 3D path (feet, three.js world: x = downrange, y = up, z = -crossrange*sign) -----
  const frame = hr ? solveFrame(hr, lr, axisB, upR, liftoff, tApo, burnout) : undefined;
  if (frame && frame.fitQuality < 0.5) {
    warnings.push(`Attitude to trajectory alignment is weak (fit ${(frame.fitQuality * 100).toFixed(0)}%). The rocket heading in 3D may be off; tilt and roll are still correct.`);
  }
  const crSign = frame?.crSign ?? 1;
  const px = new Float32Array(lr.n), py = new Float32Array(lr.n), pz = new Float32Array(lr.n);
  for (let i = 0; i < lr.n; i++) {
    const k = Math.min(i, iApo); // horizontal inertial position drifts after apogee: hold it
    px[i] = lr.t[i] < liftoff ? 0 : lr.inDR[k];
    pz[i] = lr.t[i] < liftoff ? 0 : -crSign * lr.inCR[k];
    py[i] = Math.max(0, altSmooth[i]);
  }

  // ----- GPS: time alignment, true north, real descent drift -----
  let gpsA: GpsAlignment | undefined;
  if (f.gps) {
    try {
      gpsA = alignGps(f.gps, lr, gpsCtx(), opts);
      // rotate the Blue Raven frame into east/north and blend the ascent into the GPS track
      const c = Math.cos(gpsA.yaw), sn = Math.sin(gpsA.yaw);
      const rot = (i: number) => {
        const u = px[i], v = -pz[i];
        return [u * c - v * sn, u * sn + v * c];
      };
      const tApoL = lr.t[iApo];
      const gApo = gpsUV(f.gps, gpsA, tApoL);
      const [ua, va] = rot(iApo);
      const cu = gApo[0] - ua, cv = gApo[1] - va;
      for (let i = 0; i < lr.n; i++) {
        let u: number, v: number;
        if (lr.t[i] < liftoff) { u = 0; v = 0; }
        else if (i <= iApo) {
          const w = Math.min(1, Math.max(0, (lr.t[i] - liftoff) / Math.max(0.1, tApoL - liftoff)));
          [u, v] = rot(i);
          u += cu * w; v += cv * w;
        } else {
          [u, v] = gpsUV(f.gps, gpsA, lr.t[i]);
        }
        px[i] = u; pz[i] = -v;
      }
      if (frame) {
        const qYaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), gpsA.yaw);
        const q = new Quaternion();
        for (let i = 0; i < frame.worldQuat.length / 4; i++) {
          q.set(frame.worldQuat[i * 4], frame.worldQuat[i * 4 + 1], frame.worldQuat[i * 4 + 2], frame.worldQuat[i * 4 + 3]);
          q.premultiply(qYaw);
          frame.worldQuat[i * 4] = q.x; frame.worldQuat[i * 4 + 1] = q.y; frame.worldQuat[i * 4 + 2] = q.z; frame.worldQuat[i * 4 + 3] = q.w;
        }
      }
      // some mismatch is normal (inertial position drifts); a large one means the logs do not belong together
      const gpsApoDist = gpsA.rows.find((r) => r.label === "Distance at apogee")?.gps ?? 0;
      if (gpsA.ascentRms > Math.max(400, 0.35 * gpsApoDist)) {
        warnings.push(`Blue Raven and GPS ascent tracks differ by ${gpsA.ascentRms.toFixed(0)} ft RMS after alignment. Check that both logs are from the same flight and the time offset.`);
      }
    } catch (e) {
      warnings.push(`GPS log could not be aligned: ${(e as Error).message}`);
      gpsA = undefined;
    }
  }

  function gpsCtx() {
    return { liftoff, tApo, burnout, iApo, altSmooth, crSign, drogueWin: tMain !== null ? [tApo + 3, tMain - 0.5] as [number, number] : null,
      mainWin: tMain !== null && tLand !== null ? [tMain + 4, tLand - 1] as [number, number] : null, totalVel };
  }

  return {
    compass: !!gpsA,
    gps: gpsA,
    tStart: Math.max(lr.t[0], hr ? hr.t[0] : -Infinity),
    tEnd: Math.min(lr.t[lr.n - 1], hr ? hr.t[hr.n - 1] : Infinity),
    events: ev, padAsl, metrics, altSmooth, baroVel, totalVel, axialAccel, accelMag, rollRate, frame,
    path: { t: lr.t, x: px, y: py, z: pz, apogeeIdx: iApo },
    warnings,
  };
}

function maxAbs(a: Float32Array, t: Float64Array, t0: number, t1: number) {
  let m = 0;
  for (let i = lowerBound(t, t0); i < t.length && t[i] <= t1; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

/** Rocket axis in the sensor frame, and "up" in the pad reference frame. */
function padFrame(f: BlueRavenFlight, hr: HRData): { axisB: Vector3; upR: Vector3 } {
  const pad = new Vector3();
  let n = 0;
  for (let i = 0; i < hr.n && hr.t[i] < -0.3; i++) { pad.add(v3(hr.accel, i)); n++; }
  if (n === 0) pad.set(1, 0, 0);
  const upR = pad.normalize();
  const dm = f.summary?.vec["Direction of 1st motion"];
  const axisB = dm ? new Vector3(...dm).normalize() : upR.clone();
  return { axisB, upR };
}

function rotByQuat(q: Quaternion, v: Vector3) {
  return v.clone().applyQuaternion(q);
}

/**
 * Find the rotation from the Blue Raven pad reference frame into the world frame used for the path.
 * The quaternions are relative to the pad attitude and carry no compass heading, so the heading
 * is found by matching the rocket axis azimuth to the inertial velocity azimuth during ascent.
 * Both quaternion conventions and both crossrange signs are tried; the best fit wins.
 */
function solveFrame(
  hr: HRData, lr: LRData, axisB: Vector3, upR: Vector3, liftoff: number, tApo: number, burnout: number | null,
): ReplayFrame {
  // basis of the reference frame: e1 horizontal, upR up, e3 = e1 x up  -> world X, Y, Z
  const trial = Math.abs(upR.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const e1 = trial.sub(upR.clone().multiplyScalar(trial.dot(upR))).normalize();
  const e3 = new Vector3().crossVectors(e1, upR).normalize();
  const basis = new Matrix4().makeBasis(e1, upR, e3); // world -> ref
  const qB = new Quaternion().setFromRotationMatrix(basis).invert(); // ref -> world

  const t0 = liftoff + 0.3;
  const t1 = Math.min(tApo - 0.5, (burnout ?? liftoff + 3) + 0.6 * (tApo - (burnout ?? liftoff + 3)));
  type Cand = { conv: "q" | "q*"; s: number; delta: number; R: number };
  const cands: Cand[] = [];
  for (const conv of ["q", "q*"] as const) {
    for (const s of [1, -1]) {
      let cx = 0, cy = 0, wsum = 0;
      for (let i = lowerBound(lr.t, t0); i < lr.n && lr.t[i] <= t1; i++) {
        const vh = Math.hypot(lr.velDR[i], lr.velCR[i]);
        if (vh < 15) continue;
        const k = indexAt(hr.t, lr.t[i]);
        const q = quatAt(hr, k, conv);
        const w = rotByQuat(q, axisB).applyQuaternion(qB);
        const hmag = Math.hypot(w.x, w.z);
        if (hmag < 0.03) continue;
        const azAxis = Math.atan2(-w.z, w.x);
        const azVel = Math.atan2(s * lr.velCR[i], lr.velDR[i]);
        const d = azVel - azAxis;
        const wt = Math.min(vh, 300) * hmag;
        cx += wt * Math.cos(d); cy += wt * Math.sin(d); wsum += wt;
      }
      const R = wsum > 0 ? Math.hypot(cx, cy) / wsum : 0;
      cands.push({ conv, s, delta: Math.atan2(cy, cx), R });
    }
  }
  cands.sort((a, b) => b.R - a.R);
  const best = cands[0].R > 0 ? cands[0] : { conv: "q" as const, s: 1, delta: 0, R: 0 };

  const qYaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), best.delta);
  const qFrame = qYaw.multiply(qB); // ref -> world, with heading
  // model space: rocket built along +Y. Map model +Y to the sensor's rocket axis.
  const q0 = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axisB);

  const out = new Float32Array(hr.n * 4);
  const tmp = new Quaternion();
  for (let i = 0; i < hr.n; i++) {
    tmp.copy(qFrame).multiply(quatAt(hr, i, best.conv)).multiply(q0);
    out[i * 4] = tmp.x; out[i * 4 + 1] = tmp.y; out[i * 4 + 2] = tmp.z; out[i * 4 + 3] = tmp.w;
  }
  return { worldQuat: out, crSign: best.s, fitQuality: best.R, convention: best.conv };
}

function quatAt(hr: HRData, i: number, conv: "q" | "q*") {
  const w = hr.quat[i * 4], x = hr.quat[i * 4 + 1], y = hr.quat[i * 4 + 2], z = hr.quat[i * 4 + 3];
  const q = new Quaternion(x, y, z, w).normalize();
  return conv === "q" ? q : q.invert();
}

// ---------- GPS alignment ----------

function interp(t: ArrayLike<number>, y: ArrayLike<number>, x: number): number {
  if (x <= t[0]) return y[0];
  const n = t.length;
  if (x >= t[n - 1]) return y[n - 1];
  const i = lowerBound(t, x);
  const t0 = t[i - 1], t1 = t[i];
  const u = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
  return y[i - 1] + (y[i] - y[i - 1]) * u;
}

/** GPS east/north (u, v) at Blue Raven time t */
function gpsUV(g: GpsData, a: { t: Float64Array }, t: number): [number, number] {
  return [interp(a.t, g.east, t), interp(a.t, g.north, t)];
}

interface Ctx {
  liftoff: number; tApo: number; burnout: number | null; iApo: number; altSmooth: Float32Array; crSign: number;
  drogueWin: [number, number] | null; mainWin: [number, number] | null; totalVel: Float32Array;
}

function alignGps(g: GpsData, lr: LRData, c: Ctx, opts: AnalyzeOptions): GpsAlignment {
  // 1) time: both logs are launch-relative; refine by matching vertical velocity during boost and coast
  const tEndFit = Math.min(c.tApo, (c.burnout ?? c.liftoff + 3) + 6);
  let best = 0, bestErr = Infinity;
  for (let d = -3; d <= 3.0001; d += 0.01) {
    let e = 0, n = 0;
    for (let i = lowerBound(lr.t, c.liftoff); i < lr.n && lr.t[i] <= tEndFit; i += 2) {
      const tg = lr.t[i] - d;
      if (tg < g.t[0] || tg > g.t[g.n - 1]) continue;
      const r = interp(g.t, g.vertV, tg) - lr.velUp[i];
      e += r * r; n++;
    }
    if (n > 20 && e / n < bestErr) { bestErr = e / n; best = d; }
  }
  const autoOffset = Math.round(best * 100) / 100;
  const manual = opts.gpsOffset !== undefined && Number.isFinite(opts.gpsOffset);
  const offset = manual ? opts.gpsOffset! : autoOffset;
  const t = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) t[i] = g.t[i] + offset;

  // 2) heading: rotate the Blue Raven (downrange, s*crossrange) plane onto (east, north), least squares
  let sxx = 0, sxy = 0, cnt = 0;
  for (let i = lowerBound(lr.t, c.liftoff + 0.5); i <= c.iApo; i++) {
    if (lr.t[i] < t[0] || lr.t[i] > t[g.n - 1]) continue;
    const bx = lr.inDR[i], by = c.crSign * lr.inCR[i];
    const gx = interp(t, g.east, lr.t[i]), gy = interp(t, g.north, lr.t[i]);
    sxx += bx * gx + by * gy;
    sxy += bx * gy - by * gx;
    cnt++;
  }
  if (cnt < 10) throw new Error("the GPS log does not overlap the Blue Raven ascent");
  const yaw = Math.atan2(sxy, sxx);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  let sq = 0;
  for (let i = lowerBound(lr.t, c.liftoff + 0.5); i <= c.iApo; i++) {
    if (lr.t[i] < t[0] || lr.t[i] > t[g.n - 1]) continue;
    const bx = lr.inDR[i], by = c.crSign * lr.inCR[i];
    const u = bx * cy - by * sy, v = bx * sy + by * cy;
    sq += (u - interp(t, g.east, lr.t[i])) ** 2 + (v - interp(t, g.north, lr.t[i])) ** 2;
  }
  const ascentRms = Math.sqrt(sq / cnt);

  // 3) GPS track in world coordinates (y from GPS altitude AGL)
  const x = new Float32Array(g.n), y = new Float32Array(g.n), z = new Float32Array(g.n);
  for (let i = 0; i < g.n; i++) { x[i] = g.east[i]; y[i] = Math.max(0, g.altAgl[i]); z[i] = -g.north[i]; }

  // 4) resample for charts
  const altOnLR = new Float32Array(lr.n), vertVOnLR = new Float32Array(lr.n);
  for (let i = 0; i < lr.n; i++) {
    const tt = lr.t[i];
    const inside = tt >= t[0] && tt <= t[g.n - 1];
    altOnLR[i] = inside ? interp(t, g.altAgl, tt) : NaN;
    vertVOnLR[i] = inside ? interp(t, g.vertV, tt) : NaN;
  }

  // 5) comparison
  let iA = 0;
  for (let i = 0; i < g.n; i++) if (g.altAgl[i] > g.altAgl[iA]) iA = i;
  let iL = g.n - 1;
  if (g.landingT !== null) iL = Math.max(0, lowerBound(g.t, g.landingT));
  const maxOf = (a: ArrayLike<number>, i0 = 0, i1 = a.length - 1) => { let m = -Infinity; for (let i = i0; i <= i1; i++) if (a[i] > m) m = a[i]; return m; };
  const iLift = lowerBound(lr.t, c.liftoff);
  let brMaxH = 0, brMaxV = 0;
  for (let i = iLift; i <= c.iApo; i++) {
    brMaxH = Math.max(brMaxH, Math.hypot(lr.velDR[i], lr.velCR[i]));
    brMaxV = Math.max(brMaxV, lr.velUp[i]);
  }
  const gSlope = (w: [number, number] | null) => (w ? slopeOf(t, g.altAgl, w[0], w[1]) : null);
  const brSlope = (w: [number, number] | null) => (w ? slopeOf(lr.t, c.altSmooth, w[0], w[1]) : null);
  const landE = g.east[iL], landN = g.north[iL];
  const rows: CompareRow[] = [
    { label: "Apogee AGL", unit: "ft", br: c.altSmooth[c.iApo], gps: g.altAgl[iA], note: "Blue Raven: filtered baro. GPS: GPS altitude above its pad reading." },
    { label: "Time to apogee", unit: "s", br: c.tApo - c.liftoff, gps: t[iA] - c.liftoff },
    { label: "Max vertical velocity", unit: "ft/s", br: brMaxV, gps: maxOf(g.vertV) },
    { label: "Max horizontal velocity", unit: "ft/s", br: brMaxH, gps: maxOf(g.horzV, 0, iA + 5), note: "Ascent only" },
    { label: "Drogue descent rate", unit: "ft/s", br: brSlope(c.drogueWin), gps: gSlope(c.drogueWin), note: "Same time window for both" },
    { label: "Main descent rate", unit: "ft/s", br: brSlope(c.mainWin), gps: gSlope(c.mainWin), note: "Same time window for both" },
    { label: "Distance at apogee", unit: "ft", br: null, gps: Math.hypot(g.east[iA], g.north[iA]) },
    { label: "Drift at landing", unit: "ft", br: null, gps: Math.hypot(landE, landN) },
  ];
  return {
    offset, autoOffset, manual, yaw, ascentRms, t, x, y, z, altOnLR, vertVOnLR,
    apogeeAgl: g.altAgl[iA], apogeeT: t[iA],
    landingT: g.landingT !== null ? g.landingT + offset : null,
    landing: { lat: g.lat[iL], lon: g.lon[iL], distance: Math.hypot(landE, landN), bearing: ((Math.atan2(landE, landN) * 180) / Math.PI + 360) % 360 },
    rows,
  };
}

function slopeOf(t: ArrayLike<number>, y: ArrayLike<number>, t0: number, t1: number): number | null {
  let n = 0, st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = lowerBound(t, t0); i < t.length && t[i] <= t1; i++) {
    n++; st += t[i]; sy += y[i]; stt += t[i] * t[i]; sty += t[i] * y[i];
  }
  if (n < 3) return null;
  const d = n * stt - st * st;
  return d === 0 ? null : (n * sty - st * sy) / d;
}

// ---------- flight phases (for timeline and chart bands) ----------

export interface Phase { name: string; t0: number; t1: number; color: string }

export const PHASE_COLORS: Record<string, string> = {
  "On pad": "#3a4a6b",
  Boost: "#ff7a1a",
  Coast: "#f5c26b",
  "Under drogue": "#b48cff",
  "Under main": "#6cc4ff",
  Landed: "#7bd88f",
};

export function flightPhases(a: Analysis): Phase[] {
  const ev = (k: string) => a.events.find((e) => e.key === k)?.t;
  const lift = ev("liftoff") ?? 0;
  const burn = ev("burnout");
  const apo = ev("apogee");
  const main = ev("fire_Main");
  const land = ev("landing");
  const cuts: [string, number | undefined][] = [
    ["On pad", a.tStart], ["Boost", lift], ["Coast", burn], ["Under drogue", apo],
    ["Under main", main], ["Landed", land],
  ];
  const pts = cuts.filter((c): c is [string, number] => c[1] !== undefined && c[1] >= a.tStart && c[1] <= a.tEnd);
  pts.sort((x, y) => x[1] - y[1]);
  const out: Phase[] = [];
  for (let i = 0; i < pts.length; i++) {
    const t1 = i + 1 < pts.length ? pts[i + 1][1] : a.tEnd;
    if (t1 > pts[i][1]) out.push({ name: pts[i][0], t0: pts[i][1], t1, color: PHASE_COLORS[pts[i][0]] });
  }
  return out;
}
