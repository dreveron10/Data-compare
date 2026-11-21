import "./style.css";
import { $, downloadBlob, escapeHtml, fileSlug } from "./ui";
import { COND_MAP } from "./condLabels";
import { initPreflight, preflight } from "./preflight";
import { maybeNudgeAfterSave, renderBackupNudge } from "./backup";
import { initOffline } from "./pwa";
import { initHelp } from "./help";
import { analyze, flightPhases, indexAt, type Analysis } from "./analysis";
import { CHANNELS, identifyText, type BlueRavenFlight, type Channel } from "./parsers/blueRaven";
import type { Replay3D, CameraMode } from "./replay3d";
import { Charts } from "./charts";
import { loadAndAnalyze } from "./background";
import { findFindings } from "./findings";
import { conv, cu, getUnits, onUnitsChange, setUnits, show } from "./units";
import { windProfile, compassName } from "./wind";
import { coastDrag } from "./coast";
import { thrustCurve } from "./thrust";
import { calibHint } from "./calib";
import { ejectionTimes } from "./ejection";
import { aeroSeries } from "./aero";
import { buildExport } from "./exportAll";
import { diameterFor, diameterFromCdA } from "./chute";
import { predictLanding } from "./predict";
import { SL_MIN_RAIL_EXIT, railExit } from "./railExit";
import { MATERIALS, flutterMargin, type Fin } from "./flutter";
import { Recorder, pickMime } from "./record";
import { applyTheme, axisColor, getTheme, gridColor, onThemeChange, setTheme } from "./theme";
import { vMaxFor } from "./recovery";
import { startTour, tourSeen } from "./tour";
import { getVehicle, setVehicle, vehicleKeyOf } from "./vehicle";
import { checkSettings } from "./settingsCheck";
import { descentPhases, rateVsAltitude } from "./descent";
import uPlot from "uplot";
import { isGenericAlt, parseGenericAlt } from "./parsers/genericAlt";
import { isGpsLog, isGpsSummary, parseGpsLog } from "./parsers/featherweightGps";
import { gpsOnlyHtml } from "./gpsOnly";
import { CMP_COLORS, KEY_ROWS, MAX_COMPARES, keyNumbersOf, whatChanged, traceFromAltimeter, sampleAt, traceFromFlight, traceFromSim, type ActiveCompare, type CompareTrace } from "./compare";
import { isOpenRocket, parseOpenRocket } from "./parsers/openRocket";
import { EARTH_ATTRIBUTION } from "./earthAttrib";
import { evaluate, loadDefaultRecovery, saveDefaultRecovery, type RecoveryConfig } from "./recovery";
import {
  deleteEntry, exportBackup, getEntry, importBackup, listEntries, newId, putEntry, requestPersistence, storageUse,
  type LibraryEntry,
} from "./library";


const app = $("app");
// 3D needs WebGL; without it (old GPUs, some remote browsers) the rest of the site still works
type ReplayApi = Pick<Replay3D, "setFlight" | "setCompare" | "setTime" | "setCameraMode" | "setSatellite" | "snapshot" | "refreshUnitLabels"> & {
  frameCanvases?: () => { main: HTMLCanvasElement; inset: HTMLCanvasElement };
  onCameraMode?: (mode: CameraMode) => void;
  onSatellite?: (available: boolean, progress: number) => void;
};
// The 3D code (three.js renderer, Earth tiles) loads in its own chunk so the page and charts come up
// first. Until it arrives, this stand-in remembers the latest state and hands it over when ready.
let replay3d: Replay3D | null = null;
const pending: { flight?: [Analysis, BlueRavenFlight]; cmps?: ActiveCompare[]; t?: number; cam?: CameraMode; sat?: boolean } = {};
const replay: ReplayApi = {
  setFlight(a, f) { pending.flight = [a, f]; replay3d?.setFlight(a, f); },
  setCompare(c = []) { pending.cmps = c; replay3d?.setCompare(c); },
  setTime(x) { pending.t = x; replay3d?.setTime(x); },
  setCameraMode(m, reset) { pending.cam = m; replay3d?.setCameraMode(m, reset); },
  setSatellite(on) { pending.sat = on; replay3d?.setSatellite(on); },
  snapshot: () => replay3d?.snapshot() ?? "",
  frameCanvases: () => replay3d!.frameCanvases(),
  refreshUnitLabels() { replay3d?.refreshUnitLabels(); },
};
function noWebGL() {
  document.body.classList.add("no-webgl");
  $("view3d").innerHTML =
    '<div class="no-gl">3D replay needs WebGL, which this browser has turned off or does not support. ' +
    "Charts and tables below still work. Try Chrome or Edge with hardware acceleration enabled.</div>";
}
import("./replay3d")
  .then(({ Replay3D: R3 }) => {
    let r: Replay3D;
    try { r = new R3($("view3d"), $("inset3d")); } catch { noWebGL(); return; }
    r.onCameraMode = (m) => replay.onCameraMode?.(m);
    r.onSatellite = (a, p) => replay.onSatellite?.(a, p);
    replay3d = r;
    if (pending.flight) r.setFlight(...pending.flight);
    if (pending.cmps) r.setCompare(pending.cmps);
    if (pending.cam) r.setCameraMode(pending.cam);
    if (pending.sat) r.setSatellite(true);
    if (pending.t !== undefined) r.setTime(pending.t);
  })
  .catch(() => { $("view3d").innerHTML = '<div class="no-gl">The 3D replay could not load. Check the connection and reload; charts and tables still work.</div>'; });
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
let gpsOffsetOverride: number | undefined;
let cmps: ActiveCompare[] = [];
let lastFiles: InFile[] = [];
let currentEntryId: string | undefined;
let recovery: RecoveryConfig = loadDefaultRecovery();

// ---------- Earth view (terrain + imagery) ----------
let satOn = true;
replay.onSatellite = (available, progress) => {
  const btn = $("sat-toggle");
  btn.hidden = !available;
  btn.textContent = progress < 1 ? `Earth ${Math.round(progress * 100)}%` : "Earth";
  $("sat-attrib").hidden = !(available && satOn);
  $("sat-attrib").textContent = EARTH_ATTRIBUTION;
};
$("sat-toggle").addEventListener("click", () => {
  satOn = !satOn;
  $("sat-toggle").classList.toggle("active", satOn);
  $("sat-attrib").hidden = !satOn;
  replay.setSatellite(satOn);
});

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
let currentEntryName: string | undefined;
async function loadFiles(files: InFile[], entryId?: string, entryName?: string) {
  const warn: string[] = [];
  setLoading("Reading flight files");
  try {
    const res = await loadAndAnalyze(files);
    warn.push(...res.warnings);
    if (!res.flight.lr || !res.analysis) throw new Error("No Blue Raven LR file found. Include the *_LR_*.csv file.");
    gpsOffsetOverride = undefined;
    cmps = [];
    const a = res.analysis;
    warn.push(...a.warnings);
    flight = res.flight;
    A = a;
    lastFiles = files;
    currentEntryId = entryId;
    currentEntryName = entryName;
    if (!entryId) recovery = loadDefaultRecovery();
    $("save-open").hidden = false;
    $("report-open").hidden = false;
    $("share-open").hidden = false;
    $("save-open").textContent = entryId ? "Edit saved flight" : "Save flight";
    showFlight();
  } catch (e) {
    warn.unshift((e as Error).message);
  } finally {
    setLoading(null);
  }
  showWarnings(warn);
}

type InFile = { name: string; text?: string; buffer?: ArrayBuffer };

async function readList(list: FileList | File[]): Promise<InFile[]> {
  return Promise.all(
    Array.from(list).map(async (f) => (/\.(xlsx|zip)$/i.test(f.name) ? { name: f.name, buffer: await f.arrayBuffer() } : { name: f.name, text: await f.text() })),
  );
}

async function fromFileList(list: FileList | File[]) {
  const files = await readList(list);
  // a shared flight or library backup: add it to the library and open the first flight
  const zip = files.find((f) => f.buffer && /\.zip$/i.test(f.name));
  if (zip) {
    try {
      const entries = await importBackup(zip.buffer!);
      const first = entries.find((e) => e.kind === "flight");
      if (first) {
        recovery = first.recovery ?? loadDefaultRecovery();
        await loadFiles(first.files, first.id, first.name);
      }
      if (entries.length > 1 || !first) showWarnings([`Added ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to your library.`]);
    } catch (e) {
      showWarnings([`${zip.name}: not a Data Compare flight file (${(e as Error).message}).`]);
    }
    return;
  }
  // only a deploy settings workbook: check it before a flight, no flight data needed
  if (files.length > 0 && files.every((f) => f.buffer && /\.xlsx$/i.test(f.name))) {
    preflight(files[0]);
    return;
  }
  // a GPS tracker log with no Blue Raven: show what the GPS alone can tell
  const gpsLogs = files.filter((f) => f.text && isGpsLog(f.text));
  if (gpsLogs.length && files.every((f) => f.text && (isGpsLog(f.text) || isGpsSummary(f.text)))) {
    if (!flight) {
      try {
        const g = parseGpsLog(gpsLogs[0].text!, gpsLogs[0].name.replace(/\.[^.]+$/, ""));
        const { html, gpx } = gpsOnlyHtml(g);
        $("gpsonly-title").textContent = `GPS tracker flight: ${g.name}`;
        $("gpsonly-body").innerHTML = html;
        $("gpsonly-body").querySelector("[data-gpx]")?.addEventListener("click", () => downloadBlob(`${fileSlug(g.name)}.gpx`, new Blob([gpx], { type: "application/gpx+xml" })));
        $<HTMLDialogElement>("gpsonly-dialog").showModal();
      } catch (e) { showWarnings([`${gpsLogs[0].name}: ${(e as Error).message}`]); }
      return;
    }
  }
  // another brand of altimeter: it can be compared against a Blue Raven flight, not opened alone
  const notBR = files.length > 0 && files.every((f) => f.text && identifyText(f.text) === "unknown" && !isOpenRocket(f.text) && !isGpsLog(f.text) && !isGpsSummary(f.text) && isGenericAlt(f.text));
  if (notBR) {
    if (flight) { await loadCompare(files); return; }
    showWarnings([`${files[0].name} looks like another altimeter's log. Open a Blue Raven flight (or a sample) first, then drop it again to compare.`]);
    return;
  }
  // an OpenRocket export dropped onto a loaded flight is a comparison, not a new flight
  if (flight && files.length > 0 && files.every((f) => f.text && isOpenRocket(f.text))) {
    await loadCompare(files);
    return;
  }
  await loadFiles(files);
}

async function loadCompare(files: InFile[]) {
  if (!A || !flight) return;
  try {
    const sim = files.find((f) => f.text && isOpenRocket(f.text));
    let trace: CompareTrace;
    const brLike = files.some((f) => f.text && identifyText(f.text) !== "unknown");
    const other = !brLike ? files.find((f) => f.text && isGenericAlt(f.text)) : undefined;
    if (sim) {
      trace = traceFromSim(parseOpenRocket(sim.text!, sim.name));
    } else if (other) {
      trace = traceFromAltimeter(parseGenericAlt(other.text!, other.name));
    } else {
      setLoading("Reading comparison flight");
      const res = await loadAndAnalyze(files).finally(() => setLoading(null));
      if (!res.flight.lr || !res.analysis) throw new Error("Comparison needs an OpenRocket CSV export or a Blue Raven LR file.");
      trace = traceFromFlight(res.analysis, res.flight);
      // Mach/q and thrust for the overlays, on the comparison's own liftoff clock
      const cf = res.flight, ca = res.analysis;
      const clift = ca.events.find((e) => e.key === "liftoff")?.t ?? 0;
      const ae = aeroSeries(cf, ca);
      if (ae) trace.aero = { t: Float64Array.from(cf.lr!.t, (x) => x - clift), mach: ae.mach, qPsf: ae.qPsf };
      if (cf.hr && ca.axialAccel) {
        const cc = coastCfg(), mc = motorCfg();
        const m = cc.massLb ?? recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0);
        const cd = coastDrag(cf, ca, m, cc.diaIn)?.cd50 ?? 0.45;
        const th = thrustCurve(cf, ca, m, mc.propLb ?? 0, cc.diaIn, cd);
        if (th) trace.thrust = { t: Float64Array.from(th.t, (x) => x - clift), lbf: Float32Array.from(th.thrustLbf) };
      }
    }
    // keep at most 3: the oldest drops off
    if (cmps.length >= MAX_COMPARES) cmps.shift();
    const used = new Set(cmps.map((c) => c.color));
    const color = CMP_COLORS.find((c) => !used.has(c)) ?? CMP_COLORS[0];
    cmps.push({ id: `${Date.now()}-${Math.random()}`, trace, files, offset: 0, color });
    alignCompares();
    applyCompare();
    showWarnings(A.warnings);
  } catch (e) {
    showWarnings([`Comparison: ${(e as Error).message}`]);
  }
}

type AlignAt = "liftoff" | "apogee" | "main";
let alignAt: AlignAt = (localStorage.getItem("dc.align") as AlignAt) || "liftoff";
const ALIGN_NAME: Record<AlignAt, string> = { liftoff: "liftoff", apogee: "apogee", main: "main deploy" };
/** shift each comparison so the chosen event happens at the same moment as in this flight */
function alignCompares() {
  if (!A) return;
  const ev = (k: string) => A!.events.find((e) => e.key === k)?.t ?? null;
  const lift = ev("liftoff") ?? 0;
  const mine = alignAt === "apogee" ? ev("apogee") : alignAt === "main" ? ev("fire_Main") : lift;
  for (const c of cmps) {
    const theirs = alignAt === "liftoff" ? 0 : c.trace.align[alignAt];
    c.offset = mine !== null && theirs !== null ? Math.round((mine - lift - theirs) * 100) / 100 : 0;
  }
}
document.querySelectorAll<HTMLButtonElement>("[data-align]").forEach((b) =>
  b.addEventListener("click", () => {
    alignAt = b.dataset.align as AlignAt;
    try { localStorage.setItem("dc.align", alignAt); } catch { /* ignore */ }
    alignCompares();
    applyCompare();
  }),
);

function applyCompare() {
  if (!A || !flight) return;
  renderMotor(false);
  charts.setFlight(A, flight, cmps);
  replay.setCompare(cmps);
  renderCompare();
  seek(t);
}

async function fetchSample(sn: string): Promise<InFile[]> {
  const base = `samples/${sn}/`;
  const names = ["HR.csv", "LR.csv", "summary.csv", "deploy_settings.xlsx", "gps.csv", "gps_summary.csv"];
  const files = await Promise.all(
    names.map(async (n) => {
      const r = await fetch(base + n);
      // skip missing files (some static servers answer a missing file with the HTML page)
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return null;
      return n.endsWith(".xlsx") ? { name: n, buffer: await r.arrayBuffer() } : { name: n, text: await r.text() };
    }),
  );
  return files.filter((x): x is NonNullable<typeof x> => x !== null);
}

