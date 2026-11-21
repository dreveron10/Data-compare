// Rail exit velocity from the accelerometer. On the rail the axial accelerometer reads thrust
// minus drag and friction over mass; the rail itself carries about 1 g of it, so the
// acceleration along the rail is (reading - 1 g). Integrate from first motion until the rocket
// has travelled the rail length.
import type { Analysis } from "./analysis";
import { lowerBound } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";

const G0 = 32.174;
export const SL_MIN_RAIL_EXIT = 52; // ft/s, NASA Student Launch minimum

export interface RailExit { t: number; v: number; start: number }

export function railExit(f: BlueRavenFlight, a: Analysis, travelFt: number): RailExit | null {
  const hr = f.hr, ax = a.axialAccel;
  if (!hr || !ax || !(travelFt > 0)) return null;
  const lift = a.events.find((e) => e.key === "liftoff")?.t ?? 0;
  // first motion: the reading rises clearly above 1 g, searched in the second before the liftoff flag
  let j = lowerBound(hr.t, lift - 1);
  const jl = lowerBound(hr.t, lift + 0.5);
  while (j < jl && ax[j] < 1.15) j++;
  if (j >= jl) return null;
  const start = hr.t[j];
  let v = 0, s = 0;
  for (; j < hr.n - 1; j++) {
    const dt = hr.t[j + 1] - hr.t[j];
    if (!(dt > 0 && dt < 0.05)) continue;
    v = Math.max(0, v + (ax[j] - 1) * G0 * dt);
    s += v * dt;
    if (s >= travelFt) return { t: hr.t[j + 1], v, start };
    if (hr.t[j] - start > 3) break; // never left a rail this short in 3 s: something is off
  }
  return null;
}
