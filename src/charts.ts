// Time-series charts (uPlot), synced cursor and zoom, playhead, event lines, click to seek.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Analysis, FlightEvent } from "./analysis";
import type { BlueRavenFlight } from "./parsers/blueRaven";
import { sampleAt, type CompareTrace } from "./compare";

const CMP_COLOR = "#ff9de2";

/** resample a comparison series onto x (flight time), aligned at liftoff */
function onBase(x: ArrayLike<number>, lift: number, t: ArrayLike<number>, y: ArrayLike<number>) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = sampleAt(t, y, x[i] - lift);
  return out;
}

interface ChartDef {
  title: string;
  x: ArrayLike<number>;
  series: { label: string; data: ArrayLike<number>; color: string; width?: number; dash?: number[]; scale?: string; unit: string }[];
  yLabel: string;
  y2Label?: string;
}

const SYNC_KEY = "flight";

export class Charts {
  private plots: uPlot[] = [];
  private playhead = 0;
  private events: FlightEvent[] = [];
  private syncingScale = false;
  private ro: ResizeObserver;

  constructor(private host: HTMLElement, private onSeek: (t: number) => void) {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
  }

  setFlight(a: Analysis, f: BlueRavenFlight, cmp?: CompareTrace) {
    this.plots.forEach((p) => p.destroy());
    this.plots = [];
    this.host.innerHTML = "";
    this.events = a.events;
    const lr = f.lr!;
    const hr = f.hr;
    const lift = a.events.find((e) => e.key === "liftoff")?.t ?? 0;
    const cmpLabel = cmp ? (cmp.kind === "sim" ? `Sim: ${cmp.name}` : `Compare: ${cmp.name}`) : "";
    const defs: ChartDef[] = [
      {
        title: "Altitude", yLabel: "ft", x: lr.t,
        series: [
          { label: "Baro AGL (raw)", data: subtract(lr.baroAsl, a.padAsl), color: "rgba(140,160,200,0.45)", width: 1, unit: "ft" },
          { label: "Baro AGL (filtered)", data: a.altSmooth, color: "#5cc8ff", width: 2, unit: "ft" },
          { label: "Inertial altitude", data: lr.inAlt, color: "#b48cff", width: 1.5, dash: [6, 4], unit: "ft" },
          ...(a.gps ? [{ label: "GPS altitude AGL", data: a.gps.altOnLR, color: "#ffffff", width: 1.5, dash: [2, 3], unit: "ft" }] : []),
          ...(cmp?.alt ? [{ label: cmpLabel, data: onBase(lr.t, lift, cmp.t, cmp.alt), color: CMP_COLOR, width: 2, dash: [8, 4], unit: "ft" }] : []),
        ],
      },
      {
        title: "Velocity", yLabel: "ft/s", x: lr.t,
        series: [
          { label: "Baro vertical", data: a.baroVel, color: "#5cc8ff", width: 1.5, unit: "ft/s" },
          { label: "Inertial vertical", data: lr.velUp, color: "#7bd88f", width: 1.5, unit: "ft/s" },
          { label: "Inertial total", data: a.totalVel, color: "#f5c26b", width: 1.5, unit: "ft/s" },
          ...(a.gps ? [{ label: "GPS vertical", data: a.gps.vertVOnLR, color: "#ffffff", width: 1.5, dash: [2, 3], unit: "ft/s" }] : []),
          ...(cmp?.vVert ? [{ label: `${cmpLabel} (vertical)`, data: onBase(lr.t, lift, cmp.t, cmp.vVert), color: CMP_COLOR, width: 2, dash: [8, 4], unit: "ft/s" }] : []),
        ],
      },
    ];
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
          ...(cmp?.acc && cmp.accT ? [{ label: cmpLabel, data: onBase(hr.t, lift, cmp.accT, cmp.acc), color: CMP_COLOR, width: 1.5, dash: [8, 4], unit: "g" }] : []),
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

    for (const d of defs) this.plots.push(this.make(d, a));
    this.resize();
  }

  private make(d: ChartDef, a: Analysis): uPlot {
    const wrap = document.createElement("div");
    wrap.className = "chart";
    const h = document.createElement("div");
    h.className = "chart-title";
    h.textContent = d.title;
    wrap.appendChild(h);
    this.host.appendChild(wrap);
    const self = this;
    const opts: uPlot.Options = {
      width: Math.max(300, this.host.clientWidth - 8),
      height: 190,
      cursor: { sync: { key: SYNC_KEY }, drag: { x: true, y: false } },
      legend: { live: true },
      scales: { x: { time: false, min: a.tStart, max: a.tEnd }, y: { auto: true }, ...(d.y2Label ? { y2: { auto: true } } : {}) },
      axes: [
        { stroke: "#8a96b0", grid: { stroke: "rgba(52,67,106,0.5)", width: 1 }, ticks: { stroke: "rgba(52,67,106,0.8)" }, label: "Flight time (s)", labelSize: 22, font: "11px Inter, system-ui", labelFont: "11px Inter, system-ui" },
        { stroke: "#8a96b0", grid: { stroke: "rgba(52,67,106,0.5)", width: 1 }, ticks: { stroke: "rgba(52,67,106,0.8)" }, label: d.yLabel, labelSize: 22, size: 56, font: "11px Inter, system-ui", labelFont: "11px Inter, system-ui" },
        // every chart reserves a right axis so the time axes line up across charts
        d.y2Label
          ? { scale: "y2", side: 1, stroke: "#8a96b0", grid: { show: false }, ticks: { stroke: "rgba(52,67,106,0.8)" }, label: d.y2Label, labelSize: 22, size: 56, font: "11px Inter, system-ui", labelFont: "11px Inter, system-ui" }
          : { scale: "y", side: 1, grid: { show: false }, ticks: { show: false }, values: () => [], size: 78 },
      ],
      series: [
        { label: "t", value: (_u, v) => (v == null ? "-" : `${v.toFixed(2)} s`) },
        ...d.series.map((s) => ({
          label: s.label, stroke: s.color, width: s.width ?? 1.5, dash: s.dash, points: { show: false }, scale: s.scale ?? "y",
          value: (_u: uPlot, v: number | null) => (v == null ? "-" : `${v.toFixed(Math.abs(v) < 20 ? 2 : 0)} ${s.unit}`),
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
    const clean = (a: ArrayLike<number>) => Array.from(a, (v) => (Number.isFinite(v) ? v : null));
    const data = [Array.from(d.x), ...d.series.map((s) => clean(s.data))] as uPlot.AlignedData;
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
    for (const e of this.events) {
      const x = Math.round(u.valToPos(e.t, "x", true));
      if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    const px = Math.round(u.valToPos(this.playhead, "x", true));
    if (px >= u.bbox.left && px <= u.bbox.left + u.bbox.width) {
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, top + height); ctx.stroke();
    }
    ctx.restore();
  }

  setPlayhead(t: number) {
    this.playhead = t;
    for (const p of this.plots) p.redraw(false, false);
  }

  private resize() {
    const w = Math.max(300, this.host.clientWidth - 8);
    for (const p of this.plots) p.setSize({ width: w, height: 190 });
  }
}

function subtract(a: Float32Array, k: number) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - k;
  return out;
}