function renderCompare() {
  $("cmp-panel").hidden = !A;
  $("cmp-clear").hidden = cmps.length === 0;
  $("cmp-sample").hidden = cmps.length >= MAX_COMPARES;
  if (!A || cmps.length === 0) {
    $("cmp-list").innerHTML = "";
    $("cmp-table").innerHTML = "";
    $("cmp-notes").textContent = "";
    $("cmp-summary").innerHTML = "";
    $("cmp-sub").textContent = "Overlay up to 3 OpenRocket sims or other Blue Raven flights. They are aligned at liftoff.";
    $("cmp-align").hidden = true;
    return;
  }
  $("cmp-align").hidden = false;
  document.querySelectorAll<HTMLElement>("[data-align]").forEach((b) => {
    b.classList.toggle("active", b.dataset.align === alignAt);
    b.setAttribute("aria-pressed", String(b.dataset.align === alignAt));
  });
  const missing = alignAt === "liftoff" ? [] : cmps.filter((c) => c.trace.align[alignAt as "apogee" | "main"] === null).map((c) => c.trace.name);
  $("cmp-sub").textContent = `Dashed lines in the charts and 3D, lined up at ${ALIGN_NAME[alignAt]}. Use shift to fine-tune.${missing.length ? ` No ${ALIGN_NAME[alignAt]} found in ${missing.join(", ")}, so it stays at liftoff.` : ""}`;
  $("cmp-list").innerHTML = cmps
    .map((c) => `<div class="cmp-item"><i style="background:${c.color}"></i><span class="nm" title="${escapeHtml(c.trace.name)}">${c.trace.kind === "sim" ? "Sim: " : ""}${escapeHtml(c.trace.name)}</span>
      <label class="off">shift <input type="number" step="0.1" value="${c.offset}" data-off="${c.id}" aria-label="Time shift in seconds" /> s</label>
      <button class="x" data-rmc="${c.id}" aria-label="Remove comparison">×</button></div>`)
    .join("");
  const mine = keyNumbersOf(A);
  const cname = (c: ActiveCompare) => (c.trace.kind === "sim" ? `the sim ${c.trace.name}` : c.trace.name);
  const coastCd = (() => {
    if (!flight?.hr || !A?.axialAccel) return null;
    const cc = coastCfg();
    const m = cc.massLb ?? recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0);
    return coastDrag(flight, A, m, cc.diaIn)?.cd50 ?? null;
  })();
  $("cmp-summary").innerHTML = cmps
    .map((c) => {
      const hint = c.trace.kind === "sim" ? calibHint(flight!, A!, c.trace, coastCd) : null;
      return `<p><i class="sw" style="background:${c.color}"></i>${escapeHtml(whatChanged(mine, c.trace.key, cname(c)))}</p>${
        hint ? `<details class="calib"><summary>How to make this sim match</summary>${hint.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}<div class="calib-bar" title="Apogee gap split"><span class="b" style="flex:${Math.abs(hint.fromBoost).toFixed(0)}">Boost ${Math.abs(hint.fromBoost).toFixed(0)} ft</span><span class="c" style="flex:${Math.abs(hint.fromCoast).toFixed(0)}">Coast ${Math.abs(hint.fromCoast).toFixed(0)} ft</span></div></details>` : ""
      }`;
    })
    .join("");
  const single = cmps.length === 1;
  const rows = KEY_ROWS.map(({ k, label, unit }) => {
    const a = mine[k];
    const others = cmps.map((c) => c.trace.key[k]);
    if (a === null && others.every((b) => b === null)) return "";
    let diff = "";
    const b = others[0];
    if (single && a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) {
      const d = a - b;
      const rel = Math.abs(b) > 1e-6 ? Math.abs(d / b) : 0;
      diff = `<td><span class="diff${rel > 0.05 ? " big" : ""}">${d >= 0 ? "+" : ""}${fmt(d, unit)}</span></td>`;
    }
    return `<tr><td>${label}</td><td>${fmt(a, unit)}</td>${others.map((o) => `<td>${fmt(o, unit)}</td>`).join("")}${single ? diff || "<td></td>" : ""}<td class="unit">${cu(unit)}</td></tr>`;
  }).join("");
  const heads = cmps.map((c) => `<th><i class="sw" style="background:${c.color}"></i></th>`).join("");
  $("cmp-table").innerHTML = `<tr><th>Metric</th><th>This</th>${heads}${single ? "<th>Δ</th>" : ""}<th><span class="sr-only">Unit</span></th></tr>${rows}`;
  const notes = [...new Set(cmps.flatMap((c) => c.trace.notes))];
  if (cmps.some((c) => c.trace.path && c.trace.compass !== A!.compass)) notes.push("3D heading isn't aligned for comparisons without GPS or position data.");
  $("cmp-notes").innerHTML = notes.map((n) => `<div>${escapeHtml(n)}</div>`).join("");
}

async function loadSample(sn: string) {
  setBusy(true);
  setLoading("Downloading sample flight");
  try {
    await loadFiles(await fetchSample(sn));
  } finally {
    setBusy(false);
  }
}

function setLoading(msg: string | null) {
  const el = $("loading");
  el.hidden = msg === null;
  if (msg) $("loading-msg").textContent = msg;
}

function setBusy(b: boolean) {
  document.body.style.cursor = b ? "progress" : "";
}

function showWarnings(w: string[]) {
  const el = $("warnings");
  el.hidden = w.length === 0;
  el.innerHTML = w.map((x) => `<div>⚠ ${escapeHtml(x)}</div>`).join("");
}


// ---------- render a loaded flight ----------
function showFlight() {
  if (!A || !flight) return;
  whatIf = null;
  app.classList.remove("empty");
  const lr = flight.lr!;
  showFlightTitle();
  scrub.min = String(A.tStart);
  scrub.max = String(A.tEnd);
  scrub.step = "0.002";
  replay.setFlight(A, flight);
  replay.setCompare(cmps);
  charts.setFlight(A, flight, cmps);
  renderCompare();
  $("lg-x").textContent = A.compass ? "East" : "Downrange";
  $("lg-z").textContent = A.compass ? "North" : "Crossrange";
  $("video-panel").hidden = false;
  renderVideoState();
  renderFindings();
  renderMetrics();
  renderRecovery();
  renderDescent();
  renderGps();
  renderEvents();
  renderSettings();
  renderScrubEvents();
  loadMarks();
  loadVehicleKey();
  // first flight ever on this browser: a short walk through the main controls
  if (!tourSeen()) setTimeout(() => { if (!document.querySelector("dialog[open]")) startTour(); }, 900);
  pause();
  seek(Math.max(A.tStart, -1));
}
function showFlightTitle() {
  if (!flight) return;
  const fdate = flightDate();
  const fnum = flight.summary?.raw["Flight number"];
  $("flight-name").textContent = `${currentEntryName ?? flight.gps?.name ?? flight.name}${fdate ? `, ${new Date(fdate + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : ""}${fnum ? `, Blue Raven flight ${fnum}` : ""}`;
}

function fmt(v: number | null | undefined, unit: string) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const d = unit === "g" || unit === "V" || unit === "rev" || unit === "s" ? (Math.abs(v) < 100 ? 2 : 1) : unit === "deg" ? 1 : 0;
  return conv(v, unit)[0].toFixed(d);
}

function renderMetrics() {
  const rows = A!.metrics.map((m) => {
    let diff = "";
    if (m.site !== null && m.device !== null && Number.isFinite(m.site) && Number.isFinite(m.device)) {
      const d = m.site - m.device;
      const rel = Math.abs(m.device) > 1e-6 ? Math.abs(d / m.device) : 0;
      diff = `<span class="diff${rel > 0.05 ? " big" : ""}">${d >= 0 ? "+" : ""}${fmt(d, m.unit)}</span>`;
    }
    return `<tr${m.note ? ` title="${escapeHtml(m.note)}"` : ""}><td>${escapeHtml(m.label)}</td><td>${fmt(m.site, m.unit)}</td><td>${fmt(m.device, m.unit)}</td><td>${diff}</td><td class="unit">${cu(m.unit)}</td></tr>`;
  });
  $("metrics").innerHTML = `<tr><th>Metric</th><th>Site</th><th>Blue Raven</th><th>Δ</th><th><span class="sr-only">Unit</span></th></tr>${rows.join("")}`;
}

// ---------- descent ----------
let descPlot: uPlot | undefined;
function renderDescent() {
  $("desc-panel").hidden = !A;
  if (!A || !flight) return;
  const weight = recovery.sections.reduce((n, s) => n + (s.massLb > 0 ? s.massLb : 0), 0) || null;
  const phases = descentPhases(flight, A, weight);
  $("desc-sub").textContent = weight
    ? `CdA uses ${show(weight, "lb", 1)}, the total of the recovery sections. Air density comes from the logged pressure and temperature.`
    : "Enter section masses in the recovery check to estimate parachute CdA.";
  $("desc-table").innerHTML = phases.length
    ? `<tr><th>Phase</th><th>Rate</th><th>At sea level</th><th>CdA</th></tr>${phases
        .map((p) => `<tr title="${p.altTop.toFixed(0)} to ${p.altBottom.toFixed(0)} ft, T+${p.t0.toFixed(1)} to ${p.t1.toFixed(1)} s"><td>${p.name}<small class="muted" style="display:block">${conv(p.altTop, "ft")[0].toFixed(0)} to ${show(p.altBottom, "ft")}</small></td><td>${show(p.rate, "ft/s", 1)}</td><td>${show(p.seaLevelRate, "ft/s", 1)}</td><td>${show(p.cdA, "ft²", 1)}</td></tr>`)
        .join("")}`
    : '<tr><td class="muted">No steady descent found.</td></tr>';
  renderWind();
  renderWhatIf();
  renderChute(phases, weight);
  renderCoast();
  renderMotor();
  renderFlutter();
  const { x, y } = rateVsAltitude(flight, A);
  descPlot?.destroy();
  const host = $("desc-chart");
  host.innerHTML = "";
  if (x.length < 5) return;
  descPlot = new uPlot({
    width: Math.max(220, host.clientWidth || 320),
    height: 170,
    legend: { show: false },
    cursor: { y: false },
    scales: { x: { time: false } },
    axes: [
      { stroke: axisColor(), label: "Altitude AGL (ft)", labelSize: 20, size: 34, grid: { stroke: gridColor(), width: 1 }, font: "11px Barlow, system-ui", labelFont: "11px Barlow, system-ui" },
      { stroke: axisColor(), label: `Descent rate (${cu("ft/s")})`, labelSize: 20, size: 44, grid: { stroke: gridColor(), width: 1 }, font: "11px Barlow, system-ui", labelFont: "11px Barlow, system-ui" },
    ],
    series: [{}, { stroke: "#6cc4ff", width: 1.5, points: { show: false } }],
  }, [x.map((v) => conv(v, "ft")[0]), y.map((v) => conv(v, "ft/s")[0])], host);
}

// ---------- landing what-if ----------
let whatIf: { main: number; drogue: number; mrate: number } | null = null; // user's values for this flight
function renderWhatIf() {
  const w = flight?.gps && A ? windProfile(flight.gps, A) : null;
  $("whatif").hidden = !w || !A?.gps;
  if (!w || !A?.gps || !flight?.gps) return;
  const g = flight.gps, al = A.gps;
  // start once the first chute has settled: before that the rocket still carries sideways speed
  // from the arc over (on bullet bill that was another 640 ft after apogee), which wind can't explain
  const apoT = A.events.find((e) => e.key === "apogee")?.t ?? al.apogeeT;
  const firstFire = Math.min(...A.events.filter((e) => e.key.startsWith("fire_") && e.t >= apoT - 1).map((e) => e.t), Infinity);
  const t0 = Math.max(apoT + 2, (Number.isFinite(firstFire) ? firstFire : apoT) + 4);
  let i = 0;
  while (i < g.n - 1 && al.t[i] < t0) i++;
  const start = { east: g.east[i], north: g.north[i], alt: A.altSmooth[indexAt(flight.lr!.t, al.t[i])] };
  const k = keyNumbersOf(A);
  const flown = { main: k.mainAlt ?? 0, drogue: Math.abs(k.drogueRate ?? 100), mrate: Math.abs(k.mainRate ?? 20) };
  const v = whatIf ?? flown;
  const ins: [string, number, string][] = [["wi-main", v.main, "ft"], ["wi-drogue", v.drogue, "ft/s"], ["wi-mrate", v.mrate, "ft/s"]];
  for (const [id, x, u] of ins) if (document.activeElement?.id !== id) $<HTMLInputElement>(id).value = conv(x, u)[0].toFixed(u === "ft" ? 0 : 1);
  $("wi-main").parentElement!.firstChild!.textContent = `Main altitude (${cu("ft")})`;
  $("wi-drogue").parentElement!.firstChild!.textContent = `Drogue rate (${cu("ft/s")})`;
  $("wi-mrate").parentElement!.firstChild!.textContent = `Main rate (${cu("ft/s")})`;
  const check = predictLanding(w, start, flown.main, flown.drogue, flown.mrate);
  const p = predictLanding(w, start, v.main, v.drogue, v.mrate);
  const L = al.landing;
  const err = Math.hypot(check.east - g.east[g.n - 1], check.north - g.north[g.n - 1]);
  $("whatif-sub").textContent = `Drifts down through this flight's measured winds, starting where the first chute had settled (T+${al.t[i].toFixed(1)}, ${show(start.alt, "ft")}). With the flown settings it lands ${show(err, "ft")} from where the rocket really landed, which is the model's error on this flight.`;
  const same = !whatIf;
  $("whatif-out").innerHTML = `<div class="land-top"><span class="land-arrow" style="transform:rotate(${p.bearing.toFixed(0)}deg)" aria-hidden="true">↑</span><div><div class="land-dist">${show(p.distance, "ft")}</div><div class="muted small">from the pad toward ${compassName(p.bearing)} (${p.bearing.toFixed(0)}°), ${p.descentS.toFixed(0)} s from there to touchdown${same ? "" : `. Flown: ${show(L.distance, "ft")}, ${(p.distance - L.distance >= 0 ? "+" : "")}${show(p.distance - L.distance, "ft")}`}</div></div></div>${same ? "" : '<button class="btn small-btn" id="wi-reset" type="button">Back to the flown values</button>'}`;
}
for (const id of ["wi-main", "wi-drogue", "wi-mrate"]) {
  $(id).addEventListener("change", () => {
    const n = (k: string, u: string) => { const x = parseFloat($<HTMLInputElement>(k).value); return Number.isFinite(x) && x >= 0 ? x / conv(1, u)[0] : null; };
    const k = A ? keyNumbersOf(A) : null;
    const next = {
      main: n("wi-main", "ft") ?? k?.mainAlt ?? 0,
      drogue: Math.max(1, n("wi-drogue", "ft/s") ?? 100),
      mrate: Math.max(1, n("wi-mrate", "ft/s") ?? 20),
    };
    // a blur with nothing changed must not re-render (it would swallow a click on the reset button)
    if (whatIf && JSON.stringify(next) === JSON.stringify(whatIf)) return;
    whatIf = next;
    renderWhatIf();
  });
}
$("whatif-out").addEventListener("click", (e) => { if ((e.target as HTMLElement).id === "wi-reset") { whatIf = null; renderWhatIf(); } });

// ---------- chute sizing ----------
type ChuteCfg = { dv: number; mv: number | null; dcd: number; mcd: number };
function chuteCfg(): ChuteCfg {
  try { const c = JSON.parse(localStorage.getItem("dc.chute") ?? "null"); if (c) return c; } catch { /* ignore */ }
  return { dv: 100, mv: null, dcd: 1.5, mcd: 2.2 };
}
function renderChute(phases: ReturnType<typeof descentPhases>, weight: number | null, rebuild = true) {
  const c = chuteCfg();
  const heaviest = Math.max(0, ...recovery.sections.map((x) => x.massLb));
  // default main target: the fastest landing that keeps the heaviest section under the KE limit, minus 10%
  const keV = heaviest > 0 ? vMaxFor(heaviest, recovery.keLimit) : null;
  const mv = c.mv ?? (keV ? Math.floor(keV * 0.9) : 18);
  if (rebuild) {
    $<HTMLInputElement>("chute-dv").value = String(c.dv);
    $<HTMLInputElement>("chute-mv").value = String(mv);
    $<HTMLInputElement>("chute-dcd").value = String(c.dcd);
    $<HTMLInputElement>("chute-mcd").value = String(c.mcd);
  }
  if (!weight) {
    $("chute-sub").textContent = "Enter the recovery section masses to size the parachutes.";
    $("chute-table").innerHTML = "";
    return;
  }
  $("chute-sub").textContent = `For ${show(weight, "lb", 1)} at sea-level air. ${c.mv === null && keV ? `Main target defaults to 90% of ${keV.toFixed(1)} ft/s, the fastest landing that keeps the heaviest section (${heaviest} lb) under ${recovery.keLimit} ft-lbf.` : ""} Cd: about 1.5 for a flat or elliptical chute, 2.2 for a toroidal one; use the maker's value if you have it.`;
  const row = (label: string, target: number, cd: number, flown?: { rate: number; cdA: number | null }) => {
    const need = diameterFor(weight, target, cd);
    const was = flown?.cdA ? diameterFromCdA(flown.cdA, cd) : null;
    return `<tr><td>${label}</td><td>${conv(need, "in")[0].toFixed(0)} ${cu("in")}</td><td>${was !== null ? `${conv(was, "in")[0].toFixed(0)} ${cu("in")}` : "-"}</td><td>${flown ? show(Math.abs(flown.rate), "ft/s", 1) : "-"}</td></tr>`;
  };
  const drog = phases.find((p) => p.name === "Drogue"), main = phases.find((p) => p.name === "Main");
  $("chute-table").innerHTML = `<tr><th>Chute</th><th>Needed</th><th>Flown acted like</th><th>Flown rate</th></tr>${row("Drogue", c.dv, c.dcd, drog)}${row("Main", mv, c.mcd, main)}`;
}
for (const id of ["chute-dv", "chute-mv", "chute-dcd", "chute-mcd"]) {
  $(id).addEventListener("change", () => {
    const n = (k: string) => { const x = parseFloat($<HTMLInputElement>(k).value); return Number.isFinite(x) && x > 0 ? x : null; };
    const c = chuteCfg();
    c.dv = n("chute-dv") ?? c.dv; c.mv = n("chute-mv"); c.dcd = n("chute-dcd") ?? c.dcd; c.mcd = n("chute-mcd") ?? c.mcd;
    try { localStorage.setItem("dc.chute", JSON.stringify(c)); } catch { /* ignore */ }
    renderDescent();
  });
}

function renderWind() {
  const w = flight?.gps && A ? windProfile(flight.gps, A) : null;
  $("wind").hidden = !w;
  if (!w) return;
  const max = Math.max(...w.bins.map((b) => b.speed), 1);
  const spd = (v: number) => show(v * 0.681818, "mph");
  $("wind-sub").textContent = `Average ${spd(w.mean.speed)} from the ${compassName(w.mean.fromDeg)} (${w.mean.fromDeg.toFixed(0)}°). Under a settled parachute the rocket drifts at about the wind speed, so this is the wind it flew through, not a forecast. ${SETTLE_HINT}`;
  $("wind-table").innerHTML = `<tr><th>Altitude (${cu("ft")} AGL)</th><th>Speed</th><th>From</th></tr>${w.bins
    .map((b) => `<tr title="${b.n} GPS samples. Arrow shows where the wind blows toward."><td>${conv(b.lo, "ft")[0].toFixed(0)}-${conv(b.hi, "ft")[0].toFixed(0)}</td><td><span class="spd">${spd(b.speed)}<span class="bar" style="width:${((b.speed / max) * 100).toFixed(0)}%"></span></span></td><td><span class="arrow" style="transform:rotate(${(b.fromDeg + 180).toFixed(0)}deg)" aria-hidden="true">↑</span>${compassName(b.fromDeg)} ${b.fromDeg.toFixed(0)}°</td></tr>`)
    .join("")}`;
}
const SETTLE_HINT = "The first 4 s after each deployment are skipped while the chute settles.";

// ---------- coast drag ----------
let coastPlot: uPlot | null = null;
type CoastCfg = { massLb: number | null; diaIn: number };
// the vehicle these numbers belong to: the saved flight's vehicle name, or this browser's default
let vehicleKey = "default";
let vehicleLabel = "";
function coastCfg(): CoastCfg {
  const v = getVehicle(vehicleKey);
  return { massLb: v.burnoutLb, diaIn: v.diaIn };
}
function renderCoast(rebuildInputs = true) {
  const ok = !!(A && flight?.hr && A.axialAccel);
  $("coast-panel").hidden = !ok;
  if (!ok) return;
  const cfg = coastCfg();
  const sectionSum = recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0);
  const mass = cfg.massLb ?? sectionSum;
  if (rebuildInputs) {
    $<HTMLInputElement>("coast-mass").value = mass ? conv(mass, "lb")[0].toFixed(1) : "";
    $<HTMLInputElement>("coast-dia").value = conv(cfg.diaIn, "in")[0].toFixed(2);
    $("coast-mass").parentElement!.firstChild!.textContent = `Mass after burnout (${cu("lb")})`;
    $("coast-dia").parentElement!.firstChild!.textContent = `Body diameter (${cu("in")})`;
  }
  $("coast-sub").textContent = `After burnout the accelerometer reads drag directly, so Cd = 2·m·a / (ρ·v²·A). ${cfg.massLb === null ? "Mass defaults to the recovery section total; enter the real burnout mass." : ""}`;
  const d = coastDrag(flight!, A!, mass, cfg.diaIn);
  coastPlot?.destroy();
  coastPlot = null;
  const host = $("coast-chart");
  host.innerHTML = "";
  if (!d) {
    $("coast-cd").innerHTML = '<span class="lbl">Not enough coast above 120 ft/s to estimate Cd.</span>';
    return;
  }
  $("coast-cd").innerHTML = `<span class="big">${d.cd50.toFixed(2)}</span><span class="lbl">median Cd, Mach ${d.machMin.toFixed(2)} to ${d.machMax.toFixed(2)}, ${d.n} samples${d.cutBy ? `. Stopped at ${escapeHtml(d.cutBy.label)} (T+${d.cutBy.t.toFixed(2)}), which fired before apogee.` : ""}</span>`;
  const order = d.mach.map((_, i) => i).sort((i, j) => d.mach[i] - d.mach[j]);
  coastPlot = new uPlot({
    width: Math.max(220, host.clientWidth || 320),
    height: 160,
    legend: { show: false },
    cursor: { y: false },
    scales: { x: { time: false } },
    axes: [
      { stroke: axisColor(), label: "Mach", labelSize: 20, size: 34, grid: { stroke: gridColor(), width: 1 }, font: "11px Barlow, system-ui", labelFont: "11px Barlow, system-ui" },
      { stroke: axisColor(), label: "Cd", labelSize: 20, size: 40, grid: { stroke: gridColor(), width: 1 }, font: "11px Barlow, system-ui", labelFont: "11px Barlow, system-ui" },
    ],
    series: [{}, { stroke: "#f5c26b", width: 0, points: { show: true, size: 3, fill: "#f5c26b", stroke: "#f5c26b" }, paths: () => null }],
  }, [order.map((i) => d.mach[i]), order.map((i) => d.cd[i])], host);
}
// ---------- fin flutter ----------
const FIN_IDS = ["fl-root", "fl-tip", "fl-span", "fl-thick", "fl-g"] as const;
$("fl-mat").innerHTML = MATERIALS.map((m) => `<option value="${m.gPsi}">${escapeHtml(m.name)}</option>`).join("") + '<option value="custom">Other (enter G)</option>';
function renderFlutter(rebuildInputs = true) {
  $("flutter-panel").hidden = !A;
  if (!A || !flight) return;
  const fin = getVehicle(vehicleKey).fin;
  if (rebuildInputs) {
    const vals = fin ? [fin.rootIn, fin.tipIn, fin.spanIn, fin.thickIn, fin.gPsi] : [null, null, null, null, MATERIALS[0].gPsi];
    FIN_IDS.forEach((id, i) => { $<HTMLInputElement>(id).value = vals[i] === null ? "" : String(vals[i]); });
    const g = fin?.gPsi ?? MATERIALS[0].gPsi;
    $<HTMLSelectElement>("fl-mat").value = MATERIALS.some((m) => m.gPsi === g) ? String(g) : "custom";
  }
  if (!fin) {
    $("flutter-sub").textContent = "Enter one fin's root chord, tip chord, span (body tube to tip) and thickness to compare its flutter speed with how fast this flight went.";
    $("flutter-stats").innerHTML = "";
    return;
  }
  const r = flutterMargin(flight, A, fin);
  $("flutter-sub").textContent = "Flutter speed from the simplified NACA TN 4197 method (Peak of Flight #291), using the logged pressure and temperature at each point of the climb. A common rule of thumb is a margin of at least 1.5×. It assumes a solid, well-bonded fin of one material.";
  if (!r) { $("flutter-stats").innerHTML = '<span class="muted small">No climb above 50 ft/s found.</span>'; return; }
  const ok = r.minRatio >= 1.5;
  $("flutter-stats").innerHTML = `
    <div class="wide"><span class="k">Smallest margin</span><span class="v ${ok ? "ok" : "bad"}">${r.minRatio.toFixed(2)}×</span><span class="k">flutter speed ${show(r.vfAt, "ft/s")} vs ${show(r.vAt, "ft/s")} flown, at T+${r.tAt.toFixed(1)} s and ${show(r.altAt, "ft")}</span></div>
    <div><span class="k">Max speed flown</span><span class="v">${show(r.maxV, "ft/s")}</span></div>`;
}
function flutterInput(e: Event) {
  const num = (id: string) => { const x = parseFloat($<HTMLInputElement>(id).value); return Number.isFinite(x) && x > 0 ? x : null; };
  const sel = $<HTMLSelectElement>("fl-mat");
  if (e.target === sel && sel.value !== "custom") $<HTMLInputElement>("fl-g").value = sel.value;
  const [root, tip, span, thick, g] = FIN_IDS.map(num);
  const v = getVehicle(vehicleKey);
  v.fin = root && span && thick && g ? { rootIn: root, tipIn: tip ?? 0, spanIn: span, thickIn: thick, gPsi: g } : undefined;
  setVehicle(vehicleKey, v);
  renderFlutter(false);
}
for (const id of [...FIN_IDS, "fl-mat"]) $(id).addEventListener("change", flutterInput);

