import "./style.css";
import { analyze, indexAt, type Analysis } from "./analysis";
import { CHANNELS, loadBlueRaven, type BlueRavenFlight, type Channel } from "./parsers/blueRaven";
import { Replay3D, type CameraMode } from "./replay3d";
import { Charts } from "./charts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $("app");
const replay = new Replay3D($("view3d"), $("inset3d"));
const charts = new Charts($("charts"), (t) => seek(t));
const scrub = $<HTMLInputElement>("scrub");
const playBtn = $<HTMLButtonElement>("play");
const speedSel = $<HTMLSelectElement>("speed");

let flight: BlueRavenFlight | undefined;
let A: Analysis | undefined;
let t = 0;
let playing = false;
let lastFrame = 0;
let lastChartUpdate = 0;

// ---------- roll dial ticks ----------
{
  const g = $("roll-ticks");
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6;
    const r1 = k % 3 === 0 ? 34 : 38;
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", String(Math.sin(a) * r1)); l.setAttribute("y1", String(-Math.cos(a) * r1));
    l.setAttribute("x2", String(Math.sin(a) * 43)); l.setAttribute("y2", String(-Math.cos(a) * 43));
    g.appendChild(l);
  }
}

// ---------- loading ----------
async function loadFiles(files: { name: string; text?: string; buffer?: ArrayBuffer }[]) {
  const warn: string[] = [];
  try {
    const res = await loadBlueRaven(files);
    warn.push(...res.warnings);
    if (!res.flight.lr) throw new Error("No Blue Raven LR file found. Include the *_LR_*.csv file.");
    const a = analyze(res.flight);
    warn.push(...a.warnings);
    flight = res.flight;
    A = a;
    showFlight();
  } catch (e) {
    warn.unshift((e as Error).message);
  }
  showWarnings(warn);
}

async function fromFileList(list: FileList | File[]) {
  const arr = Array.from(list);
  const files = await Promise.all(
    arr.map(async (f) => (/\.xlsx$/i.test(f.name) ? { name: f.name, buffer: await f.arrayBuffer() } : { name: f.name, text: await f.text() })),
  );
  await loadFiles(files);
}

async function loadSample(sn: string) {
  setBusy(true);
  try {
    const base = `samples/${sn}/`;
    const names = ["HR.csv", "LR.csv", "summary.csv", "deploy_settings.xlsx"];
    const files = await Promise.all(
      names.map(async (n) => {
        const r = await fetch(base + n);
        if (!r.ok) return null;
        return n.endsWith(".xlsx") ? { name: n, buffer: await r.arrayBuffer() } : { name: n, text: await r.text() };
      }),
    );
    await loadFiles(files.filter((x): x is NonNullable<typeof x> => x !== null));
  } finally {
    setBusy(false);
  }
}

function setBusy(b: boolean) {
  document.body.style.cursor = b ? "progress" : "";
}

function showWarnings(w: string[]) {
  const el = $("warnings");
  el.hidden = w.length === 0;
  el.innerHTML = w.map((x) => `<div>⚠ ${escapeHtml(x)}</div>`).join("");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ---------- render a loaded flight ----------
function showFlight() {
  if (!A || !flight) return;
  app.classList.remove("empty");
  const lr = flight.lr!;
  $("flight-name").textContent = `${flight.name} · ${lr.date} · flight #${flight.summary?.raw["Flight number"] ?? "?"}`;
  scrub.min = String(A.tStart);
  scrub.max = String(A.tEnd);
  scrub.step = "0.002";
  replay.setFlight(A, flight);
  charts.setFlight(A, flight);
  renderMetrics();
  renderEvents();
  renderSettings();
  renderScrubEvents();
  pause();
  seek(Math.max(A.tStart, -1));
}

function fmt(v: number | null | undefined, unit: string) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const d = unit === "g" || unit === "V" || unit === "rev" || unit === "s" ? (Math.abs(v) < 100 ? 2 : 1) : unit === "deg" ? 1 : 0;
  return v.toFixed(d);
}

