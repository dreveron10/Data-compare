// Time-series charts (uPlot), synced cursor and zoom, playhead, event lines, click to seek.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Analysis, FlightEvent, Phase } from "./analysis";
import { flightPhases } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";
import { sampleAt, type ActiveCompare } from "./compare";
import { cu, cv } from "./units";
import { aeroSeries } from "./aero";

/** resample a comparison series onto x (flight time), aligned at liftoff plus the comparison's offset */
function onBase(x: ArrayLike<number>, lift: number, t: ArrayLike<number>, y: ArrayLike<number>) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = sampleAt(t, y, x[i] - lift);
  return out;
}
const cmpName = (c: ActiveCompare) => (c.trace.kind === "sim" ? `Sim: ${c.trace.name}` : c.trace.name);

interface ChartDef {
  title: string;
  x: ArrayLike<number>;
  series: { label: string; data: ArrayLike<number>; color: string; width?: number; dash?: number[]; scale?: string; unit: string }[];
  yLabel: string;
  y2Label?: string;
}

const SYNC_KEY = "flight";
const HIDDEN_KEY = "dc.charts.hidden";

function loadHidden(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]")); } catch { return new Set(); }
}
function saveHidden(h: Set<string>) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...h])); } catch { /* ignore */ }
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export class Charts {
  private plots: uPlot[] = [];
  private defs: ChartDef[] = [];
  private playhead = 0;
  private heads = new WeakMap<uPlot, HTMLDivElement>();
  private events: FlightEvent[] = [];
  private phases: Phase[] = [];
  private syncingScale = false;
  private hidden = loadHidden();
  private flightName = "flight";
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private onSeek: (t: number) => void) {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
  }

  setFlight(a: Analysis, f: BlueRavenFlight, cmps: ActiveCompare[] = []) {
    this.plots.forEach((p) => p.destroy());
    this.plots = [];
    this.host.innerHTML = "";
    this.events = a.events;
    this.phases = flightPhases(a);
    this.flightName = slug(f.gps?.name ?? f.name) || "flight";
    const lr = f.lr!;
    const hr = f.hr;
    const lift = a.events.find((e) => e.key === "liftoff")?.t ?? 0;
    const sh = (c: ActiveCompare) => lift + c.offset;
    const defs: ChartDef[] = [
      {
        title: "Altitude", yLabel: "ft", x: lr.t,
        series: [
          { label: "Baro AGL (raw)", data: subtract(lr.baroAsl, a.padAsl), color: "rgba(140,160,200,0.45)", width: 1, unit: "ft" },
          { label: "Baro AGL (filtered)", data: a.altSmooth, color: "#5cc8ff", width: 2, unit: "ft" },
          { label: "Inertial altitude", data: lr.inAlt, color: "#b48cff", width: 1.5, dash: [6, 4], unit: "ft" },
          ...(a.gps ? [{ label: "GPS altitude AGL", data: a.gps.altOnLR, color: "#ffffff", width: 1.5, dash: [2, 3], unit: "ft" }] : []),
          ...cmps.filter((c) => c.trace.alt).map((c) => ({ label: cmpName(c), data: onBase(lr.t, sh(c), c.trace.t, c.trace.alt!), color: c.color, width: 2, dash: [8, 4], unit: "ft" })),
        ],
      },
      {
        title: "Velocity", yLabel: "ft/s", x: lr.t,
        series: [
          { label: "Baro vertical", data: a.baroVel, color: "#5cc8ff", width: 1.5, unit: "ft/s" },
          { label: "Inertial vertical", data: lr.velUp, color: "#7bd88f", width: 1.5, unit: "ft/s" },
          { label: "Inertial total", data: a.totalVel, color: "#f5c26b", width: 1.5, unit: "ft/s" },
          ...(a.gps ? [{ label: "GPS vertical", data: a.gps.vertVOnLR, color: "#ffffff", width: 1.5, dash: [2, 3], unit: "ft/s" }] : []),
          ...cmps.filter((c) => c.trace.vVert).map((c) => ({ label: `${cmpName(c)} (vertical)`, data: onBase(lr.t, sh(c), c.trace.t, c.trace.vVert!), color: c.color, width: 2, dash: [8, 4], unit: "ft/s" })),
        ],
      },
    ];
    // altitude difference: comparison minus this flight, same time
    const withAlt = cmps.filter((c) => c.trace.alt);
    if (withAlt.length) {
      defs.splice(1, 0, {
        title: "Altitude difference (comparison minus this flight)", yLabel: "ft", x: lr.t,
        series: withAlt.map((c) => {
          const other = onBase(lr.t, sh(c), c.trace.t, c.trace.alt!);
          const d = new Float32Array(lr.n);
          for (let i = 0; i < lr.n; i++) d[i] = other[i] - a.altSmooth[i];
          return { label: cmpName(c), data: d, color: c.color, width: 1.8, unit: "ft" };
        }),
      });
    }
    const aero = aeroSeries(f, a);
    if (aero) {
      const tq = lr.t[aero.iMaxQ];
      defs.push({
        title: `Mach and dynamic pressure (max q ${cv(aero.maxQ, "psf").toFixed(cu("psf") === "kPa" ? 1 : 0)} ${cu("psf")} at T+${tq.toFixed(2)} s, Mach ${aero.mach[aero.iMaxQ].toFixed(2)})`,
        yLabel: "psf", y2Label: "Mach", x: lr.t,
        series: [
          { label: "Dynamic pressure q", data: aero.qPsf, color: "#ff7a1a", width: 1.8, unit: "psf" },
          { label: "Mach", data: aero.mach, color: "#6cc4ff", width: 1.5, unit: "", scale: "y2" },
        ],
      });
    }
    if (a.gps && f.gps) {
      defs.push({
        title: "GPS drift", yLabel: "ft", y2Label: "ft/s", x: a.gps.t,
        series: [
          { label: "Distance from pad", data: f.gps.distance, color: "#ffffff", width: 2, unit: "ft" },
          { label: "Horizontal speed", data: f.gps.horzV, color: "#5cc8ff", width: 1.2, unit: "ft/s", scale: "y2" },
        ],
      });
      defs.push({
        title: "GPS signal", yLabel: "sats", y2Label: "dBm", x: a.gps.t,
        series: [
          { label: "Satellites", data: f.gps.sats, color: "#7bd88f", width: 1.5, unit: "" },
          { label: "Radio RSSI", data: f.gps.rssi, color: "#f5c26b", width: 1.2, unit: "dBm", scale: "y2" },
        ],
      });
    }
    if (hr && a.axialAccel && a.accelMag) {
      defs.push({
        title: "Acceleration", yLabel: "g", x: hr.t,
        series: [
          { label: "Axial", data: a.axialAccel, color: "#ff7a90", width: 1, unit: "g" },
          { label: "Magnitude", data: a.accelMag, color: "rgba(207,214,228,0.55)", width: 1, unit: "g" },
          ...cmps.filter((c) => c.trace.acc && c.trace.accT).map((c) => ({ label: cmpName(c), data: onBase(hr.t, sh(c), c.trace.accT!, c.trace.acc!), color: c.color, width: 1.5, dash: [8, 4], unit: "g" })),
        ],
      });
    }
    defs.push({
      title: "Attitude", yLabel: "deg", x: lr.t,
      series: [
        { label: "Tilt from vertical", data: lr.tilt, color: "#f5c26b", width: 1.5, unit: "°" },
        { label: "Future angle", data: lr.futureAngle, color: "rgba(245,194,107,0.45)", width: 1, dash: [4, 4], unit: "°" },
      ],
    });
    if (hr && a.rollRate) {
      defs.push({
        title: "Roll rate", yLabel: "deg/s", x: hr.t,
        series: [{ label: "Roll rate (about rocket axis)", data: a.rollRate, color: "#e86bff", width: 1, unit: "°/s" }],
      });
    }
    defs.push({
      title: "Battery & pyro channels", yLabel: "V", x: lr.t,
      series: [
        { label: "Battery", data: lr.battV, color: "#cfd6e4", width: 1.5, unit: "V" },
        { label: "Apo", data: lr.chanV.Apo, color: "#e86bff", width: 1.2, unit: "V" },
        { label: "Main", data: lr.chanV.Main, color: "#5cc8ff", width: 1.2, unit: "V" },
        { label: "3rd", data: lr.chanV["3rd"], color: "#b48cff", width: 1.2, unit: "V" },
        { label: "4th", data: lr.chanV["4th"], color: "#7aa2ff", width: 1.2, unit: "V" },
      ],
    });

    this.defs = defs;
    for (const d of defs) this.plots.push(this.make(d, a));
    this.resize();
  }

  private make(d: ChartDef, a: Analysis): uPlot {
    const wrap = document.createElement("div");
    wrap.className = "chart";
    const key = d.title.replace(/\s*\(.*$/, ""); // stable key even when labels change
    if (this.hidden.has(key)) wrap.classList.add("collapsed");
    const h = document.createElement("div");
    h.className = "chart-head";
    h.innerHTML = `<button class="chart-title" aria-expanded="${!this.hidden.has(key)}"><span class="caret">▾</span>${d.title}</button>
      <span class="chart-tools"><button class="btn small-btn" data-x="csv">CSV</button><button class="btn small-btn" data-x="png">PNG</button></span>`;
    wrap.appendChild(h);
    this.host.appendChild(wrap);
    h.querySelector(".chart-title")!.addEventListener("click", (e) => {
      const collapsed = wrap.classList.toggle("collapsed");
      (e.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!collapsed));
      if (collapsed) this.hidden.add(key); else this.hidden.delete(key);
      saveHidden(this.hidden);
    });
    h.querySelector('[data-x="csv"]')!.addEventListener("click", () => this.exportCsv(u, d));
    h.querySelector('[data-x="png"]')!.addEventListener("click", () => this.exportPng(u, d));
    const self = this;
    const opts: uPlot.Options = {
      width: Math.max(240, this.host.clientWidth - 8),
      height: 190,
      cursor: { sync: { key: SYNC_KEY }, drag: { x: true, y: false } },
      legend: { live: true },
      scales: { x: { time: false, min: a.tStart, max: a.tEnd }, y: { auto: true }, ...(d.y2Label ? { y2: { auto: true } } : {}) },
      axes: [
        { stroke: "#8a96b0", grid: { stroke: "rgba(52,67,106,0.5)", width: 1 }, ticks: { stroke: "rgba(52,67,106,0.8)" }, label: "Flight time (s)", labelSize: 22, font: "12px Barlow, system-ui", labelFont: "12px Barlow, system-ui" },
        { stroke: "#8a96b0", grid: { stroke: "rgba(52,67,106,0.5)", width: 1 }, ticks: { stroke: "rgba(52,67,106,0.8)" }, label: cu(d.yLabel), labelSize: 22, size: 56, font: "12px Barlow, system-ui", labelFont: "12px Barlow, system-ui" },
        // every chart reserves a right axis so the time axes line up across charts
        d.y2Label
          ? { scale: "y2", side: 1, stroke: "#8a96b0", grid: { show: false }, ticks: { stroke: "rgba(52,67,106,0.8)" }, label: cu(d.y2Label), labelSize: 22, size: 56, font: "12px Barlow, system-ui", labelFont: "12px Barlow, system-ui" }
          : { scale: "y", side: 1, grid: { show: false }, ticks: { show: false }, values: () => [], size: 78 },
      ],
      series: [
        { label: "t", value: (_u, v) => (v == null ? "-" : `${v.toFixed(2)} s`) },
        ...d.series.map((s) => ({
          label: s.label, stroke: s.color, width: s.width ?? 1.5, dash: s.dash, points: { show: false }, scale: s.scale ?? "y",
          value: (_u: uPlot, v: number | null) => (v == null ? "-" : `${v.toFixed(Math.abs(v) < 20 ? 2 : 0)} ${cu(s.unit)}`),
        })),
      ],
      hooks: {
        draw: [(u) => self.drawOverlay(u)],
        setScale: [(u, key) => {
          if (key !== "x" || self.syncingScale) return;
          self.syncingScale = true;
          const { min, max } = u.scales.x;
          for (const p of self.plots) if (p !== u) p.setScale("x", { min: min!, max: max! });
          self.syncingScale = false;
        }],
      },
    };
    // uPlot treats null as a gap; NaN would break autoscaling
    const clean = (a: ArrayLike<number>, k: number) => Array.from(a, (v) => (Number.isFinite(v) ? v * k : null));
    const data = [Array.from(d.x), ...d.series.map((s) => clean(s.data, cv(1, s.unit)))] as uPlot.AlignedData;
    const u = new uPlot(opts, data, wrap);
    // click (without drag) to seek
    let downX = 0;
    u.over.addEventListener("mousedown", (e) => (downX = e.clientX));
    u.over.addEventListener("mouseup", (e) => {
      if (Math.abs(e.clientX - downX) < 4) this.onSeek(u.posToVal(e.offsetX, "x"));
    });
    u.over.addEventListener("dblclick", () => {
      for (const p of this.plots) p.setScale("x", { min: a.tStart, max: a.tEnd });
    });
    return u;
  }

  private drawOverlay(u: uPlot) {
    const ctx = u.ctx;
    const { top, height } = u.bbox;
    ctx.save();
    // phase bands along the bottom edge of the plot
    const bandH = 4 * devicePixelRatio;
    for (const ph of this.phases) {
      const x0 = Math.max(u.bbox.left, u.valToPos(ph.t0, "x", true));
      const x1 = Math.min(u.bbox.left + u.bbox.width, u.valToPos(ph.t1, "x", true));
      if (x1 <= x0) continue;
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = ph.color;
      ctx.fillRect(x0, top, x1 - x0, height);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x0, top + height - bandH, x1 - x0, bandH);
    }
    ctx.globalAlpha = 1;
    for (const e of this.events) {
      const x = Math.round(u.valToPos(e.t, "x", true));
      if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    ctx.restore();
    this.placePlayhead(u);
  }

  /**
   * The playhead is a positioned element over the plot instead of part of the canvas, so moving it
   * costs one style change per chart rather than a full redraw of every chart.
   */
  private placePlayhead(u: uPlot) {
    let el = this.heads.get(u);
    if (!el) {
      el = document.createElement("div");
      el.className = "playhead";
      u.over.appendChild(el);
      this.heads.set(u, el);
    }
    const px = u.valToPos(this.playhead, "x");
    const show = Number.isFinite(px) && px >= 0 && px <= u.bbox.width / devicePixelRatio;
    el.style.display = show ? "" : "none";
    if (show) el.style.transform = `translateX(${Math.round(px) - 1}px)`;
  }

  private exportCsv(u: uPlot, d: ChartDef) {
    const heads = ["Flight time (s)", ...d.series.map((s) => `${s.label} (${cu(s.unit)})`)];
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [heads.map(esc).join(",")];
    const x = u.data[0];
    for (let i = 0; i < x.length; i++) {
      const row = [x[i].toFixed(3)];
      for (let k = 1; k < u.data.length; k++) {
        const v = u.data[k][i];
        row.push(v == null ? "" : String(Math.round(v * 1000) / 1000));
      }
      lines.push(row.join(","));
    }
    download(`${this.flightName}-${slug(d.title)}.csv`, new Blob([lines.join("\n")], { type: "text/csv" }));
  }

  /** chart image with title and legend, no playhead (for PNG export and the report) */
  private async compose(u: uPlot, d: ChartDef): Promise<HTMLCanvasElement> {
    const src = u.ctx.canvas; // the playhead is not on the canvas, so the image is clean
    const dpr = devicePixelRatio;
    const pad = 16 * dpr, head = 34 * dpr, legend = 26 * dpr;
    const c = document.createElement("canvas");
    c.width = src.width + pad * 2;
    c.height = src.height + head + legend + pad;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#131e33";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#e9eef7";
    ctx.font = `600 ${16 * dpr}px Barlow, system-ui, sans-serif`;
    ctx.fillText(d.title, pad, pad + 14 * dpr);
    ctx.drawImage(src, pad, head);
    ctx.font = `${12 * dpr}px Barlow, system-ui, sans-serif`;
    let x = pad;
    const y = head + src.height + 16 * dpr;
    for (const s of d.series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(x, y - 8 * dpr, 14 * dpr, 4 * dpr);
      x += 20 * dpr;
      ctx.fillStyle = "#e9eef7";
      ctx.fillText(s.label, x, y);
      x += ctx.measureText(s.label).width + 18 * dpr;
    }
    return c;
  }

  private async exportPng(u: uPlot, d: ChartDef) {
    const c = await this.compose(u, d);
    c.toBlob((b) => b && download(`${this.flightName}-${slug(d.title)}.png`, b), "image/png");
  }

  /** images of the charts whose titles start with any of the given names, in chart order */
  async snapshots(names: string[]): Promise<{ title: string; url: string }[]> {
    const out: { title: string; url: string }[] = [];
    for (let i = 0; i < this.plots.length; i++) {
      const d = this.defs[i];
      if (names.some((n) => d.title.startsWith(n))) out.push({ title: d.title, url: (await this.compose(this.plots[i], d)).toDataURL("image/png") });
    }
    return out;
  }

  setPlayhead(t: number) {
    this.playhead = t;
    for (const p of this.plots) this.placePlayhead(p);
  }

  private resize() {
    const w = Math.max(240, this.host.clientWidth - 8);
    for (const p of this.plots) p.setSize({ width: w, height: 190 });
  }
}

function subtract(a: Float32Array, k: number) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - k;
  return out;
}
