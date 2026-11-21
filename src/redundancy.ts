// Two Blue Ravens in the same rocket: do they agree? Same date and liftoff within two minutes on
// the logger clocks counts as the same flight. Compares apogee, when each channel fired, and the
// baro altitude offset between the two units (a steady offset is a pad-altitude or port
// difference; a growing one points at a leaky bay or a blocked port).

import type { Analysis } from "./analysis";
import { indexAt } from "./analysis";
import { CHANNELS, type BlueRavenFlight } from "./parsers/blueRaven";
import { show } from "./units";

const ev = (a: Analysis, k: string) => a.events.find((e) => e.key === k)?.t;

/** seconds of day at liftoff from the logger clock (null if the clock can't be read) */
export function liftoffClock(f: BlueRavenFlight, a: Analysis): number | null {
  const lr = f.lr;
  if (!lr || !lr.clock.length) return null;
  const c = lr.clock[indexAt(lr.t, ev(a, "liftoff") ?? 0)] ?? "";
  const m = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(c.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export function sameFlight(f1: BlueRavenFlight, a1: Analysis, f2: BlueRavenFlight, a2: Analysis): boolean {
  if (!f1.lr || !f2.lr || !f1.lr.date || f1.lr.date !== f2.lr.date) return false;
  const c1 = liftoffClock(f1, a1), c2 = liftoffClock(f2, a2);
  return c1 !== null && c2 !== null && Math.abs(c1 - c2) <= 120;
}

export interface RedundancyRow { label: string; a: string; b: string; diff: string; flag: boolean }
export interface Redundancy { rows: RedundancyRow[]; baroOffset: number | null; baroSpread: number | null }

const fmt = (x: number | null | undefined, d = 0, u = "") => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${x.toFixed(d)}${u}`);

export function redundancy(f1: BlueRavenFlight, a1: Analysis, f2: BlueRavenFlight, a2: Analysis): Redundancy {
  const rows: RedundancyRow[] = [];
  const l1 = ev(a1, "liftoff") ?? 0, l2 = ev(a2, "liftoff") ?? 0;
  const apoAlt = (f: BlueRavenFlight, a: Analysis) => { const t = ev(a, "apogee"); return t === undefined ? null : a.altSmooth[indexAt(f.lr!.t, t)]; };
  const h1 = apoAlt(f1, a1), h2 = apoAlt(f2, a2);
  rows.push({ label: "Apogee", a: show(h1, "ft"), b: show(h2, "ft"), diff: h1 !== null && h2 !== null ? show(h2 - h1, "ft") : "-", flag: h1 !== null && h2 !== null && Math.abs(h2 - h1) > Math.max(30, 0.02 * h1) });
  const at = (a: Analysis, k: string, l: number) => { const t = ev(a, k); return t === undefined ? null : t - l; };
  const ta1 = at(a1, "apogee", l1), ta2 = at(a2, "apogee", l2);
  rows.push({ label: "Time to apogee", a: fmt(ta1, 2, " s"), b: fmt(ta2, 2, " s"), diff: ta1 !== null && ta2 !== null ? fmt(ta2 - ta1, 2, " s") : "-", flag: ta1 !== null && ta2 !== null && Math.abs(ta2 - ta1) > 1 });
  for (const ch of CHANNELS) {
    const x1 = at(a1, `fire_${ch}`, l1), x2 = at(a2, `fire_${ch}`, l2);
    if (x1 === null && x2 === null) continue;
    rows.push({
      label: `${ch} fired`, a: x1 === null ? "did not fire" : `T+${x1.toFixed(2)} s`, b: x2 === null ? "did not fire" : `T+${x2.toFixed(2)} s`,
      diff: x1 !== null && x2 !== null ? fmt(x2 - x1, 2, " s") : "one only",
      flag: x1 === null || x2 === null || Math.abs(x2 - x1) > 0.5,
    });
  }
  // baro offset on the liftoff clock, apogee to landing, skipping 1.5 s around every pyro fire
  const land = Math.min((ev(a1, "landing") ?? f1.lr!.t[f1.lr!.n - 1]) - l1, (ev(a2, "landing") ?? f2.lr!.t[f2.lr!.n - 1]) - l2);
  const fires = [...a1.events, ...a2.events].filter((e) => e.key.startsWith("fire_")).map((e) => e.t - (a1.events.includes(e) ? l1 : l2));
  const d: number[] = [];
  const lr1 = f1.lr!, lr2 = f2.lr!;
  for (let i = 0; i < lr1.n; i++) {
    const tt = lr1.t[i] - l1;
    if (tt < 0 || tt > land || fires.some((x) => Math.abs(tt - x) < 1.5)) continue;
    const j = indexAt(lr2.t, tt + l2);
    if (Math.abs(lr2.t[j] - l2 - tt) > 0.05) continue;
    d.push(a2.altSmooth[j] - a1.altSmooth[i]);
  }
  let baroOffset: number | null = null, baroSpread: number | null = null;
  if (d.length > 50) {
    const s = [...d].sort((x, y) => x - y);
    baroOffset = s[Math.floor(s.length / 2)];
    baroSpread = s[Math.floor(s.length * 0.95)] - s[Math.floor(s.length * 0.05)];
    rows.push({ label: "Baro offset (median)", a: "", b: "", diff: show(baroOffset, "ft"), flag: Math.abs(baroOffset) > 50 });
    rows.push({ label: "Baro spread (5th to 95th %)", a: "", b: "", diff: show(baroSpread, "ft"), flag: baroSpread > 100 });
  }
  return { rows, baroOffset, baroSpread };
}
