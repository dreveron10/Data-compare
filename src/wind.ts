// Wind profile estimated from the GPS drift under parachute.
// Once a parachute is open and settled, the rocket moves sideways at about the wind speed,
// so the horizontal GPS velocity at each altitude is a measure of the wind there.
import type { Analysis } from "./analysis";
import type { GpsData } from "./parsers/featherweightGps";

export interface WindBin {
  lo: number; // ft AGL
  hi: number;
  vE: number; // ft/s toward east
  vN: number; // ft/s toward north
  speed: number; // ft/s
  fromDeg: number; // direction the wind comes FROM, degrees true
  n: number;
}

export interface WindProfile {
  bins: WindBin[]; // top to bottom
  mean: { speed: number; fromDeg: number };
  binSize: number;
  samples: number;
}

/** seconds skipped after each deployment while the parachute inflates and swings */
const SETTLE_S = 4;

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compassName = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

const fromOf = (vE: number, vN: number) => ((Math.atan2(vE, vN) * 180) / Math.PI + 180 + 360) % 360;

export function windProfile(g: GpsData, a: Analysis): WindProfile | null {
  const al = a.gps;
  if (!al) return null;
  const t = al.t;
  const apo = a.events.find((e) => e.key === "apogee")?.t ?? al.apogeeT;
  const land = al.landingT ?? a.events.find((e) => e.key === "landing")?.t ?? t[g.n - 1];
  const fires = a.events.filter((e) => e.key.startsWith("fire_") && e.t >= apo - 1).map((e) => e.t);
  // start once the first parachute after apogee has settled; before that the rocket still
  // carries its own sideways speed from the ascent
  const start = Math.max(apo + 2, (fires.length ? Math.min(...fires) : apo) + SETTLE_S);
  const settled = (x: number) => x > start && x < land - 1 && !fires.some((f) => x >= f && x < f + SETTLE_S);

  // horizontal velocity from position over a +/-1 s window (works at 1 Hz or 10 Hz GPS)
  const pts: { alt: number; vE: number; vN: number }[] = [];
  let k = 0, j = 0;
  for (let i = 0; i < g.n; i++) {
    if (!settled(t[i]) || g.fix[i] === 0) continue;
    while (k < i && t[k] < t[i] - 1) k++;
    if (j < i) j = i;
    while (j < g.n - 1 && t[j] < t[i] + 1) j++;
    const dt = t[j] - t[k];
    if (dt < 0.5 || dt > 4) continue;
    const vE = (g.east[j] - g.east[k]) / dt;
    const vN = (g.north[j] - g.north[k]) / dt;
    if (!Number.isFinite(vE + vN) || Math.hypot(vE, vN) > 150) continue; // GPS glitch
    pts.push({ alt: g.altAgl[i], vE, vN });
  }
  if (pts.length < 6) return null;

  const top = Math.max(...pts.map((p) => p.alt));
  const binSize = [100, 200, 250, 500, 1000, 2000].find((s) => top / s <= 10) ?? 2000;
  const bins: WindBin[] = [];
  for (let lo = Math.floor(top / binSize) * binSize; lo >= 0; lo -= binSize) {
    const inBin = pts.filter((p) => p.alt >= lo && p.alt < lo + binSize);
    if (inBin.length < 3) continue;
    const vE = inBin.reduce((s, p) => s + p.vE, 0) / inBin.length;
    const vN = inBin.reduce((s, p) => s + p.vN, 0) / inBin.length;
    bins.push({ lo: Math.max(0, lo), hi: lo + binSize, vE, vN, speed: Math.hypot(vE, vN), fromDeg: fromOf(vE, vN), n: inBin.length });
  }
  if (!bins.length) return null;
  // mean weighted by altitude band, so slow main-chute samples don't dominate
  const mE = bins.reduce((s, b) => s + b.vE, 0) / bins.length;
  const mN = bins.reduce((s, b) => s + b.vN, 0) / bins.length;
  return { bins, mean: { speed: Math.hypot(mE, mN), fromDeg: fromOf(mE, mN) }, binSize, samples: pts.length };
}
