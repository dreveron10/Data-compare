// Any altimeter that exports a CSV with a time column and an altitude column: Eggtimer, Missile
// Works RRC3, PerfectFlite StratoLogger, Altus Metrum (AltOS), Jolly Logic and others. Columns
// are found by their names, units by the header text, and the brand by tell-tale words.
// The result is an altitude/velocity trace that can be compared against a Blue Raven flight.

export interface AltTrace {
  device: string;
  name: string;
  t: Float64Array; // s, liftoff at 0
  alt: Float32Array; // ft AGL
  vVert: Float32Array; // ft/s
  notes: string[];
}

const BRANDS: [RegExp, string][] = [
  [/eggtimer/i, "Eggtimer"],
  [/rrc3|missile ?works|mwflight/i, "RRC3"],
  [/strato ?logger|perfectflite/i, "StratoLogger"],
  [/altos|altus|state_name|telemega|telemetrum|easymega|easymini/i, "Altus Metrum"],
  [/jolly ?logic|altimeter ?(two|three)/i, "Jolly Logic"],
  [/blue ?raven|featherweight/i, "Featherweight"],
];

function splitter(line: string): (s: string) => string[] {
  if (line.includes("\t")) return (s) => s.split("\t");
  if ((line.match(/;/g) ?? []).length > (line.match(/,/g) ?? []).length) return (s) => s.split(";");
  if (line.includes(",")) return (s) => s.split(",");
  return (s) => s.trim().split(/\s+/);
}
const isNum = (x: string) => x.trim() !== "" && Number.isFinite(Number(x.trim()));

/** true when the text looks like a time + altitude log this parser can read */
export function isGenericAlt(text: string): boolean {
  try { findTable(text); return true; } catch { return false; }
}

function findTable(text: string) {
  const lines = text.split(/\r?\n/);
  for (let h = 0; h < Math.min(lines.length - 3, 80); h++) {
    const line = lines[h];
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const sp = splitter(line);
    const head = sp(line).map((x) => x.trim().replace(/^"|"$/g, ""));
    if (head.length < 2 || head.every(isNum)) continue;
    // the next non-empty lines must be mostly numeric with the same number of fields
    const rows = lines.slice(h + 1, h + 6).filter((l) => l.trim()).map((l) => sp(l));
    if (rows.length < 3 || !rows.every((r) => r.length >= head.length - 1 && r.filter(isNum).length >= 2)) continue;
    const lower = head.map((x) => x.toLowerCase());
    const find = (re: RegExp, not?: RegExp) => lower.findIndex((x) => re.test(x) && !(not && not.test(x)));
    const ti = (() => {
      const exact = lower.findIndex((x) => /^(t|time|time ?\(s(ec)?\)|time_s|seconds|sec)$/.test(x));
      return exact >= 0 ? exact : find(/time|tiempo|zeit|temps|sec|millis|\bms\b/, /clock|utc|date|state/);
    })();
    // prefer filtered or above-ground altitude when the logger gives several
    let ai = find(/f ?alt|filtered.*alt|agl|height/);
    if (ai < 0) ai = find(/alt|height|h[öo]he|altura|hauteur|baro ?alt/, /accel|gps/);
    if (ti < 0 || ai < 0) continue;
    const vi = find(/f ?vel|vel|speed/, /gps|horiz|accel/);
    return { lines, h, sp, head, lower, ti, ai, vi };
  }
  throw new Error("no table with a time column and an altitude column was found");
}

export function parseGenericAlt(text: string, fileName = "altimeter.csv"): AltTrace {
  const { lines, h, sp, head, lower, ti, ai, vi } = findTable(text);
  const notes: string[] = [];
  const all = text.slice(0, 4000);
  const device = BRANDS.find(([re]) => re.test(all))?.[1] ?? "Altimeter";
  const isAltos = device === "Altus Metrum";
  const unitOf = (k: number, metricDefault: boolean) => {
    const x = lower[k];
    if (/\(m\)|_m\b|\bm\b|meter|metre|m\/s/.test(x)) return "m";
    if (/ft|feet|foot/.test(x)) return "ft";
    return metricDefault ? "m" : "ft";
  };
  const altUnit = unitOf(ai, isAltos);
  if (!/ft|feet|\(m\)|_m\b|meter|metre/.test(lower[ai])) notes.push(`${head[ai]}: no unit in the header, read as ${altUnit === "m" ? "meters" : "feet"}.`);
  const tScale = /millis|\bms\b|\(ms\)/.test(lower[ti]) ? 0.001 : 1;
  const kAlt = altUnit === "m" ? 3.28084 : 1;
  const kVel = vi >= 0 ? (unitOf(vi, isAltos) === "m" ? 3.28084 : 1) : 1;

  const T: number[] = [], H: number[] = [], V: number[] = [];
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*[#;]/.test(l)) continue;
    const c = sp(l);
    const tt = Number(c[ti]), aa = Number(c[ai]);
    if (!Number.isFinite(tt) || !Number.isFinite(aa)) continue;
    T.push(tt * tScale); H.push(aa * kAlt); V.push(vi >= 0 ? Number(c[vi]) * kVel : NaN);
  }
  if (T.length < 20) throw new Error(`${fileName}: only ${T.length} usable rows`);
  // a time column with no unit that steps by 5 or more per sample over thousands is milliseconds
  if (tScale === 1) {
    const dts = T.slice(1, 200).map((x, i) => x - T[i]).sort((a, b) => a - b);
    const mdt = dts[Math.floor(dts.length / 2)];
    if (T[T.length - 1] - T[0] > 2000 && mdt >= 5) { for (let i = 0; i < T.length; i++) T[i] /= 1000; notes.push(`${head[ti]} read as milliseconds.`); }
  }
  // ground level: median of the first second of data
  const firstSec = H.filter((_, i) => T[i] - T[0] < 1).sort((a, b) => a - b);
  const ground = firstSec[Math.floor(firstSec.length / 2)];
  for (let i = 0; i < H.length; i++) H[i] -= ground;
  // velocity from the log, or from smoothed altitude
  const hasV = V.some(Number.isFinite);
  if (!hasV) {
    for (let i = 0; i < T.length; i++) {
      let a = i, b = i;
      while (a > 0 && T[i] - T[a] < 0.25) a--;
      while (b < T.length - 1 && T[b] - T[i] < 0.25) b++;
      V[i] = T[b] > T[a] ? (H[b] - H[a]) / (T[b] - T[a]) : 0;
    }
    notes.push("Velocity derived from altitude (the file has no velocity column).");
  }
  // liftoff: first time 20 ft above ground and still climbing a second later
  let lift = 0;
  for (let i = 0; i < T.length; i++) if (H[i] > 20) { lift = T[Math.max(0, i - 1)]; break; }
  const t = new Float64Array(T.length), alt = new Float32Array(T.length), vVert = new Float32Array(T.length);
  for (let i = 0; i < T.length; i++) { t[i] = T[i] - lift; alt[i] = H[i]; vVert[i] = V[i]; }
  return { device, name: `${device}: ${fileName.replace(/\.[^.]+$/, "")}`, t, alt, vVert, notes };
}