// ---------- rail exit ----------
function liftoffHtml(th: { t: number[]; thrustLbf: number[] }, liftoffLb: number): string {
  // thrust-to-weight over the first 0.3 s of motion, and how long thrust took to come up
  const t0 = th.t[0];
  const early = th.thrustLbf.filter((_, i) => th.t[i] - t0 <= 0.3);
  const avg = early.reduce((a, b) => a + b, 0) / Math.max(1, early.length);
  const peak = Math.max(...th.thrustLbf);
  const i90 = th.thrustLbf.findIndex((x) => x >= 0.9 * peak);
  const tw = avg / liftoffLb;
  return `<div><span class="k">Liftoff thrust-to-weight</span><span class="v">${tw.toFixed(1)} : 1</span><span class="k">first 0.3 s, ${show(liftoffLb, "lb", 1)} at liftoff</span></div>
    <div><span class="k">Thrust rise</span><span class="v">${i90 >= 0 ? (th.t[i90] - t0 < 0.01 ? "under 0.01 s" : `${(th.t[i90] - t0).toFixed(2)} s`) : "-"}</span><span class="k">first motion to 90% of peak</span></div>`;
}

function railHtml(): string {
  if (!A || !flight) return "";
  const rail = getVehicle(vehicleKey).railFt;
  const re = railExit(flight, A, rail);
  if (!re) return `<div class="wide"><span class="k">Rail exit speed</span><span class="v">-</span><span class="k">Couldn't find first motion in the accelerometer.</span></div>`;
  const ok = re.v >= SL_MIN_RAIL_EXIT;
  // angle of attack the ground wind puts on the rocket as it leaves the rail: the reason it weathercocks
  let aoa = "";
  const w = flight.gps ? windProfile(flight.gps, A) : null;
  if (w) {
    const low = w.bins[w.bins.length - 1];
    const deg = (Math.atan2(low.speed, re.v) * 180) / Math.PI;
    const boT = A.events.find((e) => e.key === "burnout")?.t;
    const tiltBo = boT !== undefined ? flight.lr!.tilt[indexAt(flight.lr!.t, boT)] : null;
    aoa = `<div class="wide"><span class="k">Angle of attack at rail exit</span><span class="v">${deg.toFixed(1)}°</span><span class="k">${show(low.speed * 0.681818, "mph")} of wind at ${conv(low.lo, "ft")[0].toFixed(0)}-${show(low.hi, "ft")} (GPS drift) across ${show(re.v, "ft/s")}. The rocket turns into the wind by about this much${tiltBo !== null ? `; it was tilted ${tiltBo.toFixed(1)}° at burnout` : ""}. A faster rail exit or a longer rail lowers it.</span></div>`;
  }
  return `<div class="wide"><span class="k">Rail exit speed (${show(rail, "ft", 1)} of rail travel)</span><span class="v ${ok ? "ok" : "bad"}">${show(re.v, "ft/s", 0)}</span><span class="k">${ok ? "Above" : "Below"} the ${show(SL_MIN_RAIL_EXIT, "ft/s")} Student Launch minimum. Left the rail ${(re.t - re.start).toFixed(2)} s after first motion. Set the rail travel in the Vehicle card.</span></div>${aoa}`;
}

