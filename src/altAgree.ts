// GPS altitude against the Blue Raven baro over the whole flight, both above the pad, on the
// Blue Raven clock. A steady offset is the GPS's own altitude error (often 50 to 150 ft); a
// difference that shows only during the fast climb comes from the motion itself (GPS filtering,
// clock alignment, the baro port); one that drifts under canopy points at the baro or the GPS fix.

export interface AltAgree {
  t: Float64Array; diff: Float32Array;
  median: number; ascent: number | null; descent: number | null; maxAbs: number;
}

const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * @param t Blue Raven times; @param baro baro altitude AGL; @param gps GPS altitude AGL on the same times (NaN where none)
 * @param tLift liftoff, @param tApo apogee, @param tLand landing (or end)
 */
export function altAgree(t: ArrayLike<number>, baro: ArrayLike<number>, gps: ArrayLike<number>, tLift: number, tApo: number, tLand: number): AltAgree | null {
  const tt: number[] = [], dd: number[] = [], up: number[] = [], down: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] < tLift || t[i] > tLand || !Number.isFinite(gps[i]) || !Number.isFinite(baro[i])) continue;
    const d = gps[i] - baro[i];
    tt.push(t[i]); dd.push(d);
    (t[i] <= tApo ? up : down).push(d);
  }
  if (dd.length < 20) return null;
  return {
    t: Float64Array.from(tt), diff: Float32Array.from(dd),
    median: med(dd)!, ascent: med(up), descent: med(down),
    maxAbs: dd.reduce((m, v) => Math.max(m, Math.abs(v)), 0),
  };
}
