// A Featherweight GPS log on its own (no Blue Raven): summary numbers, a top-down track and an
// altitude profile, the landing card, wind from the drift, and a GPX file for the recovery walk.
import type { GpsData } from "./parsers/featherweightGps";
import { compassName } from "./wind";
import { show } from "./units";

function gpx(g: GpsData): string {
  const esc = (x: string) => x.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]!);
  const pts: string[] = [];
  for (let i = 0; i < g.n; i++) if (g.fix[i] && Number.isFinite(g.lat[i]) && !(g.lat[i] === 0 && g.lon[i] === 0)) pts.push(`<trkpt lat="${g.lat[i].toFixed(7)}" lon="${g.lon[i].toFixed(7)}"><ele>${(g.altAsl[i] * 0.3048).toFixed(1)}</ele></trkpt>`);
  const L = g.n - 1;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Data Compare" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="${g.padLat.toFixed(7)}" lon="${g.padLon.toFixed(7)}"><name>Pad</name></wpt>
<wpt lat="${g.lat[L].toFixed(7)}" lon="${g.lon[L].toFixed(7)}"><name>Landing: ${esc(g.name)}</name></wpt>
<trk><name>${esc(g.name)}</name><trkseg>
${pts.join("\n")}
</trkseg></trk>
</gpx>`;
}

/** wind per altitude band from the drift between apogee+8 s and landing (no pyro times without the Blue Raven) */
function windBands(g: GpsData) {
  const t0 = (g.apogeeT ?? 0) + 8, t1 = (g.landingT ?? g.t[g.n - 1]) - 1;
  const pts: { h: number; vE: number; vN: number }[] = [];
  for (let i = 1; i < g.n - 1; i++) {
    if (g.t[i] < t0 || g.t[i] > t1) continue;
    const dt = g.t[i + 1] - g.t[i - 1];
    if (!(dt > 0.3 && dt < 5)) continue;
    pts.push({ h: g.altAgl[i], vE: (g.east[i + 1] - g.east[i - 1]) / dt, vN: (g.north[i + 1] - g.north[i - 1]) / dt });
  }
  if (pts.length < 6) return [];
  const top = Math.max(...pts.map((p) => p.h));
  const size = [250, 500, 1000, 2000].find((s) => top / s <= 8) ?? 2000;
  const out: { lo: number; hi: number; mph: number; from: number }[] = [];
  for (let lo = Math.floor(top / size) * size; lo >= 0; lo -= size) {
    const b = pts.filter((p) => p.h >= lo && p.h < lo + size);
    if (b.length < 3) continue;
    const vE = b.reduce((s, p) => s + p.vE, 0) / b.length, vN = b.reduce((s, p) => s + p.vN, 0) / b.length;
    out.push({ lo, hi: lo + size, mph: Math.hypot(vE, vN) * 0.681818, from: ((Math.atan2(vE, vN) * 180) / Math.PI + 180 + 360) % 360 });
  }
  return out;
}

function svgTrack(g: GpsData): string {
  const W = 300, H = 300, pad = 18;
  let minE = 0, maxE = 0, minN = 0, maxN = 0;
  for (let i = 0; i < g.n; i++) { minE = Math.min(minE, g.east[i]); maxE = Math.max(maxE, g.east[i]); minN = Math.min(minN, g.north[i]); maxN = Math.max(maxN, g.north[i]); }
  const span = Math.max(maxE - minE, maxN - minN, 100);
  const cx = (minE + maxE) / 2, cn = (minN + maxN) / 2;
  const X = (e: number) => pad + ((e - cx) / span + 0.5) * (W - 2 * pad);
  const Y = (n: number) => pad + (0.5 - (n - cn) / span) * (H - 2 * pad);
  const d = Array.from({ length: g.n }, (_, i) => `${i ? "L" : "M"}${X(g.east[i]).toFixed(1)},${Y(g.north[i]).toFixed(1)}`).join("");
  const L = g.n - 1;
  return `<svg viewBox="0 0 ${W} ${H}" class="gps-track" role="img" aria-label="Top-down track from the pad to the landing">
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    <circle cx="${X(0)}" cy="${Y(0)}" r="5" fill="var(--good)"/><text x="${X(0) + 8}" y="${Y(0) + 4}" class="lbl">Pad</text>
    <circle cx="${X(g.east[L])}" cy="${Y(g.north[L])}" r="5" fill="var(--signal)"/><text x="${X(g.east[L]) + 8}" y="${Y(g.north[L]) + 4}" class="lbl">Landing</text>
    <text x="${pad}" y="${pad}" class="lbl">N ↑</text>
    <text x="${pad}" y="${H - 4}" class="lbl">${show(span, "ft")} across</text></svg>`;
}

function svgProfile(g: GpsData): string {
  const W = 300, H = 150, pad = 18;
  const t0 = g.t[0], t1 = g.t[g.n - 1];
  const top = Math.max(...Array.from(g.altAgl), 10);
  const d = Array.from({ length: g.n }, (_, i) => `${i ? "L" : "M"}${(pad + ((g.t[i] - t0) / (t1 - t0)) * (W - 2 * pad)).toFixed(1)},${(H - pad - (Math.max(0, g.altAgl[i]) / top) * (H - 2 * pad)).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="gps-track" role="img" aria-label="GPS altitude over time"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/><text x="${pad}" y="12" class="lbl">${show(top, "ft")} max</text><text x="${W - pad}" y="${H - 4}" text-anchor="end" class="lbl">${(t1 - t0).toFixed(0)} s</text></svg>`;
}

export function gpsOnlyHtml(g: GpsData): { html: string; gpx: string } {
  const L = g.n - 1;
  const dist = Math.hypot(g.east[L], g.north[L]);
  const bearing = ((Math.atan2(g.east[L], g.north[L]) * 180) / Math.PI + 360) % 360;
  let iA = 0; for (let i = 0; i < g.n; i++) if (g.altAgl[i] > g.altAgl[iA]) iA = i;
  const maxOf = (a: ArrayLike<number>, i1 = g.n) => { let m = -Infinity; for (let i = 0; i < i1; i++) if (Number.isFinite(a[i]) && a[i] > m) m = a[i]; return m; };
  const q = `${g.lat[L].toFixed(6)},${g.lon[L].toFixed(6)}`;
  const winds = windBands(g);
  const rows: [string, string][] = [
    ["Apogee (GPS)", show(g.altAgl[iA], "ft")],
    ["Time to apogee", `${g.t[iA].toFixed(1)} s`],
    ["Max vertical speed", show(maxOf(g.vertV, iA + 1), "ft/s")],
    ["Max horizontal speed (ascent)", show(maxOf(g.horzV, iA + 5), "ft/s")],
    ["Landing", `${show(dist, "ft")} toward ${compassName(bearing)} (${bearing.toFixed(0)}°)`],
    ["Flight time", g.landingT !== null ? `${g.landingT.toFixed(1)} s` : "-"],
  ];
  const html = `
    <div class="gps-only">
      <div><table class="metrics">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
        <div class="land-ll" style="margin-top:10px"><code>${q.replace(",", ", ")}</code></div>
        <div class="land-actions" style="margin-top:8px">
          <a class="btn small-btn" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Open in Maps</a>
          <a class="btn small-btn" href="https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=walking" target="_blank" rel="noopener">Walking directions</a>
          <button class="btn small-btn" type="button" data-gpx>GPX</button>
        </div>
        ${winds.length ? `<h3 class="sub-h">Wind from drift</h3><table class="metrics wind">${winds.map((w) => `<tr><td>${w.lo}-${w.hi} ft</td><td>${w.mph.toFixed(0)} mph</td><td>${compassName(w.from)} ${w.from.toFixed(0)}°</td></tr>`).join("")}</table><p class="muted small">From the drift after apogee + 8 s. Without the Blue Raven the deployment times aren't known, so the first seconds under each chute are included.</p>` : ""}
      </div>
      <div>${svgTrack(g)}${svgProfile(g)}</div>
    </div>`;
  return { html, gpx: gpx(g) };
}
