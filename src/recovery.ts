// Recovery check: landing kinetic energy per section, descent time, drift and apogee vs target.
// Limits are editable because competition handbooks change year to year.

export interface RecoveryConfig {
  sections: { name: string; massLb: number }[];
  targetApogeeFt: number | null;
  keLimit: number; // ft-lbf per independent section
  descentLimit: number; // s, apogee to touchdown
  driftLimit: number; // ft radius from the pad
}

export const DEFAULT_RECOVERY: RecoveryConfig = {
  sections: [
    { name: "Nose cone + payload", massLb: 12 },
    { name: "Avionics bay + upper body", massLb: 14 },
    { name: "Booster", massLb: 14 },
  ],
  targetApogeeFt: null,
  keLimit: 75,
  descentLimit: 90,
  driftLimit: 2500,
};

const STORE_KEY = "dc.recovery.default";

export function loadDefaultRecovery(): RecoveryConfig {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_RECOVERY, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return structuredClone(DEFAULT_RECOVERY);
}

export function saveDefaultRecovery(c: RecoveryConfig) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

export interface RecoveryInputs {
  apogee: number | null;
  landingSpeed: number | null; // ft/s, positive
  descentTime: number | null; // s
  drift: number | null; // ft, null without GPS
}

const G = 32.174;
export const keOf = (massLb: number, v: number) => 0.5 * (massLb / G) * v * v;
/** fastest landing speed that keeps a section under the KE limit */
export const vMaxFor = (massLb: number, keLimit: number) => Math.sqrt((2 * keLimit * G) / massLb);

export type Verdict = "pass" | "fail" | "na";

export interface RecoveryResult {
  rows: { label: string; sub?: string; value: string; limit: string; verdict: Verdict; note?: string }[];
}

export function evaluate(c: RecoveryConfig, x: RecoveryInputs): RecoveryResult {
  const rows: RecoveryResult["rows"] = [];
  const v = x.landingSpeed;
  for (const s of c.sections) {
    if (!(s.massLb > 0)) continue;
    const ke = v !== null ? keOf(s.massLb, v) : null;
    rows.push({
      label: s.name,
      sub: `${s.massLb} lb, KE at landing`,
      value: ke !== null ? `${ke.toFixed(1)} ft-lbf` : "-",
      limit: `≤ ${c.keLimit}`,
      verdict: ke === null ? "na" : ke <= c.keLimit ? "pass" : "fail",
      note: `Lands under the limit below ${vMaxFor(s.massLb, c.keLimit).toFixed(1)} ft/s`,
    });
  }
  rows.push({
    label: "Descent time",
    value: x.descentTime !== null ? `${x.descentTime.toFixed(1)} s` : "-",
    limit: `≤ ${c.descentLimit} s`,
    verdict: x.descentTime === null ? "na" : x.descentTime <= c.descentLimit ? "pass" : "fail",
    note: "Apogee to touchdown, from the Blue Raven baro",
  });
  rows.push({
    label: "Drift from pad",
    value: x.drift !== null ? `${x.drift.toFixed(0)} ft` : "needs GPS",
    limit: `≤ ${c.driftLimit} ft`,
    verdict: x.drift === null ? "na" : x.drift <= c.driftLimit ? "pass" : "fail",
    note: "GPS landing position vs the pad",
  });
  if (c.targetApogeeFt) {
    const d = x.apogee !== null ? x.apogee - c.targetApogeeFt : null;
    rows.push({
      label: "Apogee vs target",
      value: d !== null ? `${d >= 0 ? "+" : ""}${d.toFixed(0)} ft` : "-",
      limit: `${c.targetApogeeFt} ft`,
      verdict: "na",
      note: d !== null ? `${((Math.abs(d) / c.targetApogeeFt) * 100).toFixed(1)}% off the declared target` : undefined,
    });
  }
  return { rows };
}