// ---------- motor (thrust from the accelerometer) ----------
let motorPlot: uPlot | null = null;
type MotorCfg = { propLb: number | null; ratedNs: number | null };
function motorCfg(): MotorCfg {
  const v = getVehicle(vehicleKey);
  return { propLb: v.propLb, ratedNs: v.ratedNs };
}
function renderMotor(rebuildInputs = true) {
  const ok = !!(A && flight?.hr && A.axialAccel);
  $("motor-panel").hidden = !ok;
  if (!ok) return;
  const cc = coastCfg(), mc = motorCfg();
  const sectionSum = recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0);
  const burnout = cc.massLb ?? sectionSum;
  const prop = mc.propLb ?? 0;
  if (rebuildInputs) {
    $<HTMLInputElement>("motor-prop").value = mc.propLb !== null ? conv(mc.propLb, "lb")[0].toFixed(2) : "";
    $<HTMLInputElement>("motor-rated").value = mc.ratedNs !== null ? String(mc.ratedNs) : "";
    $("motor-prop").parentElement!.firstChild!.textContent = `Propellant mass (${cu("lb")})`;
  }
  const coast = coastDrag(flight!, A!, burnout, cc.diaIn);
  const cd = coast?.cd50 ?? 0.45;
  $("motor-sub").textContent = `Thrust = mass × axial acceleration + drag, with drag from ${coast ? `the coast Cd (${cd.toFixed(2)})` : "a Cd of 0.45 (no coast estimate)"}. Uses the masses and diameter from the Vehicle card${mc.propLb === null ? "; add the propellant mass so the mass falls as it burns" : ""}. Ignition-to-liftoff delay can't be measured: the Blue Raven doesn't log when the igniter fired, and the rail holds the reading at 1 g until the rocket moves.`;
  const th = thrustCurve(flight!, A!, burnout, prop, cc.diaIn, cd);
  motorPlot?.destroy(); motorPlot = null;
  const host = $("motor-chart"); host.innerHTML = "";
  if (!th) { $("motor-stats").innerHTML = '<span class="muted small">No boost phase found.</span>'; return; }
  const rated = mc.ratedNs;
  const vsRated = rated ? `${th.impulseNs >= rated ? "+" : ""}${(((th.impulseNs - rated) / rated) * 100).toFixed(0)}% vs rated` : "";
  const f = (n: number) => (getUnits() === "imperial" ? `${(n / 4.448222).toFixed(0)} lbf` : `${n.toFixed(0)} N`);
  $("motor-stats").innerHTML = `
    <div class="wide"><span class="k">Measured class</span><span class="v cls">${th.motorClass}</span></div>
    <div><span class="k">Total impulse</span><span class="v">${th.impulseNs.toFixed(0)} N·s</span>${vsRated ? `<span class="k">${vsRated}</span>` : ""}</div>
    <div><span class="k">Burn time</span><span class="v">${th.burnTime.toFixed(2)} s</span></div>
    <div><span class="k">Average thrust</span><span class="v">${f(th.avgN)}</span></div>
    <div><span class="k">Peak thrust</span><span class="v">${f(th.peakN)}</span></div>${liftoffHtml(th, burnout + prop)}${railHtml()}`;
  const k = getUnits() === "imperial" ? 1 : 4.448222;
  const thrustCmps = cmps.filter((c) => c.trace.thrust);
  const liftMine = A!.events.find((e) => e.key === "liftoff")?.t ?? 0;
  motorPlot = new uPlot({
    width: Math.max(220, host.clientWidth || 320), height: 160, legend: { show: false }, cursor: { y: false }, scales: { x: { time: false } },
    axes: [
      { stroke: axisColor(), label: "Flight time (s)", labelSize: 20, size: 34, grid: { stroke: gridColor(), width: 1 }, font: "11px Barlow, system-ui", labelFont: "11px Barlow, system-ui" },
      { stroke: axisColor(), label: `Thrust (${getUnits() === "imperial" ? "lbf" : "N"})`, labelSize: 20, size: 48, grid: { stroke: gridColor(), width: 1 }, font: "11px Barlow, system-ui", labelFont: "11px Barlow, system-ui" },
    ],
    series: [{}, { stroke: "#ff7a1a", width: 1.5, fill: "rgba(255,122,26,0.12)", points: { show: false } },
      ...thrustCmps.map((c) => ({ stroke: c.color, width: 1.5, dash: [6, 4], points: { show: false } }))],
  }, [th.t, th.thrustLbf.map((x) => x * k), ...thrustCmps.map((c) => th.t.map((x) => { const v = sampleAt(c.trace.thrust!.t, c.trace.thrust!.lbf, x - liftMine - c.offset); return Number.isFinite(v) ? v * k : null; }))] as uPlot.AlignedData, host);
  $("motor-cmp").innerHTML = thrustCmps.map((c) => `<span><i class="sw" style="background:${c.color}"></i>${escapeHtml(c.trace.name)}: ${(c.trace.thrust!.lbf.reduce((s2, v, i, arr) => s2 + (i ? v * (c.trace.thrust!.t[i] - c.trace.thrust!.t[i - 1]) : 0), 0) * 4.448222).toFixed(0)} N·s</span>`).join("");
}
function motorInput() {
  const mc = motorCfg();
  const p = parseFloat($<HTMLInputElement>("motor-prop").value);
  const r = parseFloat($<HTMLInputElement>("motor-rated").value);
  mc.propLb = Number.isFinite(p) && p >= 0 ? p / conv(1, "lb")[0] : null;
  mc.ratedNs = Number.isFinite(r) && r > 0 ? r : null;
  setVehicle(vehicleKey, { ...getVehicle(vehicleKey), propLb: mc.propLb, ratedNs: mc.ratedNs });
  renderVehicle();
  renderMotor(false);
}
$("motor-prop").addEventListener("change", motorInput);
$("motor-rated").addEventListener("change", motorInput);

function coastInput() {
  const cfg = coastCfg();
  const m = parseFloat($<HTMLInputElement>("coast-mass").value);
  const dia = parseFloat($<HTMLInputElement>("coast-dia").value);
  if (Number.isFinite(m) && m > 0) cfg.massLb = m / conv(1, "lb")[0];
  if (Number.isFinite(dia) && dia > 0) cfg.diaIn = dia / conv(1, "in")[0];
  setVehicle(vehicleKey, { ...getVehicle(vehicleKey), burnoutLb: cfg.massLb, diaIn: cfg.diaIn });
  renderCoast(false);
  renderMotor(false);
  renderVehicle();
}

/** accelerometer and air-data numbers kept with a saved flight so the library can trend them */
function measuredStats() {
  if (!A || !flight) return {};
  const aero = aeroSeries(flight, A);
  const lr = flight.lr!;
  const lift = A.events.find((e) => e.key === "liftoff")?.t ?? 0;
  const land = A.events.find((e) => e.key === "landing")?.t ?? lr.t[lr.n - 1];
  let pad = NaN, low = Infinity;
  for (let i = 0; i < lr.n; i++) {
    const v = lr.battV[i];
    if (!Number.isFinite(v)) continue;
    if (lr.t[i] < lift) pad = v; else if (lr.t[i] <= land) low = Math.min(low, v);
  }
  const dataWarnings = findFindings(flight, A).filter((x) => /Gaps in|clipped|overloaded|clock|UNIX time|lost satellites|drifted from GPS/i.test(x.title)).length;
  const out: {
    coastCd?: number | null; impulseNs?: number | null; maxQ?: number | null; maxMach?: number | null;
    padBattV?: number | null; minBattV?: number | null; dataWarnings?: number | null;
  } = {
    maxQ: aero?.maxQ ?? null, maxMach: aero?.maxMach ?? null,
    padBattV: Number.isFinite(pad) ? pad : null, minBattV: Number.isFinite(low) ? low : null, dataWarnings,
  };
  if (flight.hr && A.axialAccel) {
    const cc = coastCfg(), mc = motorCfg();
    const m = cc.massLb ?? recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0);
    const cd = coastDrag(flight, A, m, cc.diaIn)?.cd50 ?? null;
    out.coastCd = cd;
    out.impulseNs = thrustCurve(flight, A, m, mc.propLb ?? 0, cc.diaIn, cd ?? 0.45)?.impulseNs ?? null;
  }
  return out;
}

// ---------- vehicle card ----------
const vIn = (id: string) => $<HTMLInputElement>(id);
function renderVehicle() {
  $("veh-panel").hidden = !A;
  if (!A) return;
  const v = getVehicle(vehicleKey);
  const lb = (x: number | null) => (x === null ? "" : conv(x, "lb")[0].toFixed(2));
  if (!document.activeElement?.closest("#veh-panel")) {
    vIn("veh-burnout").value = lb(v.burnoutLb);
    vIn("veh-prop").value = lb(v.propLb);
    vIn("veh-dia").value = conv(v.diaIn, "in")[0].toFixed(2);
    vIn("veh-rated").value = v.ratedNs === null ? "" : String(v.ratedNs);
    vIn("veh-rail").value = conv(v.railFt, "ft")[0].toFixed(1);
  }
  for (const [id, label] of [["veh-burnout", `Burnout mass (${cu("lb")})`], ["veh-prop", `Propellant (${cu("lb")})`], ["veh-dia", `Body diameter (${cu("in")})`], ["veh-rail", `Rail travel (${cu("ft")})`]] as const)
    $(id).parentElement!.firstChild!.textContent = label;
  const sections = recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0);
  const notes: string[] = [];
  if (v.burnoutLb !== null) notes.push(`Liftoff mass ${show(v.burnoutLb + (v.propLb ?? 0), "lb", 1)}.`);
  if (v.burnoutLb !== null && sections > 0 && Math.abs(sections - v.burnoutLb) / v.burnoutLb > 0.1)
    notes.push(`The recovery sections add up to ${show(sections, "lb", 1)}, ${sections > v.burnoutLb ? "more" : "less"} than the burnout mass; one of them is probably out of date.`);
  if (v.burnoutLb === null) notes.push("Coast drag and Motor use the recovery section total until you enter a burnout mass.");
  $("veh-sub").textContent = `${vehicleLabel ? `Saved for ${vehicleLabel}.` : "Saved in this browser for flights without a vehicle name."} Coast drag and Motor read these numbers.`;
  $("veh-notes").textContent = notes.join(" ");
}
function vehicleInput() {
  const v = getVehicle(vehicleKey);
  const num = (id: string) => { const x = parseFloat(vIn(id).value); return Number.isFinite(x) && x >= 0 ? x : null; };
  const b = num("veh-burnout"), pr = num("veh-prop"), d = num("veh-dia"), r = num("veh-rated"), rl = num("veh-rail");
  if (rl !== null && rl > 0) v.railFt = rl / conv(1, "ft")[0];
  v.burnoutLb = b !== null && b > 0 ? b / conv(1, "lb")[0] : null;
  v.propLb = pr !== null ? pr / conv(1, "lb")[0] : null;
  if (d !== null && d > 0) v.diaIn = d / conv(1, "in")[0];
  v.ratedNs = r !== null && r > 0 ? r : null;
  setVehicle(vehicleKey, v);
  renderVehicle();
  renderCoast();
  renderMotor();
  renderSL();
}
for (const id of ["veh-burnout", "veh-prop", "veh-dia", "veh-rated", "veh-rail"]) $(id).addEventListener("change", vehicleInput);
async function loadVehicleKey() {
  const e = currentEntryId ? await getEntry(currentEntryId) : undefined;
  vehicleLabel = e?.vehicle?.trim() ?? "";
  vehicleKey = vehicleKeyOf(vehicleLabel);
  renderVehicle();
  renderDescent();
  findPreviousFlight(e);
}

// ---------- compare with the previous flight of the same vehicle ----------
let previousEntry: LibraryEntry | null = null;
async function findPreviousFlight(cur?: LibraryEntry) {
  previousEntry = null;
  const btn = $("cmp-last");
  btn.hidden = true;
  if (!cur?.vehicle?.trim()) return;
  const key = vehicleKeyOf(cur.vehicle);
  const when = (x: LibraryEntry) => `${x.date || ""}|${x.savedAt}`;
  const earlier = (await listEntries())
    .filter((x) => x.kind === "flight" && x.id !== cur.id && vehicleKeyOf(x.vehicle) === key && when(x) < when(cur))
    .sort((a, b) => when(b).localeCompare(when(a)));
  previousEntry = earlier[0] ?? null;
  if (!previousEntry || cmps.some((c) => c.trace.name.includes(previousEntry!.name))) return;
  btn.textContent = `Previous ${cur.vehicle.trim()} flight: ${previousEntry.name}${previousEntry.date ? ` (${previousEntry.date})` : ""}`;
  btn.hidden = cmps.length >= MAX_COMPARES;
}
$("cmp-last").addEventListener("click", async () => {
  if (!previousEntry) return;
  $("cmp-last").hidden = true;
  await loadCompare(previousEntry.files);
});
$("coast-mass").addEventListener("change", coastInput);
$("coast-dia").addEventListener("change", coastInput);

// ---------- findings ----------
function renderFindings() {
  $("find-panel").hidden = !A;
  if (!A || !flight) return;
  const list = findFindings(flight, A);
  $("findings").innerHTML = list
    .map((fd) => `<li class="${fd.level}"${fd.t !== undefined ? ` data-t="${fd.t}" title="Jump to T+${fd.t.toFixed(2)} s" tabindex="0"` : ""}><div class="ft">${escapeHtml(fd.title)}${fd.t !== undefined ? `<span>T+${fd.t.toFixed(1)}</span>` : ""}</div><div class="fd">${escapeHtml(fd.detail)}</div></li>`)
    .join("");
}
$("findings").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li[data-t]") as HTMLElement | null;
  if (li) seek(parseFloat(li.dataset.t!));
});

// ---------- recovery check ----------
function recoveryInputs() {
  const k = keyNumbersOf(A!);
  const apo = A!.events.find((e) => e.key === "apogee")?.t;
  const land = A!.events.find((e) => e.key === "landing")?.t;
  return {
    apogee: k.apogee,
    landingSpeed: k.mainRate !== null ? Math.abs(k.mainRate) : null,
    descentTime: apo !== undefined && land !== undefined ? land - apo : null,
    drift: k.drift,
  };
}

// ---------- Student Launch checks: the flight-data requirements in one place ----------
function renderSL() {
  $("sl-panel").hidden = !A;
  if (!A || !flight) return;
  type Row = { label: string; value: string; limit: string; verdict: "pass" | "fail" | "na"; note?: string };
  const rows: Row[] = [];
  const re = railExit(flight, A, getVehicle(vehicleKey).railFt);
  rows.push({
    label: "Rail exit speed", value: re ? show(re.v, "ft/s") : "-", limit: `≥ ${show(SL_MIN_RAIL_EXIT, "ft/s")}`,
    verdict: re ? (re.v >= SL_MIN_RAIL_EXIT ? "pass" : "fail") : "na", note: `${show(getVehicle(vehicleKey).railFt, "ft", 1)} of rail travel (Vehicle card)`,
  });
  const ae = aeroSeries(flight, A);
  rows.push({ label: "Stays subsonic", value: ae ? `Mach ${ae.maxMach.toFixed(2)}` : "-", limit: "< Mach 1", verdict: ae ? (ae.maxMach < 1 ? "pass" : "fail") : "na" });
  const k = keyNumbersOf(A);
  rows.push({
    label: "Apogee in the 4,000 to 6,000 ft band", value: show(k.apogee, "ft"), limit: "4000 to 6000 ft",
    verdict: k.apogee === null ? "na" : k.apogee >= 4000 && k.apogee <= 6000 ? "pass" : "fail",
  });
  const rec = evaluate(recovery, recoveryInputs());
  for (const r of rec.rows) rows.push({ label: r.label === "Drift from pad" ? "Drift from pad" : r.label, value: r.value, limit: r.limit, verdict: r.verdict, note: r.sub ?? r.note });
  const fails = rows.filter((r) => r.verdict === "fail").length, passes = rows.filter((r) => r.verdict === "pass").length;
  $("sl-sub").textContent = `${passes} pass, ${fails} over the limit. Limits are from recent Student Launch handbooks; confirm them against this year's. Section masses, limits and the declared target are set in the Recovery check.`;
  $("sl-list").innerHTML = rows.map((r) => `<li class="${r.verdict}"><span class="mark" aria-hidden="true">${r.verdict === "pass" ? "✓" : r.verdict === "fail" ? "✕" : "–"}</span><span class="lbl">${escapeHtml(r.label)}${r.note ? `<small>${escapeHtml(r.note)}</small>` : ""}</span><span class="val">${escapeHtml(r.value)}</span><span class="lim">${escapeHtml(r.limit)}</span><span class="sr-only">${r.verdict === "pass" ? "pass" : r.verdict === "fail" ? "over the limit" : "not checked"}</span></li>`).join("");
}

