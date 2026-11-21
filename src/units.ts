// Display units. All analysis stays in feet; values are converted only when shown.

export type UnitSystem = "imperial" | "metric";
const KEY = "dc.units";
let current: UnitSystem = (() => {
  try { return localStorage.getItem(KEY) === "metric" ? "metric" : "imperial"; } catch { return "imperial"; }
})();
const listeners: (() => void)[] = [];

export const getUnits = () => current;
export function setUnits(u: UnitSystem) {
  current = u;
  try { localStorage.setItem(KEY, u); } catch { /* ignore */ }
  listeners.forEach((f) => f());
}
export const onUnitsChange = (f: () => void) => listeners.push(f);

const TABLE: Record<string, [number, string]> = {
  "ft": [0.3048, "m"],
  "ft AGL": [0.3048, "m AGL"],
  "ft/s": [0.3048, "m/s"],
  "ft²": [0.09290304, "m²"],
  "ft-lbf": [1.3558179, "J"],
  "lb": [0.45359237, "kg"],
  "mph": [1.609344, "km/h"],
  "in": [2.54, "cm"],
};

/** convert a value in an imperial unit to the current system; other units pass through */
export function conv(v: number, unit: string): [number, string] {
  if (current === "imperial") return [v, unit];
  const t = TABLE[unit];
  return t ? [v * t[0], t[1]] : [v, unit];
}
export const cv = (v: number, unit: string) => conv(v, unit)[0];
export const cu = (unit: string) => conv(1, unit)[1];
/** "1234 ft" or "376 m" */
export function show(v: number | null | undefined, unit: string, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const [x, u] = conv(v, unit);
  return `${x.toFixed(digits)} ${u}`;
}