function renderMetrics() {
  const rows = A!.metrics.map((m) => {
    let diff = "";
    if (m.site !== null && m.device !== null && Number.isFinite(m.site) && Number.isFinite(m.device)) {
      const d = m.site - m.device;
      const rel = Math.abs(m.device) > 1e-6 ? Math.abs(d / m.device) : 0;
      diff = `<span class="diff${rel > 0.05 ? " big" : ""}">${d >= 0 ? "+" : ""}${fmt(d, m.unit)}</span>`;
    }
    return `<tr${m.note ? ` title="${escapeHtml(m.note)}"` : ""}><td>${escapeHtml(m.label)}</td><td>${fmt(m.site, m.unit)}</td><td>${fmt(m.device, m.unit)}</td><td>${diff}</td><td class="unit">${m.unit}</td></tr>`;
  });
  $("metrics").innerHTML = `<tr><th>Metric</th><th>Site</th><th>Blue Raven</th><th>Δ</th><th></th></tr>${rows.join("")}`;
}

function renderEvents() {
  const p = A!.path;
  $("events").innerHTML = A!.events
    .map((e) => {
      const alt = p.y[indexAt(p.t, e.t)];
      return `<li data-t="${e.t}"><i style="background:${e.color}"></i>${escapeHtml(e.label)}<span class="alt">${alt.toFixed(0)} ft</span><span class="t">T+${e.t.toFixed(2)} s</span></li>`;
    })
    .join("");
}

const COND_MAP: Record<string, { flag?: string; state?: string; text: (v: Record<string, number>) => string }> = {
  "Alt_above_pad_<_AGL1": { flag: "LT_AGL1", text: (v) => `AGL < ${v.AGL1} ft` },
  "Alt_above_pad_>_AGL2": { flag: "GT_AGL2", text: (v) => `AGL > ${v.AGL2} ft` },
  "Flight_angle_<_FANG1": { flag: "LT_FANG1", text: (v) => `Tilt < ${v.FANG1}°` },
  "Flight_angle_>_FANG2": { flag: "GT_FANG2", text: (v) => `Tilt > ${v.FANG2}°` },
  "Future_Angle_>_FUTANG": { flag: "GT_FUTANG", text: (v) => `Future angle > ${v.FUTANG}°` },
  "Time_<_TVAL1": { flag: "LT_TVAL1", text: (v) => `Time < ${v.TVAL1} s` },
  "Time_>_TVAL2": { flag: "GT_TVAL2", text: (v) => `Time > ${v.TVAL2} s` },
  "Total_Velocity_<_VEL1": { flag: "LT_VEL1", text: (v) => `Velocity < ${v.VEL1} ft/s` },
  "Total_Velocity_>_VEL2": { flag: "GT_VEL2", text: (v) => `Velocity > ${v.VEL2} ft/s` },
  "Baro_velocity_<_BVEL": { flag: "LT_BVEL1", text: (v) => `Baro vel < ${v.BVEL1} ft/s` },
  "Burnouts_>_BURNCOUNT": { flag: "GT_BURN", text: (v) => `Burnouts ≥ ${v.BRNCNT}` },
  "Channel_is_armed": { flag: "Armed", text: () => "Armed" },
  Liftoff: { state: "Liftoff", text: () => "Liftoff" },
  Apogee: { state: "Apogee", text: () => "Apogee" },
  Pressure_Increasing: { state: "Press_Increasing", text: () => "Pressure increasing" },
  Burnout_Coast: { state: "Burnout_Coast", text: () => "Coasting" },
  Apo_Fired: { state: "Apo_fired", text: () => "Apo fired" },
  Main_Fired: { state: "Main_fired", text: () => "Main fired" },
  "3rd_Fired": { state: "3rd_fired", text: () => "3rd fired" },
  "4th_Fired": { state: "4th_fired", text: () => "4th fired" },
  Normal_Ascent: { state: "Normal_Ascent", text: () => "Normal ascent" },
  "Accel velocity <= 0": { state: "Accel_Vel_LE_0", text: () => "Accel vel ≤ 0" },
  "ECI Vertical Vel <=0": { state: "ECI_Vvel_le_0", text: () => "Vertical vel ≤ 0" },
  "Tilt Exceeded 90 degrees": { state: "Tilt Exceeded 90deg", text: () => "Tilt > 90°" },
};