function renderRecovery() {
  $("rec-panel").hidden = !A;
  renderSL();
  if (!A) return;
  const x = recoveryInputs();
  $("rec-sub").textContent = x.landingSpeed !== null
    ? `Landing speed ${show(x.landingSpeed, "ft/s", 1)}, from the main descent fit.`
    : "No main descent found, so landing energy can't be computed.";
  const r = evaluate(recovery, x);
  $("rec-table").innerHTML = r.rows
    .map((row) => `<tr${row.note ? ` title="${escapeHtml(row.note)}"` : ""}><td>${escapeHtml(row.label)}${row.sub ? `<small>${escapeHtml(row.sub)}</small>` : ""}</td><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.limit)}</td><td><span class="verdict ${row.verdict}">${row.verdict === "pass" ? "Pass" : row.verdict === "fail" ? "Over" : "-"}</span></td></tr>`)
    .join("");
  // editor
  $("rec-sections").innerHTML = recovery.sections
    .map((sct, i) => `<div class="rec-row"><input class="name" data-i="${i}" data-f="name" value="${escapeHtml(sct.name)}" aria-label="Section name" /><input class="mass" type="number" step="0.1" data-i="${i}" data-f="mass" value="${sct.massLb}" aria-label="Mass in lb" /> lb<button class="x" type="button" data-rm="${i}" aria-label="Remove section">×</button></div>`)
    .join("");
  $<HTMLInputElement>("rec-target").value = recovery.targetApogeeFt ? String(recovery.targetApogeeFt) : "";
  $<HTMLInputElement>("rec-ke").value = String(recovery.keLimit);
  $<HTMLInputElement>("rec-desc").value = String(recovery.descentLimit);
  $<HTMLInputElement>("rec-drift").value = String(recovery.driftLimit);
}

async function recoveryChanged() {
  renderRecoveryTableOnly();
  renderSL();
  renderDescent();
  renderVehicle();
  if (currentEntryId) {
    const e = await getEntry(currentEntryId);
    if (e) await putEntry({ ...e, recovery });
  }
}
function renderRecoveryTableOnly() {
  // re-render without rebuilding the inputs the user is typing in
  const keepFocus = document.activeElement as HTMLElement | null;
  const x = recoveryInputs();
  const r = evaluate(recovery, x);
  $("rec-table").innerHTML = r.rows
    .map((row) => `<tr${row.note ? ` title="${escapeHtml(row.note)}"` : ""}><td>${escapeHtml(row.label)}${row.sub ? `<small>${escapeHtml(row.sub)}</small>` : ""}</td><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.limit)}</td><td><span class="verdict ${row.verdict}">${row.verdict === "pass" ? "Pass" : row.verdict === "fail" ? "Over" : "-"}</span></td></tr>`)
    .join("");
  keepFocus?.focus();
}

function renderGps() {
  const g = A!.gps;
  const panel = $("gps-panel");
  panel.hidden = !g;
  if (!g || !flight?.gps) return;
  $("gps-sub").textContent = `${flight.gps.name}, aligned ${g.manual ? "manually" : "automatically"}. Heading fit ${(((g.yaw * 180) / Math.PI + 360) % 360).toFixed(0)}°, ascent mismatch ${show(g.ascentRms, "ft")} RMS.`;
  const rows = g.rows.map((r) => {
    let diff = "";
    if (r.br !== null && r.gps !== null && Number.isFinite(r.br) && Number.isFinite(r.gps)) {
      const d = r.br - r.gps;
      const rel = Math.abs(r.gps) > 1e-6 ? Math.abs(d / r.gps) : 0;
      diff = `<span class="diff${rel > 0.05 ? " big" : ""}">${d >= 0 ? "+" : ""}${fmt(d, r.unit)}</span>`;
    }
    return `<tr${r.note ? ` title="${escapeHtml(r.note)}"` : ""}><td>${escapeHtml(r.label)}</td><td>${fmt(r.br, r.unit)}</td><td>${fmt(r.gps, r.unit)}</td><td>${diff}</td><td class="unit">${cu(r.unit)}</td></tr>`;
  });
  $("compare").className = "metrics cmp";
  $("compare").innerHTML = `<tr><th>Metric</th><th>Blue Raven</th><th>GPS</th><th>Δ</th><th><span class="sr-only">Unit</span></th></tr>${rows.join("")}`;
  const L = g.landing;
  const ll = `${L.lat.toFixed(6)}, ${L.lon.toFixed(6)}`;
  const q = `${L.lat.toFixed(6)},${L.lon.toFixed(6)}`;
  const gp = flight.gps;
  const land = A!.events.find((e) => e.key === "landing")?.t;
  const apo = A!.events.find((e) => e.key === "apogee")?.t;
  $("gps-landing").innerHTML = `
    <div class="land-card">
      <div class="land-top">
        <span class="land-arrow" style="transform:rotate(${L.bearing.toFixed(0)}deg)" aria-hidden="true">↑</span>
        <div>
          <div class="land-dist">${show(L.distance, "ft")}</div>
          <div class="muted small">from the pad toward ${compassName(L.bearing)} (${L.bearing.toFixed(0)}° true)${land !== undefined && apo !== undefined ? `, ${(land - apo).toFixed(0)} s under canopy` : ""}</div>
        </div>
      </div>
      <div class="land-ll"><code id="land-ll">${ll}</code><button class="btn small-btn" id="land-copy" type="button">Copy</button></div>
      <div class="land-actions">
        <a class="btn small-btn" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Open in Maps</a>
        <a class="btn small-btn" href="https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=walking" target="_blank" rel="noopener">Walking directions</a>
        <button class="btn small-btn" id="land-gpx" type="button" title="Pad and landing as waypoints, plus the flight track, for a phone GPS app">GPX</button>
      </div>
      <div class="muted small">Pad ${gp.padLat.toFixed(6)}, ${gp.padLon.toFixed(6)}. Landing is the GPS fix at touchdown.</div>
    </div>`;
  $<HTMLInputElement>("gps-offset").value = g.offset.toFixed(2);
}

