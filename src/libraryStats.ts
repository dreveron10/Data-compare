// Which stored numbers of a saved flight changed after recomputing them (for "Refresh stored numbers").
import type { LibraryEntry } from "./library";

type Stats = LibraryEntry["stats"];

/** plain names for the stored numbers; fields not listed here are not reported */
export const STAT_NAMES: Partial<Record<keyof Stats, string>> = {
  apogee: "apogee", coastCd: "coast Cd", impulseNs: "impulse", maxQ: "max q", maxMach: "max Mach",
  padBattV: "pad battery", minBattV: "lowest battery", dataWarnings: "data warnings", slPass: "SL checks", slOver: "SL checks",
  drogueRate: "drogue rate", mainRate: "main rate", mainAlt: "main altitude", drift: "drift", maxVel: "max velocity", maxAccel: "max accel", flightTime: "flight time",
};
/** readable names of the numbers that differ: 0.5% tolerance on numbers, exact on lists and flags */
export function statChanges(old: Stats, nu: Stats): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(nu) as (keyof Stats)[]) {
    const a = old[key], b = nu[key];
    let same: boolean;
    if (Array.isArray(a) || Array.isArray(b)) same = JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    else if (typeof a === "number" && typeof b === "number") same = Math.abs(a - b) <= Math.max(1e-6, 0.005 * Math.abs(a));
    else same = (a ?? null) === (b ?? null);
    if (!same && STAT_NAMES[key]) out.add(STAT_NAMES[key]!);
  }
  return [...out];
}