function renderSettings() {
  const s = flight!.settings;
  const panel = $("settings-panel");
  panel.hidden = !s;
  if (!s) return;
  const lr = flight!.lr!;
  const html = CHANNELS.map((ch: Channel) => {
    const vals: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.values)) vals[k] = v[ch];
    const fire = A!.events.find((e) => e.key === `fire_${ch}`);
    // a condition counts as met if it was true at any LR sample in the 0.15 s before the fire
    // (conditions are evaluated faster than the 50 Hz log, so a short spike can be enough)
    const i1 = fire ? indexAt(lr.t, fire.t) : -1;
    const i0 = fire ? indexAt(lr.t, fire.t - 0.15) : -1;
    const wasTrue = (arr: Uint8Array) => { for (let k = i0; k <= i1; k++) if (arr[k]) return true; return false; };
    const chips = s.conditions
      .filter((c) => c.enabled[ch])
      .map((c) => {
        const m = COND_MAP[c.name];
        const label = m ? m.text(vals) : c.name;
        let cls = "";
        if (i1 >= 0 && m) {
          const arr = m.flag ? lr.conditions[ch]?.[m.flag] : m.state ? lr.flags[m.state] : undefined;
          if (arr) cls = wasTrue(arr) ? " met" : " unmet";
        }
        return `<span class="cond${cls}">${escapeHtml(label)}</span>`;
      })
      .join("");
    const delay = s.options["Use_Delay"]?.[ch] === "TRUE" ? ` · delay ${vals.delay} s` : "";
    const when = fire ? `fired T+${fire.t.toFixed(2)} s` : "did not fire";
    return `<div class="settings-ch"><h4>${ch} <span class="muted small">(${when}${delay})</span></h4>${chips || '<span class="muted small">no conditions</span>'}</div>`;
  }).join("");
  $("settings").innerHTML = `<div class="muted small">All conditions must be true to fire. Green/red shows the logged state in the 0.15 s before each fire.</div>${html}`;
}

function renderScrubEvents() {
  const span = A!.tEnd - A!.tStart;
  $("scrub-events").innerHTML = A!.events
    .map((e) => `<span title="${escapeHtml(e.label)}" style="left:${((e.t - A!.tStart) / span) * 100}%;background:${e.color}"></span>`)
    .join("");
}

// ---------- HUD ----------
function phaseAt(time: number) {
  const ev = (k: string) => A!.events.find((e) => e.key === k)?.t;
  const lo = ev("liftoff") ?? 0, bo = ev("burnout"), ap = ev("apogee"), mf = ev("fire_Main"), af = ev("fire_Apo"), la = ev("landing");
  if (time < lo) return "ON PAD";
  if (bo !== undefined && time < bo) return "BOOST";
  if (ap !== undefined && time < ap) return "COAST";
  if (la !== undefined && time >= la) return "LANDED";
  if (mf !== undefined && time >= mf) return "MAIN DESCENT";
  if (af !== undefined && time >= af) return "DROGUE DESCENT";
  return "DESCENT";
}