$("gps-landing").addEventListener("click", async (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.id === "land-copy") {
    const txt = $("land-ll").textContent ?? "";
    try { await navigator.clipboard.writeText(txt); tgt.textContent = "Copied"; }
    catch { getSelection()?.selectAllChildren($("land-ll")); tgt.textContent = "Selected"; }
    setTimeout(() => (tgt.textContent = "Copy"), 1500);
  } else if (tgt.id === "land-gpx" && A?.gps && flight?.gps) {
    const gp = flight.gps, L = A.gps.landing;
    const esc = (x: string) => x.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]!);
    const name = esc(currentEntryName ?? gp.name);
    const trk: string[] = [];
    for (let i = 0; i < gp.n; i++) {
      if (!gp.fix[i] || !Number.isFinite(gp.lat[i]) || !Number.isFinite(gp.lon[i]) || (gp.lat[i] === 0 && gp.lon[i] === 0)) continue;
      trk.push(`<trkpt lat="${gp.lat[i].toFixed(7)}" lon="${gp.lon[i].toFixed(7)}"><ele>${(gp.altAsl[i] * 0.3048).toFixed(1)}</ele></trkpt>`);
    }
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Data Compare" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="${gp.padLat.toFixed(7)}" lon="${gp.padLon.toFixed(7)}"><name>Pad</name></wpt>
<wpt lat="${L.lat.toFixed(7)}" lon="${L.lon.toFixed(7)}"><name>Landing: ${name}</name></wpt>
<trk><name>${name}</name><trkseg>
${trk.join("\n")}
</trkseg></trk>
</gpx>`;
    downloadBlob(`${fileSlug(currentEntryName ?? gp.name)}.gpx`, new Blob([gpx], { type: "application/gpx+xml" }));
  }
});

function reanalyze() {
  if (!flight) return;
  const keep = t;
  try {
    A = analyze(flight, { gpsOffset: gpsOffsetOverride });
    showWarnings(A.warnings);
    showFlight();
    seek(keep);
  } catch (e) {
    showWarnings([(e as Error).message]);
  }
}

function renderEvents() {
  const p = A!.path;
  const ej = new Map(ejectionTimes(flight!, A!).map((x) => [x.key, x]));
  $("events").innerHTML = A!.events
    .map((e, i) => {
      const alt = p.y[indexAt(p.t, e.t)];
      const x = ej.get(e.key);
      const shock = x
        ? `<span class="ej${x.delay === null ? " none" : x.delay > 0.5 ? " slow" : ""}" title="Jolt: first acceleration spike after the fire (the charge separating the airframe). Biggest load: largest spike in the next 6 s, usually the parachute opening.">${x.delay === null ? "no jolt seen within 3 s" : `jolt +${x.delay.toFixed(2)} s, ${x.peakG!.toFixed(0)} g`}${x.openT !== null && x.openG! > (x.peakG ?? 0) * 1.5 ? `; biggest load ${x.openG!.toFixed(0)} g at +${x.openT.toFixed(1)} s` : ""}</span>`
        : "";
      return `<li data-t="${e.t}" tabindex="0"><span class="num">${i < 9 ? i + 1 : ""}</span><i style="background:${e.color}"></i>${escapeHtml(e.label)}<span class="alt">${show(alt, "ft")}</span><span class="t">T+${e.t.toFixed(2)} s</span>${shock}</li>`;
    })
    .join("");
}


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
    const delay = s.options["Use_Delay"]?.[ch] === "TRUE" ? `, ${vals.delay} s delay` : "";
    const when = fire ? `fired T+${fire.t.toFixed(2)} s` : "did not fire";
    return `<div class="settings-ch"><h3>${ch} <span class="muted small">(${when}${delay})</span></h3>${chips || '<span class="muted small">no conditions</span>'}</div>`;
  }).join("");
  const issues = checkSettings(s);
  const check = `<div class="set-check"><h3 class="sub-h">Settings check</h3>${
    issues.length
      ? `<ul>${issues.map((i) => `<li class="${i.level}"><b>${escapeHtml(i.title)}</b><span>${escapeHtml(i.detail)}</span></li>`).join("")}</ul>`
      : '<p class="muted small">No common setup problems found: each event has a backup that fires after its primary, nothing can fire on the way up, and mains open at a reasonable altitude.</p>'
  }</div>`;
  $("settings").innerHTML = `${check}<div class="muted small" style="margin-top:12px">All conditions must be true to fire. Green/red shows the logged state in the 0.15 s before each fire.</div>${html}`;
}


function renderScrubEvents() {
  const span = A!.tEnd - A!.tStart;
  const pct = (x: number) => ((x - A!.tStart) / span) * 100;
  $("scrub-phases").innerHTML = flightPhases(A!)
    .map((p) => `<span title="${escapeHtml(p.name)}: T+${p.t0.toFixed(1)} to T+${p.t1.toFixed(1)} s" style="left:${pct(p.t0)}%;width:${pct(p.t1) - pct(p.t0)}%;background:${p.color}"></span>`)
    .join("");
  $("phase-legend").innerHTML = flightPhases(A!)
    .map((p) => `<span><i style="background:${p.color}"></i>${escapeHtml(p.name)}</span>`)
    .join("");
  $("scrub-events").innerHTML = A!.events
    .map((e) => `<span title="${escapeHtml(e.label)}" style="left:${((e.t - A!.tStart) / span) * 100}%;background:${e.color}"></span>`)
    .join("");
}

// ---------- notes on the timeline ----------
let marks: { t: number; text: string }[] = [];
const marksKey = () => `dc.marks.${currentEntryId ?? flight?.name ?? ""}`;
async function loadMarks() {
  marks = [];
  if (currentEntryId) {
    const e = await getEntry(currentEntryId);
    if (e?.marks) marks = e.marks.slice();
  }
  if (!marks.length) {
    try { marks = JSON.parse(localStorage.getItem(marksKey()) ?? "[]"); } catch { marks = []; }
  }
  renderMarks();
}
async function saveMarks() {
  marks.sort((a, b) => a.t - b.t);
  try { localStorage.setItem(marksKey(), JSON.stringify(marks)); } catch { /* full or blocked */ }
  if (currentEntryId) {
    const e = await getEntry(currentEntryId);
    if (e) await putEntry({ ...e, marks });
  }
  renderMarks();
}
const tLabel = (x: number) => `T${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(2)}`;
function renderMarks() {
  $("marks-panel").hidden = !A;
  if (!A) return;
  const span = A.tEnd - A.tStart;
  $("scrub-marks").innerHTML = marks
    .map((m) => `<span title="${escapeHtml(tLabel(m.t))}: ${escapeHtml(m.text)}" style="left:${((m.t - A!.tStart) / span) * 100}%"></span>`)
    .join("");
  $("marks").innerHTML = marks.length
    ? marks.map((m, i) => `<li data-i="${i}" title="Jump to ${tLabel(m.t)}" tabindex="0"><span class="mt">${tLabel(m.t)}</span><span class="mx">${escapeHtml(m.text)}</span><button class="del" data-del="${i}" title="Delete note" aria-label="Delete note">×</button></li>`).join("")
    : '<li class="empty-note">Pause where something happens, type what you saw and press Add. Notes show as yellow marks on the timeline.</li>';
  updateMarkPlaceholder();
}
function updateMarkPlaceholder() {
  $<HTMLInputElement>("mark-text").placeholder = `Note at ${tLabel(t)} (press N)`;
  const near = marks.findIndex((m) => Math.abs(m.t - t) < 0.3);
  document.querySelectorAll("#marks li[data-i]").forEach((li) => li.classList.toggle("near", Number((li as HTMLElement).dataset.i) === near));
}
$("mark-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $<HTMLInputElement>("mark-text");
  const text = inp.value.trim();
  if (!text || !A) return;
  marks.push({ t: Math.round(t * 100) / 100, text });
  inp.value = "";
  inp.blur();
  saveMarks();
});
$("marks").addEventListener("click", (e) => {
  const tgt = e.target as HTMLElement;
  const del = tgt.closest<HTMLElement>("[data-del]");
  if (del) { marks.splice(Number(del.dataset.del), 1); saveMarks(); return; }
  const li = tgt.closest<HTMLElement>("li[data-i]");
  if (li) seek(marks[Number(li.dataset.i)].t);
});

// ---------- HUD ----------
function phaseAt(time: number) {
  const ev = (k: string) => A!.events.find((e) => e.key === k)?.t;
  const lo = ev("liftoff") ?? 0, bo = ev("burnout"), ap = ev("apogee"), mf = ev("fire_Main"), af = ev("fire_Apo"), la = ev("landing");
  if (time < lo) return "On pad";
  if (bo !== undefined && time < bo) return "Boost";
  if (ap !== undefined && time < ap) return "Coast";
  if (la !== undefined && time >= la) return "Landed";
  if (mf !== undefined && time >= mf) return "Under main";
  if (af !== undefined && time >= af) return "Under drogue";
  return "Descent";
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
  const v = (n: string, unit: string) => {
    const x = parseFloat(n);
    if (!Number.isFinite(x)) return `${n}<small>${cu(unit)}</small>`;
    const [y, u] = conv(x, unit);
    return `${y.toFixed(n.includes(".") ? n.split(".")[1].length : 0)}<small>${u}</small>`;
  };
  $("hud").innerHTML = `
    <div class="phase">${phaseAt(time)}</div>
    <div><div class="k">Altitude AGL</div><div class="v">${v(alt.toFixed(0), "ft")}</div></div>
    <div><div class="k">Vertical speed</div><div class="v">${v((descent ? A!.baroVel[i] : vUp).toFixed(0), "ft/s")}</div></div>
    <div><div class="k">Speed</div><div class="v">${descent ? "-" : v(spd.toFixed(0), "ft/s")}</div></div>
    <div><div class="k">Axial accel</div><div class="v">${v(acc, "g")}</div></div>
    <div><div class="k">Tilt</div><div class="v">${v(tilt.toFixed(1), "°")}</div></div>
    <div><div class="k">Roll rate</div><div class="v">${v(rr, "°/s")}</div></div>${gpsHud(time)}`;
  $("roll-needle").setAttribute("transform", `rotate(${roll})`);
  $("roll-val").textContent = `${roll.toFixed(0)}°`;
}

function gpsHud(time: number) {
  const g = A!.gps, d = flight!.gps;
  if (!g || !d) return "";
  const k = indexAt(g.t, time);
  return `
    <div><div class="k">Drift from pad</div><div class="v">${conv(d.distance[k], "ft")[0].toFixed(0)}<small>${cu("ft")}</small></div></div>
    <div class="gps-sats"><div class="k">GPS satellites</div><div class="v">${d.sats[k]}</div></div>`;
}

// ---------- playback ----------
// ---------- onboard video sync ----------
const video = $<HTMLVideoElement>("video");
let videoLift: number | null = null; // video time (s) at liftoff
let videoUrl: string | null = null;
let videoSyncing = false; // true while we move the video ourselves
const liftT = () => A?.events.find((e) => e.key === "liftoff")?.t ?? 0;
function videoTimeFor(flightT: number) { return videoLift === null ? null : videoLift + (flightT - liftT()); }
function syncVideo(force = false) {
  const vt = videoTimeFor(t);
  if (vt === null || !video.src) return;
  const inRange = vt >= 0 && (!video.duration || vt <= video.duration);
  if (!inRange) { if (!video.paused) video.pause(); return; }
  if (force || Math.abs(video.currentTime - vt) > (playing ? 0.25 : 0.04)) {
    videoSyncing = true;
    video.currentTime = vt;
  }
  if (playing) {
    video.playbackRate = Math.max(0.0625, parseFloat(speedSel.value));
    if (video.paused) video.play().catch(() => undefined);
  } else if (!video.paused) video.pause();
}
function renderVideoState() {
  const has = !!video.src;
  $("video-wrap").hidden = !has;
  for (const id of ["video-mark", "video-pip", "video-close"]) $(id).hidden = !has;
  for (const id of ["video-nudge-m", "video-nudge-p"]) $(id).hidden = !has || videoLift === null;
  video.controls = videoLift === null; // before syncing, use the video's own controls to find liftoff
  $("video-sub").innerHTML = !has
    ? "Load a flight video (RunCam, phone) to play it in sync with the replay. It stays on your computer."
    : videoLift === null
      ? "Play or scrub the video to the frame where the rocket leaves the rail, then press <b>Liftoff is at this frame</b>."
      : `Synced: liftoff is at ${videoLift.toFixed(2)} s in the video. The timeline now drives it.`;
}
$<HTMLInputElement>("video-input").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(f);
  video.src = videoUrl;
  // reuse a sync saved for this file name on this flight
  const saved = (() => { try { return JSON.parse(localStorage.getItem("dc.videosync") ?? "{}"); } catch { return {}; } })();
  const key = `${currentEntryId ?? flight?.name}|${f.name}`;
  videoLift = typeof saved[key] === "number" ? saved[key] : null;
  video.dataset.key = key;
  renderVideoState();
  if (videoLift !== null) video.addEventListener("loadedmetadata", () => syncVideo(true), { once: true });
  (e.target as HTMLInputElement).value = "";
});
$("video-mark").addEventListener("click", () => {
  if (!A) return;
  pause();
  seek(liftT());
  videoLift = video.currentTime;
  try {
    const saved = JSON.parse(localStorage.getItem("dc.videosync") ?? "{}");
    saved[video.dataset.key ?? ""] = videoLift;
    localStorage.setItem("dc.videosync", JSON.stringify(saved));
  } catch { /* ignore */ }
  renderVideoState();
});
for (const [id, d] of [["video-nudge-m", -0.1], ["video-nudge-p", 0.1]] as const) {
  $(id).addEventListener("click", () => {
    if (videoLift === null) return;
    videoLift += d;
    renderVideoState();
    syncVideo(true);
  });
}
$("video-pip").addEventListener("click", () => {
  const wrap = $("video-wrap");
  const pip = wrap.classList.toggle("pip");
  // dock inside the 3D view, or put back in the sidebar panel
  if (pip) document.querySelector(".stage")!.appendChild(wrap);
  else $("video-sub").after(wrap);
  $("video-pip").textContent = pip ? "Back to sidebar" : "Show over 3D";
});
$("video-close").addEventListener("click", () => {
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = null;
  videoLift = null;
  $("video-wrap").classList.remove("pip");
  $("video-sub").after($("video-wrap"));
  $("video-pip").textContent = "Show over 3D";
  renderVideoState();
});
// scrubbing the video itself (after sync) moves the flight
video.addEventListener("seeked", () => {
  if (videoSyncing) { videoSyncing = false; return; }
  if (videoLift !== null && !playing) seek(liftT() + (video.currentTime - videoLift));
});

function seek(time: number) {
  if (!A) return;
  t = Math.min(A.tEnd, Math.max(A.tStart, time));
  scrub.value = String(t);
  $("time").textContent = `T${t < 0 ? "−" : "+"}${Math.abs(t).toFixed(2)}`;
  replay.setTime(t);
  updateHud(t);
  syncVideo();
  const now = performance.now();
  if (!playing || now - lastChartUpdate > 66) {
    charts.setPlayhead(t);
    lastChartUpdate = now;
    updateMarkPlaceholder();
  }
}

function play() {
  if (!A) return;
  if (t >= A.tEnd - 0.01) seek(A.tStart);
  playing = true;
  playBtn.textContent = "❚❚";
  lastFrame = performance.now();
  syncVideo(true);
  requestAnimationFrame(tick);
}
function pause() {
  playing = false;
  playBtn.textContent = "▶";
  if (!video.paused) video.pause();
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
// ---------- keyboard ----------
function jumpEvent(dir: 1 | -1) {
  if (!A) return;
  const evs = A.events.map((e) => e.t).sort((a, b) => a - b);
  const target = dir > 0 ? evs.find((x) => x > t + 0.01) : [...evs].reverse().find((x) => x < t - 0.01);
  if (target !== undefined) seek(target);
}
function stepSpeed(dir: 1 | -1) {
  const i = speedSel.selectedIndex + dir;
  if (i >= 0 && i < speedSel.options.length) speedSel.selectedIndex = i;
}
function setCam(mode: CameraMode) {
  document.querySelectorAll("[data-cam]").forEach((x) => x.classList.toggle("active", (x as HTMLElement).dataset.cam === mode));
  if (mode === "tour" && A) {
    // the tour plays the whole flight from just before liftoff
    seek(Math.max(A.tStart, (A.events.find((e) => e.key === "liftoff")?.t ?? 0) - 1.5));
    replay.setCameraMode(mode);
    play();
    return;
  }
  replay.setCameraMode(mode);
}
// keyboard for list rows that act as buttons (events, findings, notes): Enter or Space jumps
document.addEventListener("keydown", (e) => {
  const row = (e.target as HTMLElement).closest?.('li[tabindex="0"]') as HTMLElement | null;
  if (!row || (e.key !== "Enter" && e.key !== " ") || e.target !== row) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  row.click();
}, true);

document.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement;
  // Space and Enter belong to whatever control has focus, not to play/pause
  if ((e.key === " " || e.key === "Enter") && tgt.closest?.('button, a, [role="button"], summary, li[tabindex="0"]')) return;
  const typing = (tgt instanceof HTMLInputElement && tgt.type !== "range") || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement;
  if (typing || e.ctrlKey || e.metaKey || e.altKey || !A) return;
  if (document.querySelector("dialog[open]")) return;
  const k = e.key;
  let handled = true;
  if (e.code === "Space" || k === "k" || k === "K") { if (k.toLowerCase() === "k") pause(); else (playing ? pause() : play()); }
  else if (k === "ArrowRight") seek(t + (e.shiftKey ? 1 : 0.1));
  else if (k === "ArrowLeft") seek(t - (e.shiftKey ? 1 : 0.1));
  else if (k === "." ) jumpEvent(1);
  else if (k === ",") jumpEvent(-1);
  else if (k === "j" || k === "J") stepSpeed(-1);
  else if (k === "l" || k === "L") stepSpeed(1);
  else if (k === "Home") seek(A.tStart);
  else if (k === "End") seek(A.tEnd);
  else if (/^[1-9]$/.test(k)) { const ev = A.events[Number(k) - 1]; if (ev) seek(ev.t); }
  else if (k === "n" || k === "N") { pause(); $("mark-text").focus(); }
  else if (k === "f" || k === "F") setCam("follow");
  else if (k === "o" || k === "O") setCam("overview");
  else if (k === "g" || k === "G") setCam("ground");
  else if (k === "t" || k === "T") setCam("tour");
  else handled = false;
  if (handled) e.preventDefault();
});
$("ev-prev").addEventListener("click", () => jumpEvent(-1));
$("ev-next").addEventListener("click", () => jumpEvent(1));
$("keys-btn").addEventListener("click", () => {
  const pop = $("keys-pop");
  pop.hidden = !pop.hidden;
  $("keys-btn").setAttribute("aria-expanded", String(!pop.hidden));
});
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("#keys-pop, #keys-btn")) $("keys-pop").hidden = true;
});
$("events").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (li?.dataset.t) seek(parseFloat(li.dataset.t));
});
document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) =>
  b.addEventListener("click", () => setCam(b.dataset.cam as CameraMode)),
);
replay.onCameraMode = (mode) => document.querySelectorAll("[data-cam]").forEach((x) => x.classList.toggle("active", (x as HTMLElement).dataset.cam === mode));
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

$<HTMLInputElement>("gps-offset").addEventListener("change", (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(v)) { gpsOffsetOverride = v; reanalyze(); }
});
$("gps-auto").addEventListener("click", () => { gpsOffsetOverride = undefined; reanalyze(); });

{
  const inp = $<HTMLInputElement>("cmp-input");
  inp.addEventListener("change", async () => {
    if (inp.files?.length) await loadCompare(await readList(inp.files));
    inp.value = "";
  });
}
$("cmp-sample").addEventListener("click", async () => {
  setBusy(true);
  try { await loadCompare(await fetchSample("SN1742")); } finally { setBusy(false); }
});
$("cmp-clear").addEventListener("click", () => { cmps = []; applyCompare(); });
$("cmp-list").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("[data-rmc]") as HTMLElement | null;
  if (!b) return;
  cmps = cmps.filter((c) => c.id !== b.dataset.rmc);
  applyCompare();
});
$("cmp-list").addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  const c = cmps.find((x) => x.id === el.dataset.off);
  const v = parseFloat(el.value);
  if (!c || !Number.isFinite(v)) return;
  c.offset = v;
  applyCompare();
});

$("rec-sections").addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  const i = Number(el.dataset.i);
  if (!recovery.sections[i]) return;
  if (el.dataset.f === "name") recovery.sections[i].name = el.value;
  else recovery.sections[i].massLb = parseFloat(el.value) || 0;
  recoveryChanged();
});
$("rec-sections").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("[data-rm]") as HTMLElement | null;
  if (!b) return;
  recovery.sections.splice(Number(b.dataset.rm), 1);
  renderRecovery();
  recoveryChanged();
});
$("rec-add").addEventListener("click", () => {
  recovery.sections.push({ name: `Section ${recovery.sections.length + 1}`, massLb: 10 });
  renderRecovery();
  recoveryChanged();
});
for (const [id, key] of [["rec-target", "targetApogeeFt"], ["rec-ke", "keLimit"], ["rec-desc", "descentLimit"], ["rec-drift", "driftLimit"]] as const) {
  $<HTMLInputElement>(id).addEventListener("input", (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (key === "targetApogeeFt") recovery.targetApogeeFt = Number.isFinite(v) && v > 0 ? v : null;
    else if (Number.isFinite(v) && v > 0) recovery[key] = v;
    recoveryChanged();
  });
}
$("rec-default").addEventListener("click", () => {
  saveDefaultRecovery(recovery);
  $("rec-default").textContent = "Saved as default";
  setTimeout(() => ($("rec-default").textContent = "Use for new flights too"), 1800);
});

// ---------- units ----------
function renderUnitsToggle() {
  document.querySelectorAll<HTMLButtonElement>("[data-units]").forEach((b) => {
    const on = b.dataset.units === getUnits();
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}
document.querySelectorAll<HTMLButtonElement>("[data-units]").forEach((b) =>
  b.addEventListener("click", () => setUnits(b.dataset.units as "imperial" | "metric")),
);
applyTheme();
function renderThemeBtn() {
  const light = getTheme() === "light";
  const b = $("theme-btn");
  b.textContent = light ? "☾" : "☀";
  b.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
  b.title = light ? "Dark theme" : "Light theme (for projectors and printed slides)";
}
renderThemeBtn();
$("theme-btn").addEventListener("click", () => setTheme(getTheme() === "light" ? "dark" : "light"));
onThemeChange(() => { renderThemeBtn(); rerenderForDisplay(); });
onUnitsChange(() => rerenderForDisplay());
function rerenderForDisplay() {
  renderUnitsToggle();
  if (!A || !flight) return;
  charts.setFlight(A, flight, cmps);
  replay.refreshUnitLabels();
  renderMetrics();
  renderRecovery();
  renderDescent();
  renderVehicle();
  renderGps();
  renderEvents();
  renderSettings();
  renderCompare();
  updateHud(t);
  charts.setPlayhead(t);
}
renderUnitsToggle();

// ---------- printable report ----------
async function buildReport() {
  if (!A || !flight) return;
  const entry = currentEntryId ? await getEntry(currentEntryId) : undefined;
  const title = entry?.name ?? flight.gps?.name ?? flight.name;
  const fd = entry?.date || flightDate();
  const dateStr = fd ? new Date(fd + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
  const e = escapeHtml;
  const metricRows = A.metrics
    .map((m) => `<tr><td>${e(m.label)}</td><td class="n">${fmt(m.site, m.unit)}</td><td class="n">${fmt(m.device, m.unit)}</td><td>${e(cu(m.unit))}</td></tr>`)
    .join("");
  const rec = evaluate(recovery, recoveryInputs());
  const recRows = rec.rows
    .map((r) => `<tr><td>${e(r.label)}${r.sub ? ` <span style="color:#6b7891">(${e(r.sub)})</span>` : ""}</td><td class="n">${e(r.value)}</td><td class="n">${e(r.limit)}</td><td class="${r.verdict}">${r.verdict === "pass" ? "Pass" : r.verdict === "fail" ? "Over" : ""}</td></tr>`)
    .join("");
  const p = A.path;
  const evRows = A.events
    .map((ev) => `<tr><td>${e(ev.label)}</td><td class="n">T+${ev.t.toFixed(2)} s</td><td class="n">${show(p.y[indexAt(p.t, ev.t)], "ft")}</td></tr>`)
    .join("");
  const g = A.gps;
  const gpsBlock = g
    ? `<section><h2>Blue Raven vs GPS</h2><table><tr><th>Metric</th><th class="n">Blue Raven</th><th class="n">GPS</th><th><span class="sr-only">Unit</span></th></tr>${g.rows
        .map((r) => `<tr><td>${e(r.label)}</td><td class="n">${fmt(r.br, r.unit)}</td><td class="n">${fmt(r.gps, r.unit)}</td><td>${e(cu(r.unit))}</td></tr>`)
        .join("")}</table><p>Landing ${show(g.landing.distance, "ft")} from the pad at ${g.landing.bearing.toFixed(0)}°, ${g.landing.lat.toFixed(5)}, ${g.landing.lon.toFixed(5)}.</p></section>`
    : "";
  const w = flight.gps ? windProfile(flight.gps, A) : null;
  const wspd = (v: number) => show(v * 0.681818, "mph");
  const windBlock = w
    ? `<section><h2>Wind from GPS drift</h2><p>Average ${wspd(w.mean.speed)} from the ${compassName(w.mean.fromDeg)} (${w.mean.fromDeg.toFixed(0)}°), measured from the drift under a settled parachute.</p><table><tr><th>Altitude (${e(cu("ft"))} AGL)</th><th class="n">Speed</th><th class="n">From</th></tr>${w.bins
        .map((b) => `<tr><td>${conv(b.lo, "ft")[0].toFixed(0)}-${conv(b.hi, "ft")[0].toFixed(0)}</td><td class="n">${wspd(b.speed)}</td><td class="n">${compassName(b.fromDeg)} ${b.fromDeg.toFixed(0)}°</td></tr>`)
        .join("")}</table></section>`
    : "";
  const weight = recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0) || null;
  const desc = descentPhases(flight, A, weight);
  const descBlock = desc.length
    ? `<section><h2>Descent</h2><table><tr><th>Phase</th><th class="n">Rate</th><th class="n">At sea level</th><th class="n">CdA</th></tr>${desc
        .map((d) => `<tr><td>${e(d.name)} <span style="color:#6b7891">(${conv(d.altTop, "ft")[0].toFixed(0)} to ${show(d.altBottom, "ft")})</span></td><td class="n">${show(d.rate, "ft/s", 1)}</td><td class="n">${show(d.seaLevelRate, "ft/s", 1)}</td><td class="n">${show(d.cdA, "ft²", 1)}</td></tr>`)
        .join("")}</table></section>`
    : "";
  const notesBlock = marks.length
    ? `<section><h2>Notes on the timeline</h2><table><tr><th style="width:90px">Time</th><th>Note</th></tr>${marks
        .map((m) => `<tr><td style="white-space:nowrap">${tLabel(m.t)} s</td><td>${e(m.text)}</td></tr>`)
        .join("")}</table></section>`
    : "";
  const mine = keyNumbersOf(A);
  const cmpBlock = cmps.length
    ? `<section><h2>Comparison</h2><p>Lined up at ${ALIGN_NAME[alignAt]}${cmps.some((c) => c.offset) ? `; shifts: ${cmps.map((c) => `${e(c.trace.name)} ${c.offset >= 0 ? "+" : ""}${c.offset.toFixed(2)} s`).join(", ")}` : ""}.</p><table><tr><th>Metric</th><th class="n">This flight</th>${cmps.map((c) => `<th class="n">${e(c.trace.kind === "sim" ? "Sim: " + c.trace.name : c.trace.name)}</th>`).join("")}<th><span class="sr-only">Unit</span></th></tr>${KEY_ROWS.map(
        ({ k, label, unit }) => `<tr><td>${label}</td><td class="n">${fmt(mine[k], unit)}</td>${cmps.map((c) => `<td class="n">${fmt(c.trace.key[k], unit)}</td>`).join("")}<td>${cu(unit)}</td></tr>`,
      ).join("")}</table>${cmps.map((c) => `<p>${e(whatChanged(mine, c.trace.key, c.trace.kind === "sim" ? `the sim ${c.trace.name}` : c.trace.name))}</p>`).join("")}</section>`
    : "";
  const shot3d = replay.snapshot();
  const figs = await charts.snapshots(["Altitude", "Velocity", "Acceleration", "Attitude", "Roll rate"]);
  $("report").innerHTML = `
    <h1>${e(title)}</h1>
    <div class="meta">${e(dateStr)}${flight.summary?.raw["Flight number"] ? `, Blue Raven flight ${e(flight.summary.raw["Flight number"])}` : ""}${flight.gps ? ", with GPS" : ""}</div>
    ${entry?.notes ? `<div class="notes">${e(entry.notes)}</div>` : ""}
    <div class="cols">
      <section><h2>Flight summary</h2><table><tr><th>Metric</th><th class="n">Site</th><th class="n">Blue Raven</th><th><span class="sr-only">Unit</span></th></tr>${metricRows}</table></section>
      <div>
        <section><h2>Recovery check</h2><table><tr><th>Item</th><th class="n">Value</th><th class="n">Limit</th><th><span class="sr-only">Unit</span></th></tr>${recRows}</table></section>
        <section><h2>Events</h2><table><tr><th>Event</th><th class="n">Time</th><th class="n">Altitude</th></tr>${evRows}</table></section>
      </div>
    </div>
    ${notesBlock}
    ${gpsBlock}
    <div class="cols">${descBlock}${windBlock}</div>
    ${cmpBlock}
    ${shot3d ? `<figure><img src="${shot3d}" alt="3D view of the trajectory" /></figure>` : ""}
    ${figs.map((f) => `<figure><img src="${f.url}" alt="${e(f.title)} chart" /></figure>`).join("")}
    <div class="foot">Generated ${new Date().toLocaleString()} by Data Compare (dreveron10.github.io/Data-compare). Baro altitude filtered with a 1 s median and 0.2 s average; descent rates are linear fits.</div>`;
  // wait for images to decode before printing
  await Promise.all([...$("report").querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
  window.print();
}
$("report-open").addEventListener("click", () => buildReport());

$("export-all").addEventListener("click", () => {
  if (!A || !flight) return;
  const cc = coastCfg(), mc = motorCfg();
  const mass = cc.massLb ?? recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0);
  const coast = flight.hr && A.axialAccel ? coastDrag(flight, A, mass, cc.diaIn) : null;
  const thrust = flight.hr && A.axialAccel ? thrustCurve(flight, A, mass, mc.propLb ?? 0, cc.diaIn, coast?.cd50 ?? 0.45) : null;
  const weight = recovery.sections.reduce((n, sct) => n + (sct.massLb > 0 ? sct.massLb : 0), 0) || null;
  const extra = {
    keyNumbers: keyNumbersOf(A),
    findings: findFindings(flight, A),
    descent: descentPhases(flight, A, weight),
    wind: flight.gps ? windProfile(flight.gps, A) : null,
    vehicle: { name: vehicleLabel || null, ...getVehicle(vehicleKey) },
    coastDrag: coast ? { cdMedian: coast.cd50, machMin: coast.machMin, machMax: coast.machMax, samples: coast.n } : null,
    motor: thrust ? { impulseNs: thrust.impulseNs, class: thrust.motorClass, burnTimeS: thrust.burnTime, avgN: thrust.avgN, peakN: thrust.peakN } : null,
    ejection: ejectionTimes(flight, A),
    settingsCheck: flight.settings ? checkSettings(flight.settings) : null,
    timelineNotes: marks,
    recovery,
  };
  const zip = buildExport(flight, A, extra);
  downloadBlob(`${fileSlug(currentEntryName ?? flight.gps?.name ?? flight.name)}-data.zip`, new Blob([new Uint8Array(zip)], { type: "application/zip" }));
});

// ---------- share one flight ----------
async function shareEntry(e: LibraryEntry) {
  downloadBlob(`${fileSlug(e.name)}.flight.zip`, await exportBackup([e]));
}
$("share-open").addEventListener("click", async () => {
  if (!A || !flight) return;
  // share the saved version if there is one (keeps name, notes, tags), otherwise the loaded files
  const saved = currentEntryId ? await getEntry(currentEntryId) : undefined;
  const k = keyNumbersOf(A);
  const e: LibraryEntry = saved ?? {
    id: newId(), kind: "flight", name: flight.gps?.name ?? flight.name, date: flightDate(), notes: "",
    savedAt: new Date().toISOString(),
    stats: { apogee: k.apogee, flightTime: k.flightTime, drift: k.drift, maxVel: k.maxVel, hasGps: !!flight.gps },
    files: lastFiles, recovery, marks,
  };
  await shareEntry(e);
});

// ---------- library (saved in this browser) ----------
const saveDlg = $<HTMLDialogElement>("save-dialog");
const libDlg = $<HTMLDialogElement>("lib-dialog");

function flightDate(): string {
  // the GPS clock is reliable; the Blue Raven clock may not be set
  const g = flight?.gps;
  if (g) {
    // UTC date of launch (US launches happen in daylight, so the UTC date is the local date)
    const d = new Date(g.launchUtcMs ?? g.launchUnix * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return flight?.lr?.date ?? "";
}

$("save-open").addEventListener("click", async () => {
  if (!flight || !A) return;
  const existing = currentEntryId ? await getEntry(currentEntryId) : undefined;
  $("save-title").textContent = existing ? "Edit saved flight" : "Save flight to library";
  $<HTMLInputElement>("save-name").value = existing?.name ?? flight.gps?.name ?? flight.name;
  $<HTMLInputElement>("save-date").value = existing?.date ?? flightDate();
  $<HTMLTextAreaElement>("save-notes").value = existing?.notes ?? "";
  $<HTMLInputElement>("save-vehicle").value = existing?.vehicle ?? "";
  $<HTMLInputElement>("save-motor").value = existing?.motor ?? "";
  $<HTMLInputElement>("save-tags").value = (existing?.tags ?? []).join(", ");
  // suggestions from what's already in the library
  const all = await listEntries();
  const opts = (vals: (string | undefined)[]) => [...new Set(vals.filter(Boolean))].map((v) => `<option value="${escapeHtml(v!)}"></option>`).join("");
  $("dl-vehicles").innerHTML = opts(all.map((x) => x.vehicle));
  $("dl-motors").innerHTML = opts(all.map((x) => x.motor));
  const sims = cmps.filter((c) => c.trace.kind === "sim");
  const simOk = !existing && sims.length > 0;
  $("save-sim-row").hidden = !simOk;
  if (simOk) $("save-sim-label").textContent = sims.length === 1 ? `Also save the sim "${sims[0].trace.name}"` : `Also save the ${sims.length} sims being compared`;
  const kb = lastFiles.reduce((n, f) => n + (f.buffer?.byteLength ?? f.text?.length ?? 0), 0) / 1024;
  $("save-files").textContent = `${lastFiles.length} files (${kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : kb.toFixed(0) + " KB"}): ${lastFiles.map((f) => f.name).join(", ")}`;
  saveDlg.showModal();
});

$("save-form").addEventListener("submit", async (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "save" || !A || !flight) return;
  const name = $<HTMLInputElement>("save-name").value.trim() || flight.name;
  const date = $<HTMLInputElement>("save-date").value;
  const notes = $<HTMLTextAreaElement>("save-notes").value.trim();
  const vehicle = $<HTMLInputElement>("save-vehicle").value.trim() || undefined;
  const motor = $<HTMLInputElement>("save-motor").value.trim() || undefined;
  const tags = $<HTMLInputElement>("save-tags").value.split(",").map((x) => x.trim()).filter(Boolean);
  const k = keyNumbersOf(A);
  const entry: LibraryEntry = {
    id: currentEntryId ?? newId(),
    kind: "flight", name, date, notes, vehicle, motor, tags,
    savedAt: new Date().toISOString(),
    stats: { apogee: k.apogee, flightTime: k.flightTime, drift: k.drift, maxVel: k.maxVel, hasGps: !!flight.gps,
      drogueRate: k.drogueRate, mainRate: k.mainRate, maxAccel: k.maxAccel, mainAlt: k.mainAlt, ...measuredStats() },
    files: lastFiles,
    recovery,
    marks,
  };
  try {
    await putEntry(entry);
    if (!$("save-sim-row").hidden && $<HTMLInputElement>("save-sim").checked) {
      for (const c of cmps.filter((x) => x.trace.kind === "sim")) {
        await putEntry({
          id: newId(), kind: "sim", name: c.trace.name, date, notes: `Sim for ${name}`,
          savedAt: new Date().toISOString(),
          stats: { apogee: c.trace.key.apogee, flightTime: c.trace.key.flightTime, drift: c.trace.key.drift, maxVel: c.trace.key.maxVel },
          files: c.files,
        });
      }
    }
    currentEntryId = entry.id;
    currentEntryName = entry.name;
    showFlightTitle();
    $("save-open").textContent = "Edit saved flight";
    loadVehicleKey(); // the vehicle name may be new or changed: switch its numbers and the previous-flight button
    requestPersistence();
    showWarnings(A.warnings);
    maybeNudgeAfterSave();
  } catch (err) {
    showWarnings([`Could not save to the library: ${(err as Error).message}`]);
  }
});

const num = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d));

// ids picked in the library, in the order they were ticked (the first flight becomes the main one)
let libSel: string[] = [];
function renderLibSel() {
  const bar = $("lib-selbar");
  bar.hidden = libSel.length === 0;
  $("lib-selcount").textContent = `${libSel.length} selected`;
  const btn = $<HTMLButtonElement>("lib-together");
  btn.disabled = libSel.length < 2 || libSel.length > MAX_COMPARES + 1;
  btn.title = libSel.length > MAX_COMPARES + 1 ? `Pick at most ${MAX_COMPARES + 1}: one flight plus ${MAX_COMPARES} to compare` : "";
}
async function openTogether() {
  const entries = (await Promise.all(libSel.map((id) => getEntry(id)))).filter((x): x is LibraryEntry => !!x);
  const base = entries.find((e) => e.kind === "flight");
  if (!base) { showWarnings(["Pick at least one real flight (not only sims) to open the others against."]); return; }
  libDlg.close();
  setBusy(true);
  recovery = base.recovery ?? loadDefaultRecovery();
  try {
    await loadFiles(base.files, base.id, base.name);
    for (const e of entries.filter((x) => x !== base).slice(0, MAX_COMPARES)) await loadCompare(e.files);
  } finally { setBusy(false); }
  libSel = [];
}

// the entries currently listed (after search, filter and sort), for the flight log export
let libShown: LibraryEntry[] = [];
$("lib-log").addEventListener("click", () => {
  const cols: [string, (e: LibraryEntry) => string | number | null | undefined][] = [
    ["Date", (e) => e.date], ["Name", (e) => e.name], ["Kind", (e) => e.kind], ["Vehicle", (e) => e.vehicle], ["Motor", (e) => e.motor],
    ["Apogee (ft AGL)", (e) => e.stats.apogee], ["Max velocity (ft/s)", (e) => e.stats.maxVel], ["Max boost accel (g)", (e) => e.stats.maxAccel],
    ["Max Mach", (e) => e.stats.maxMach], ["Max q (psf)", (e) => e.stats.maxQ],
    ["Drogue rate (ft/s)", (e) => e.stats.drogueRate], ["Main deploy (ft)", (e) => e.stats.mainAlt], ["Main rate (ft/s)", (e) => e.stats.mainRate],
    ["Flight time (s)", (e) => e.stats.flightTime], ["Drift (ft)", (e) => e.stats.drift], ["GPS", (e) => (e.stats.hasGps ? "yes" : "")],
    ["Coast Cd", (e) => e.stats.coastCd], ["Measured impulse (N·s)", (e) => e.stats.impulseNs],
    ["Battery on pad (V)", (e) => e.stats.padBattV], ["Lowest battery (V)", (e) => e.stats.minBattV], ["Data warnings", (e) => e.stats.dataWarnings],
    ["Tags", (e) => (e.tags ?? []).join("; ")], ["Notes", (e) => e.notes],
  ];
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const csv = [cols.map((c) => cell(c[0])).join(","), ...libShown.map((e) => cols.map((c) => cell(c[1](e))).join(","))].join("\n");
  // BOM so Excel opens the units (·, °) correctly
  downloadBlob(`flight-log-${new Date().toISOString().slice(0, 10)}.csv`, new Blob(["\ufeff" + csv], { type: "text/csv" }));
});

async function renderLibrary() {
  const all = await listEntries();
  const q = $<HTMLInputElement>("lib-search").value.trim().toLowerCase();
  const kind = $<HTMLSelectElement>("lib-kind").value;
  const sort = $<HTMLSelectElement>("lib-sort").value;
  const hay = (e: LibraryEntry) => [e.name, e.notes, e.motor, e.vehicle, ...(e.tags ?? []), e.date].join(" ").toLowerCase();
  let list = all.filter((e) => (kind === "all" || e.kind === kind) && (!q || q.split(/\s+/).every((w) => hay(e).includes(w))));
  const apo = (e: LibraryEntry) => e.stats.apogee ?? -Infinity;
  list = list.sort((a, b) =>
    sort === "date-asc" ? (a.date || "").localeCompare(b.date || "")
    : sort === "apogee-desc" ? apo(b) - apo(a)
    : sort === "apogee-asc" ? apo(a) - apo(b)
    : sort === "name" ? a.name.localeCompare(b.name)
    : (b.date || "").localeCompare(a.date || "") || b.savedAt.localeCompare(a.savedAt));
  libShown = list;
  // highlight search words
  const hl = (text: string) => {
    let h = escapeHtml(text);
    if (!q) return h;
    for (const w of q.split(/\s+/).filter((x) => x.length > 1)) {
      h = h.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
    }
    return h;
  };
  const el = $("lib-list");
  if (all.length === 0) {
    el.innerHTML = '<div class="lib-empty">No saved flights yet. Load a flight and press <b>Save flight</b>.</div>';
  } else if (list.length === 0) {
    el.innerHTML = '<div class="lib-empty">Nothing matches. Try fewer words or show flights and sims.</div>';
  } else {
    el.innerHTML = `<table class="lib-table"><tr><th><span class="sr-only">Select</span></th><th>Date</th><th>Name</th><th style="text-align:right">Apogee</th><th style="text-align:right">Flight time</th><th style="text-align:right">Drift</th><th>Notes</th><th><span class="sr-only">Actions</span></th></tr>${list
      .map((e) => `<tr class="${e.id === currentEntryId ? "current" : ""}${libSel.includes(e.id) ? " sel" : ""}">
        <td class="pick"><input type="checkbox" data-pick="${e.id}" ${libSel.includes(e.id) ? "checked" : ""} aria-label="Select ${escapeHtml(e.name)}" /></td>
        <td>${escapeHtml(e.date || "-")}</td>
        <td>${hl(e.name)}${e.kind === "sim" ? '<span class="tag">Sim</span>' : ""}${e.stats.hasGps ? '<span class="tag">GPS</span>' : ""}
          <div class="chips">${e.vehicle ? `<span class="chipline">${hl(e.vehicle)}</span>` : ""}${e.motor ? `<span class="chipline">${hl(e.motor)}</span>` : ""}${(e.tags ?? []).map((tg) => `<span class="chipline tagc">${hl(tg)}</span>`).join("")}</div></td>
        <td class="num">${show(e.stats.apogee, "ft")}</td>
        <td class="num">${num(e.stats.flightTime, 1)} s</td>
        <td class="num">${show(e.stats.drift, "ft")}</td>
        <td class="notes">${hl(e.notes)}</td>
        <td class="acts">
          ${e.kind === "flight" ? `<button class="btn small-btn" data-act="open" data-id="${e.id}">Open</button>` : ""}
          <button class="btn small-btn" data-act="cmp" data-id="${e.id}" ${!A || e.id === currentEntryId ? "disabled" : ""}>Compare</button>
          <button class="btn small-btn" data-act="share" data-id="${e.id}" title="Download as one file to send to a teammate">Share</button>
          <button class="btn small-btn danger" data-act="del" data-id="${e.id}">Delete</button>
        </td></tr>`)
      .join("")}</table>`;
  }
  const u = await storageUse();
  $("lib-usage").textContent = `${list.length === all.length ? `${all.length} saved` : `${list.length} of ${all.length} shown`}${u ? `, ${(u.used / 1048576).toFixed(1)} MB used of ${(u.quota / 1073741824).toFixed(1)} GB available` : ""}`;
}
// ---------- trends across the library ----------
const TREND_COLORS = ["#6cc4ff", "#ff7a1a", "#7bd88f", "#b48cff", "#f5c26b", "#ff9de2", "#c6f07a", "#e86bff"];
let trendPlot: uPlot | undefined;
async function renderTrends() {
  const [key, unit] = $<HTMLSelectElement>("tr-metric").value.split("|") as [keyof LibraryEntry["stats"], string];
  const groupBy = $<HTMLSelectElement>("tr-group").value as "vehicle" | "motor" | "none";
  const sims = $<HTMLInputElement>("tr-sims").checked;
  const all = (await listEntries()).filter((e) => (sims || e.kind === "flight") && e.date);
  const pts = all
    .map((e) => ({ e, x: Date.parse(e.date + "T12:00:00") / 1000, y: e.stats[key] as number | null | undefined }))
    .filter((p) => p.y !== null && p.y !== undefined && Number.isFinite(p.y) && Number.isFinite(p.x)) as { e: LibraryEntry; x: number; y: number }[];
  const gname = (e: LibraryEntry) => (groupBy === "none" ? "All flights" : (groupBy === "vehicle" ? e.vehicle : e.motor) || "Not set");
  const groups = [...new Set(pts.map((p) => gname(p.e)))];
  const missing = all.length - pts.length;
  $("tr-note").textContent = `${pts.length} flight${pts.length === 1 ? "" : "s"} plotted.${missing ? ` ${missing} saved before this metric was recorded or without the data (open and re-save them to include).` : ""}${key === "coastCd" || key === "impulseNs" ? " Uses the Vehicle card masses as they were when each flight was saved." : ""}`;
  trendPlot?.destroy();
  trendPlot = undefined;
  const host = $("tr-chart");
  host.innerHTML = "";
  if (pts.length === 0) {
    host.innerHTML = '<div class="lib-empty">No saved flights have this metric yet.</div>';
    $("tr-table").innerHTML = "";
    return;
  }
  const xs = [...new Set(pts.map((p) => p.x))].sort((a, b) => a - b);
  const data: (number | null)[][] = [xs];
  for (const g of groups) {
    data.push(xs.map((x) => {
      const hit = pts.filter((p) => p.x === x && gname(p.e) === g);
      return hit.length ? conv(hit.reduce((n, p) => n + p.y, 0) / hit.length, unit)[0] : null;
    }));
  }
  const pad = 86400 * 10;
  trendPlot = new uPlot({
    width: Math.max(300, host.clientWidth || 800),
    height: 240,
    scales: { x: { time: true, range: (_u, mn, mx) => [mn - pad, mx + pad] } },
    axes: [
      { stroke: axisColor(), grid: { stroke: gridColor(), width: 1 }, font: "12px Barlow, system-ui" },
      { stroke: axisColor(), grid: { stroke: gridColor(), width: 1 }, label: unit === "count" ? "warnings" : cu(unit), labelSize: 20, size: 56, font: "12px Barlow, system-ui", labelFont: "12px Barlow, system-ui" },
    ],
    series: [
      { label: "Date" },
      ...groups.map((g, i) => ({
        label: g, stroke: TREND_COLORS[i % TREND_COLORS.length], width: 1.5, spanGaps: true,
        points: { show: true, size: 9, fill: TREND_COLORS[i % TREND_COLORS.length] },
        value: (_u: uPlot, v: number | null) => (v == null ? "-" : `${v.toFixed(unit === "" ? 2 : unit === "V" ? 2 : unit === "g" || unit === "s" ? 1 : 0)} ${unit === "count" ? "" : cu(unit)}`),
      })),
    ],
  }, data as uPlot.AlignedData, host);
  // per-group stats
  const rows = groups.map((g, i) => {
    const ys = pts.filter((p) => gname(p.e) === g).map((p) => conv(p.y, unit)[0]);
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sd = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, ys.length - 1));
    const d = unit === "count" ? 1 : unit === "" || unit === "V" ? 2 : unit === "g" || unit === "s" ? 2 : 0;
    return `<tr><td><i class="sw" style="background:${TREND_COLORS[i % TREND_COLORS.length]}"></i> ${escapeHtml(g)}</td><td>${ys.length}</td><td>${mean.toFixed(d)}</td><td>${ys.length > 1 ? sd.toFixed(d) : "-"}</td><td>${Math.min(...ys).toFixed(d)}</td><td>${Math.max(...ys).toFixed(d)}</td><td class="unit">${unit === "count" ? "" : cu(unit)}</td></tr>`;
  }).join("");
  $("tr-table").innerHTML = `<tr><th>Group</th><th>Flights</th><th>Mean</th><th>Spread (1σ)</th><th>Min</th><th>Max</th><th><span class="sr-only">Unit</span></th></tr>${rows}`;
}
document.querySelectorAll<HTMLButtonElement>("[data-libview]").forEach((b) =>
  b.addEventListener("click", () => {
    const trends = b.dataset.libview === "trends";
    document.querySelectorAll("[data-libview]").forEach((x) => x.classList.toggle("active", x === b));
    $("lib-trends").hidden = !trends;
    $("lib-list-tools").hidden = trends;
    $("lib-list").hidden = trends;
    if (trends) renderTrends();
  }),
);
for (const id of ["tr-metric", "tr-group", "tr-sims"]) $(id).addEventListener("change", () => renderTrends());

$("lib-search").addEventListener("input", () => renderLibrary());
$("lib-kind").addEventListener("change", () => renderLibrary());
$("lib-sort").addEventListener("change", () => renderLibrary());

$("lib-open").addEventListener("click", async () => { libSel = []; renderLibSel(); await renderLibrary(); await renderBackupNudge(); libDlg.showModal(); });
$("lib-together").addEventListener("click", () => openTogether());
$("lib-selclear").addEventListener("click", async () => { libSel = []; renderLibSel(); await renderLibrary(); });
$("lib-close").addEventListener("click", () => libDlg.close());
const aboutDlg = $<HTMLDialogElement>("about-dialog");
$("about-open").addEventListener("click", () => aboutDlg.showModal());
$("about-close").addEventListener("click", () => aboutDlg.close());
$("tour-again").addEventListener("click", () => {
  aboutDlg.close();
  if (A) startTour(); else showWarnings(["Open a flight (or a sample) first, then the tour can point at the controls."]);
});
aboutDlg.addEventListener("click", (e) => { if (e.target === aboutDlg) aboutDlg.close(); });
$("lib-list").addEventListener("click", async (ev) => {
  const pick = (ev.target as HTMLElement).closest("input[data-pick]") as HTMLInputElement | null;
  if (pick) {
    const id = pick.dataset.pick!;
    libSel = pick.checked ? [...libSel.filter((x) => x !== id), id] : libSel.filter((x) => x !== id);
    pick.closest("tr")?.classList.toggle("sel", pick.checked);
    renderLibSel();
    return;
  }
  const b = (ev.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
  if (!b) return;
  const entry = await getEntry(b.dataset.id!);
  if (!entry) return;
  if (b.dataset.act === "open") {
    libDlg.close();
    setBusy(true);
    recovery = entry.recovery ?? loadDefaultRecovery();
    try { await loadFiles(entry.files, entry.id, entry.name); } finally { setBusy(false); }
  } else if (b.dataset.act === "cmp") {
    libDlg.close();
    await loadCompare(entry.files);
  } else if (b.dataset.act === "share") {
    await shareEntry(entry);
  } else if (b.dataset.act === "del") {
    if (!confirm(`Delete "${entry.name}" from the library? This cannot be undone (unless it is in a backup).`)) return;
    await deleteEntry(entry.id);
    if (entry.id === currentEntryId) {
      currentEntryId = undefined;
      $("save-open").textContent = "Save flight";
    }
    await renderLibrary();
  }
});
{
  const inp = $<HTMLInputElement>("lib-import");
  inp.addEventListener("change", async () => {
    const f = inp.files?.[0];
    inp.value = "";
    if (!f) return;
    try {
      const n = (await importBackup(await f.arrayBuffer())).length;
      await renderLibrary();
      $("lib-usage").textContent = `Imported ${n} entr${n === 1 ? "y" : "ies"}. ` + $("lib-usage").textContent;
    } catch (err) {
      alert(`That file is not a Data Compare backup (${(err as Error).message}).`);
    }
  });
}

// ---------- first visit: recent library flights ----------
async function renderRecent() {
  try {
    const list = (await listEntries()).filter((e) => e.kind === "flight").slice(0, 4);
    $("wl-recent").hidden = list.length === 0;
    $("wl-recent-list").innerHTML = list
      .map((e) => `<li><button data-recent="${e.id}">${escapeHtml(e.name)}<span>${escapeHtml(e.date || "")}${e.stats.apogee ? `, ${show(e.stats.apogee, "ft")}` : ""}</span></button></li>`)
      .join("");
  } catch { /* library unavailable */ }
}
$("wl-recent-list").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest("[data-recent]") as HTMLElement | null;
  if (!b) return;
  const entry = await getEntry(b.dataset.recent!);
  if (!entry) return;
  recovery = entry.recovery ?? loadDefaultRecovery();
  await loadFiles(entry.files, entry.id, entry.name);
});
renderRecent();

// open a sample straight from the URL, e.g. ?sample=SN0614
const qs = new URLSearchParams(location.search).get("sample");
if (qs && /^SN\d+$/.test(qs)) loadSample(qs);

// ---------- record the replay as a video ----------
let recording: { rec: Recorder; stop: boolean } | null = null;
async function recordVideo() {
  if (recording) { recording.stop = true; return; }
  if (!A || !flight) return;
  const mime = pickMime();
  if (!mime || !replay3d) { showWarnings(["This browser can't record video here (it needs MediaRecorder and the 3D view). Chrome, Edge and Firefox can."]); return; }
  pause();
  const lift = A.events.find((e) => e.key === "liftoff")?.t ?? A.tStart;
  const land = A.events.find((e) => e.key === "landing")?.t ?? A.tEnd;
  const t0 = Math.max(A.tStart, lift - 1.5), t1 = Math.min(A.tEnd, land + 2);
  const speed = parseFloat(speedSel.value);
  const { main } = replay.frameCanvases!();
  const rec = new Recorder(main.width, main.height, mime);
  recording = { rec, stop: false };
  const btn = $("rec-btn");
  btn.textContent = "■"; btn.classList.add("on"); btn.setAttribute("aria-label", "Stop recording");
  const title = `${currentEntryName ?? flight.gps?.name ?? flight.name}${speed !== 1 ? `, ${speed}× speed` : ""}`;
  let sim = t0, last = performance.now();
  await new Promise<void>((resolve) => {
    const frame = (now: number) => {
      sim = Math.min(t1, sim + ((now - last) / 1000) * speed);
      last = now;
      seek(sim);
      const i = indexAt(flight!.lr!.t, sim);
      const c = replay.frameCanvases!();
      rec.draw({
        main: c.main, inset: c.inset,
        phase: phaseAt(sim), time: `T${sim < 0 ? "−" : "+"}${Math.abs(sim).toFixed(1)} s`,
        lines: [`Altitude ${show(A!.altSmooth[i], "ft")}`, `Vertical ${show(flight!.lr!.velUp[i], "ft/s")}`, `Tilt ${flight!.lr!.tilt[i].toFixed(0)}°`],
        title,
      });
      if (sim >= t1 || recording?.stop) { resolve(); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  rec.stop();
  const blob = await rec.done;
  recording = null;
  btn.textContent = "●"; btn.classList.remove("on"); btn.setAttribute("aria-label", "Record video");
  downloadBlob(`${fileSlug(currentEntryName ?? flight.gps?.name ?? flight.name)}-replay.webm`, blob);
}
$("rec-btn").addEventListener("click", () => recordVideo());

initPreflight(showWarnings);
initOffline();
initHelp();
$("gpsonly-close").addEventListener("click", () => $<HTMLDialogElement>("gpsonly-dialog").close());
