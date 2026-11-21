// Deploy timeline: each flight or unit on its own row, on a shared clock from liftoff, with
// apogee as a tick and each pyro channel's fire as a colored dot. Makes "who fired first" and
// "how long after apogee" visible at a glance across altimeters.

import type { Analysis } from "./analysis";

export interface StripRow { name: string; color: string; a: Analysis }

const esc = (s: string) => s.replace(/[<&>"]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "BlRv_SN1742 (2026-03-29)" -> "SN1742" so it fits the row label */
const short = (n: string) => { const m = n.replace(/^BlRv_/, "").replace(/\s*\(.*\)$/, ""); return m.length > 11 ? m.slice(0, 10) + "…" : m; };

export function deployStrip(rows: StripRow[]): string {
  const W = 340, L = 84, R = 8, rowH = 34, top = 12, axisH = 20;
  const lift = (a: Analysis) => a.events.find((e) => e.key === "liftoff")?.t ?? 0;
  const end = Math.max(10, ...rows.map((r) => (r.a.events.find((e) => e.key === "landing")?.t ?? r.a.tEnd) - lift(r.a)));
  const x = (t: number) => L + (Math.max(0, Math.min(end, t)) / end) * (W - L - R);
  const H = top + rows.length * rowH + axisH;
  const step = end > 120 ? 30 : end > 60 ? 10 : 5;
  const ticks: string[] = [];
  for (let s = 0; s <= end; s += step) ticks.push(`<line x1="${x(s)}" x2="${x(s)}" y1="${top}" y2="${H - axisH + 4}" class="ds-grid"/><text x="${x(s)}" y="${H - 6}" class="ds-tick" text-anchor="middle">${s}</text>`);
  const body = rows.map((r, k) => {
    const y = top + k * rowH + rowH / 2, l0 = lift(r.a);
    const ev = (key: string) => r.a.events.find((e) => e.key === key);
    const apo = ev("apogee"), land = ev("landing");
    const fires = r.a.events.filter((e) => e.key.startsWith("fire_"));
    // stagger labels of fires that land on top of each other
    const placed: number[] = [];
    const dots = fires.map((e) => {
      const px = x(e.t - l0);
      const clash = placed.filter((p) => Math.abs(p - px) < 18).length;
      placed.push(px);
      const ch = e.key.slice(5);
      return `<g><title>${esc(r.name)}: ${esc(e.label)} at T+${(e.t - l0).toFixed(2)} s</title><circle cx="${px}" cy="${y}" r="5" fill="${e.color}" stroke="var(--panel)" stroke-width="1.5"/><text x="${px}" y="${y - 8 - clash * 9}" class="ds-lbl" text-anchor="middle">${esc(ch)}</text></g>`;
    }).join("");
    return `<g>
      <text x="${L - 8}" y="${y + 4}" class="ds-name" text-anchor="end"><tspan fill="${r.color}">●</tspan> ${esc(short(r.name))}<title>${esc(r.name)}</title></text>
      <line x1="${x(0)}" x2="${x(land ? land.t - l0 : end)}" y1="${y}" y2="${y}" class="ds-bar"/>
      ${apo ? `<line x1="${x(apo.t - l0)}" x2="${x(apo.t - l0)}" y1="${y - 9}" y2="${y + 9}" class="ds-apo"><title>Apogee T+${(apo.t - l0).toFixed(2)} s</title></line>` : ""}
      ${dots}
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="deploy-strip" role="img" aria-label="Pyro fire times for each altimeter on a shared clock from liftoff">${ticks.join("")}${body}</svg>`;
}
