// OpenRocket simulation CSV export (Plot / Export -> "Export data").
// Comment lines start with '#'. The variable header is a comment line such as
//   # Time (s),Altitude (m),Vertical velocity (m/s),...
// and flight events are comment lines interleaved with the data:
//   # Event APOGEE occurred at t=16.45 seconds
// Field separator (comma, semicolon, tab) and units are whatever the user picked, so both are detected.

export interface SimData {
  name: string;
  n: number;
  t: Float64Array; // s, shifted so liftoff is t = 0
  alt?: Float32Array; // ft AGL
  vVert?: Float32Array; // ft/s
  vTotal?: Float32Array; // ft/s
  accVert?: Float32Array; // g
  accTotal?: Float32Array; // g
  east?: Float32Array; // ft
  north?: Float32Array; // ft
  events: { name: string; t: number; detail: string }[];
  columns: string[];
}

export function isOpenRocket(text: string): boolean {
  const head = text.slice(0, 4000);
  return /Time \(s\)/.test(head) && (/^#/m.test(head) || /Altitude \(/.test(head)) && /Altitude/.test(head);
}

const LEN: Record<string, number> = { m: 3.28084, ft: 1, km: 3280.84, mi: 5280, in: 1 / 12, cm: 0.0328084, mm: 0.00328084, yd: 3, nmi: 6076.12 };
const VEL: Record<string, number> = { "m/s": 3.28084, "ft/s": 1, "km/h": 0.911344, mph: 1.46667, kt: 1.68781, "in/s": 1 / 12 };
const ACC: Record<string, number> = { "m/s²": 1 / 9.80665, "m/s^2": 1 / 9.80665, "m/s2": 1 / 9.80665, "ft/s²": 1 / 32.174, "ft/s^2": 1 / 32.174, "ft/s2": 1 / 32.174, g: 1, G: 1 };

function splitName(h: string): { name: string; unit: string } {
  const m = h.trim().match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return m ? { name: m[1].trim(), unit: m[2].trim() } : { name: h.trim(), unit: "" };
}

export function parseOpenRocket(text: string, fileName = "OpenRocket sim"): SimData {
  const lines = text.split(/\r?\n/);
  const isNumericRow = (l: string) => /^\s*-?\d/.test(l);
  const firstData = lines.findIndex(isNumericRow);
  if (firstData < 0) throw new Error("no data rows found in the OpenRocket file");

  // header: last line before the data that names a Time column
  let headerLine = "";
  for (let i = firstData - 1; i >= 0; i--) {
    if (/Time \(/.test(lines[i])) { headerLine = lines[i].replace(/^#\s*/, ""); break; }
  }
  if (!headerLine) throw new Error("could not find the variable header (export with 'Include field descriptions' on)");
  const sep = [",", ";", "\t"].map((s) => [s, headerLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const heads = headerLine.split(sep).map(splitName);
  const idx = (name: RegExp) => heads.findIndex((h) => name.test(h.name));

  const rows: number[][] = [];
  const events: SimData["events"] = [];
  const decimalComma = sep === ";" ;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const ev = l.match(/Event\s+([A-Z_]+)(.*?)occurred at t\s*=\s*([-\d.,eE+]+)/);
    if (ev) { events.push({ name: ev[1], detail: ev[2].trim(), t: parseFloat(ev[3].replace(",", ".")) }); continue; }
    if (i < firstData || !isNumericRow(l)) continue;
    const f = l.split(sep).map((x) => parseFloat(decimalComma ? x.replace(",", ".") : x));
    if (f.length >= heads.length - 1 && Number.isFinite(f[0])) rows.push(f);
  }
  const n = rows.length;
  if (n < 5) throw new Error("too few data rows in the OpenRocket file");

  const col = (i: number, table: Record<string, number>): Float32Array | undefined => {
    if (i < 0) return undefined;
    const k = table[heads[i].unit];
    if (k === undefined) return undefined;
    const out = new Float32Array(n);
    for (let r = 0; r < n; r++) out[r] = (rows[r][i] ?? NaN) * k;
    return out;
  };

  // liftoff is t = 0 to match the flight logs
  const lift = events.find((e) => e.name === "LIFTOFF") ?? events.find((e) => e.name === "LAUNCH") ?? { t: rows[0][0] };
  const t0 = lift.t;
  const t = new Float64Array(n);
  for (let r = 0; r < n; r++) t[r] = rows[r][0] - t0;
  for (const e of events) e.t -= t0;

  const accVert = col(idx(/^Vertical acceleration$/i), ACC);
  const accTotal = col(idx(/^Total acceleration$/i), ACC);
  return {
    name: fileName.replace(/\.csv$/i, ""),
    n, t,
    alt: col(idx(/^Altitude$/i), LEN),
    vVert: col(idx(/^Vertical velocity$/i), VEL),
    vTotal: col(idx(/^Total velocity$/i), VEL),
    accVert, accTotal,
    east: col(idx(/^Position East of launch$/i), LEN),
    north: col(idx(/^Position North of launch$/i), LEN),
    events,
    columns: heads.map((h) => `${h.name} (${h.unit})`),
  };
}
