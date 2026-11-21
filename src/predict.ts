// Landing what-if: drift down through this flight's measured wind profile from the apogee point,
// at a chosen drogue rate, main altitude and main rate.
import type { WindProfile } from "./wind";

export interface Prediction { east: number; north: number; distance: number; bearing: number; descentS: number }

function windAt(w: WindProfile, h: number): { vE: number; vN: number } {
  const b = w.bins.find((x) => h >= x.lo && h < x.hi);
  if (b) return b;
  // outside the measured bands: use the nearest one
  const top = w.bins[0], bottom = w.bins[w.bins.length - 1];
  return h >= top.hi ? top : bottom;
}

export function predictLanding(
  w: WindProfile,
  start: { east: number; north: number; alt: number },
  mainAlt: number, drogueRate: number, mainRate: number,
): Prediction {
  let e = start.east, n = start.north, t = 0;
  const step = 10; // ft
  for (let h = start.alt; h > 0; h -= step) {
    const dh = Math.min(step, h);
    const rate = h > mainAlt ? drogueRate : mainRate;
    const dt = dh / Math.max(1, rate);
    const v = windAt(w, h - dh / 2);
    e += v.vE * dt; n += v.vN * dt; t += dt;
  }
  return { east: e, north: n, distance: Math.hypot(e, n), bearing: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360, descentS: t };
}