function updateHud(time: number) {
  const lr = flight!.lr!, hr = flight!.hr;
  const i = indexAt(lr.t, time);
  const alt = A!.altSmooth[i];
  const vUp = lr.velUp[i];
  const spd = A!.totalVel[i];
  const tilt = lr.tilt[i];
  let roll = lr.rollAngle[i] % 360;
  if (roll > 180) roll -= 360;
  if (roll < -180) roll += 360;
  let acc = "-", rr = "-";
  if (hr && A!.axialAccel && A!.rollRate) {
    const k = indexAt(hr.t, time);
    acc = A!.axialAccel[k].toFixed(1);
    rr = A!.rollRate[k].toFixed(0);
  }
  const descent = time > A!.path.t[A!.path.apogeeIdx];
  $("hud").innerHTML = `
    <div class="phase">${phaseAt(time)}</div>
    <div><div class="k">Altitude AGL</div><div class="v">${alt.toFixed(0)} ft</div></div>
    <div><div class="k">Vertical vel</div><div class="v">${(descent ? A!.baroVel[i] : vUp).toFixed(0)} ft/s</div></div>
    <div><div class="k">Speed</div><div class="v">${descent ? "-" : spd.toFixed(0) + " ft/s"}</div></div>
    <div><div class="k">Axial accel</div><div class="v">${acc} g</div></div>
    <div><div class="k">Tilt</div><div class="v">${tilt.toFixed(1)}°</div></div>
    <div><div class="k">Roll rate</div><div class="v">${rr} °/s</div></div>`;
  $("roll-needle").setAttribute("transform", `rotate(${roll})`);
  $("roll-val").textContent = `${roll.toFixed(0)}°`;
}

// ---------- playback ----------
function seek(time: number) {
  if (!A) return;
  t = Math.min(A.tEnd, Math.max(A.tStart, time));
  scrub.value = String(t);
  $("time").textContent = `T${t < 0 ? "−" : "+"}${Math.abs(t).toFixed(2)} s`;
  replay.setTime(t);
  updateHud(t);
  const now = performance.now();
  if (!playing || now - lastChartUpdate > 66) {
    charts.setPlayhead(t);
    lastChartUpdate = now;
  }
}

function play() {
  if (!A) return;
  if (t >= A.tEnd - 0.01) seek(A.tStart);
  playing = true;
  playBtn.textContent = "❚❚";
  lastFrame = performance.now();
  requestAnimationFrame(tick);
}
function pause() {
  playing = false;
  playBtn.textContent = "▶";
  if (A) charts.setPlayhead(t);
}
function tick(now: number) {
  if (!playing || !A) return;
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  seek(t + dt * parseFloat(speedSel.value));
  if (t >= A.tEnd) { pause(); return; }
  requestAnimationFrame(tick);
}

// ---------- wiring ----------
playBtn.addEventListener("click", () => (playing ? pause() : play()));
scrub.addEventListener("input", () => seek(parseFloat(scrub.value)));
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !(e.target instanceof HTMLInputElement && e.target.type !== "range") && !(e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    playing ? pause() : play();
  }
});
$("events").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (li?.dataset.t) seek(parseFloat(li.dataset.t));
});
document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("[data-cam]").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    replay.setCameraMode(b.dataset.cam as CameraMode);
  }),
);
document.querySelectorAll<HTMLButtonElement>("[data-sample]").forEach((b) =>
  b.addEventListener("click", () => loadSample(b.dataset.sample!)),
);
for (const id of ["file-input", "file-input-2"]) {
  const inp = $<HTMLInputElement>(id);
  inp.addEventListener("change", () => {
    if (inp.files?.length) fromFileList(inp.files);
    inp.value = "";
  });
}
const dz = $("dropzone");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; dz.classList.add("drag"); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove("drag"); } });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dz.classList.remove("drag");
  if (e.dataTransfer?.files.length) fromFileList(e.dataTransfer.files);
});

// open a sample straight from the URL, e.g. ?sample=SN0614
const qs = new URLSearchParams(location.search).get("sample");
if (qs && /^SN\d+$/.test(qs)) loadSample(qs);
