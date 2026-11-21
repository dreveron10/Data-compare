import "./style.css";
import { analyze, indexAt, type Analysis } from "./analysis";
import { CHANNELS, loadBlueRaven, type BlueRavenFlight, type Channel } from "./parsers/blueRaven";
import { Replay3D, type CameraMode } from "./replay3d";
import { Charts } from "./charts";
import { CMP_COLORS, KEY_ROWS, MAX_COMPARES, keyNumbersOf, traceFromFlight, traceFromSim, type ActiveCompare, type CompareTrace } from "./compare";
import { isOpenRocket, parseOpenRocket } from "./parsers/openRocket";
import { EARTH_ATTRIBUTION } from "./earth";
import { evaluate, loadDefaultRecovery, saveDefaultRecovery, type RecoveryConfig } from "./recovery";
import {
  deleteEntry, exportBackup, getEntry, importBackup, listEntries, newId, putEntry, requestPersistence, storageUse,
  type LibraryEntry,
} from "./library";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $("app");
// 3D needs WebGL; without it (old GPUs, some remote browsers) the rest of the site still works
type ReplayApi = Pick<Replay3D, "setFlight" | "setCompare" | "setTime" | "setCameraMode" | "setSatellite"> & {
  onSatellite?: (available: boolean, progress: number) => void;
};
let replay: ReplayApi;
try {
  replay = new Replay3D($("view3d"), $("inset3d"));
} catch {
  replay = { setFlight() {}, setCompare() {}, setTime() {}, setCameraMode() {}, setSatellite() {} };
  document.body.classList.add("no-webgl");
  $("view3d").innerHTML =
    '<div class="no-gl">3D replay needs WebGL, which this browser has turned off or does not support. ' +
    "Charts and tables below still work. Try Chrome or Edge with hardware acceleration enabled.</div>";
}
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
async function loadFiles(files: InFile[], entryId?: string) {
  const warn: string[] = [];
  try {
    const res = await loadBlueRaven(files);
    warn.push(...res.warnings);
    if (!res.flight.lr) throw new Error("No Blue Raven LR file found. Include the *_LR_*.csv file.");
    gpsOffsetOverride = undefined;
    cmps = [];
    const a = analyze(res.flight);
    warn.push(...a.warnings);
    flight = res.flight;
    A = a;
    lastFiles = files;
    currentEntryId = entryId;
    if (!entryId) recovery = loadDefaultRecovery();
    $("save-open").hidden = false;
    $("save-open").textContent = entryId ? "Edit saved flight" : "Save flight";
    showFlight();
  } catch (e) {
    warn.unshift((e as Error).message);
  }
  showWarnings(warn);
}

type InFile = { name: string; text?: string; buffer?: ArrayBuffer };

async function readList(list: FileList | File[]): Promise<InFile[]> {
  return Promise.all(
    Array.from(list).map(async (f) => (/\.xlsx$/i.test(f.name) ? { name: f.name, buffer: await f.arrayBuffer() } : { name: f.name, text: await f.text() })),
  );
}

async function fromFileList(list: FileList | File[]) {
  const files = await readList(list);
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
    if (sim) {
      trace = traceFromSim(parseOpenRocket(sim.text!, sim.name));
    } else {
      const res = await loadBlueRaven(files);
      if (!res.flight.lr) throw new Error("Comparison needs an OpenRocket CSV export or a Blue Raven LR file.");
      trace = traceFromFlight(analyze(res.flight), res.flight);
    }
    // keep at most 3: the oldest drops off
    if (cmps.length >= MAX_COMPARES) cmps.shift();
    const used = new Set(cmps.map((c) => c.color));
    const color = CMP_COLORS.find((c) => !used.has(c)) ?? CMP_COLORS[0];
    cmps.push({ id: `${Date.now()}-${Math.random()}`, trace, files, offset: 0, color });
    applyCompare();
    showWarnings(A.warnings);
  } catch (e) {
    showWarnings([`Comparison: ${(e as Error).message}`]);
  }
}

function applyCompare() {
  if (!A || !flight) return;
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
    $("cmp-sub").textContent = "Overlay up to 3 OpenRocket sims or other Blue Raven flights. They are aligned at liftoff.";
    return;
  }
  $("cmp-sub").textContent = "Dashed lines in the charts and 3D. Shift a comparison in time if its liftoff doesn't line up.";
  $("cmp-list").innerHTML = cmps
    .map((c) => `<div class="cmp-item"><i style="background:${c.color}"></i><span class="nm" title="${escapeHtml(c.trace.name)}">${c.trace.kind === "sim" ? "Sim: " : ""}${escapeHtml(c.trace.name)}</span>
      <label class="off">shift <input type="number" step="0.1" value="${c.offset}" data-off="${c.id}" aria-label="Time shift in seconds" /> s</label>
      <button class="x" data-rmc="${c.id}" aria-label="Remove comparison">×</button></div>`)
    .join("");
  const mine = keyNumbersOf(A);
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
    return `<tr><td>${label}</td><td>${fmt(a, unit)}</td>${others.map((o) => `<td>${fmt(o, unit)}</td>`).join("")}${single ? diff || "<td></td>" : ""}<td class="unit">${unit}</td></tr>`;
  }).join("");
  const heads = cmps.map((c) => `<th><i class="sw" style="background:${c.color}"></i></th>`).join("");
  $("cmp-table").innerHTML = `<tr><th>Metric</th><th>This</th>${heads}${single ? "<th>Δ</th>" : ""}<th></th></tr>${rows}`;
  const notes = [...new Set(cmps.flatMap((c) => c.trace.notes))];
  if (cmps.some((c) => c.trace.path && c.trace.compass !== A!.compass)) notes.push("3D heading isn't aligned for comparisons without GPS or position data.");
  $("cmp-notes").innerHTML = notes.map((n) => `<div>${escapeHtml(n)}</div>`).join("");
}

async function loadSample(sn: string) {
  setBusy(true);
  try {
    await loadFiles(await fetchSample(sn));
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
  const fdate = flightDate();
  const fnum = flight.summary?.raw["Flight number"];
  $("flight-name").textContent = `${flight.gps?.name ?? flight.name}${fdate ? `, ${new Date(fdate + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : ""}${fnum ? `, Blue Raven flight ${fnum}` : ""}`;
  scrub.min = String(A.tStart);
  scrub.max = String(A.tEnd);
  scrub.step = "0.002";
  replay.setFlight(A, flight);
  replay.setCompare(cmps);
  charts.setFlight(A, flight, cmps);
  renderCompare();
  $("lg-x").textContent = A.compass ? "East" : "Downrange";
  $("lg-z").textContent = A.compass ? "North" : "Crossrange";
  renderMetrics();
  renderRecovery();
  renderGps();
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

function renderRecovery() {
  $("rec-panel").hidden = !A;
  if (!A) return;
  const x = recoveryInputs();
  $("rec-sub").textContent = x.landingSpeed !== null
    ? `Landing speed ${x.landingSpeed.toFixed(1)} ft/s, from the main descent fit.`
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
  $("gps-sub").textContent = `${flight.gps.name}, aligned ${g.manual ? "manually" : "automatically"}. Heading fit ${(((g.yaw * 180) / Math.PI + 360) % 360).toFixed(0)}°, ascent mismatch ${g.ascentRms.toFixed(0)} ft RMS.`;
  const rows = g.rows.map((r) => {
    let diff = "";
    if (r.br !== null && r.gps !== null && Number.isFinite(r.br) && Number.isFinite(r.gps)) {
      const d = r.br - r.gps;
      const rel = Math.abs(r.gps) > 1e-6 ? Math.abs(d / r.gps) : 0;
      diff = `<span class="diff${rel > 0.05 ? " big" : ""}">${d >= 0 ? "+" : ""}${fmt(d, r.unit)}</span>`;
    }
    return `<tr${r.note ? ` title="${escapeHtml(r.note)}"` : ""}><td>${escapeHtml(r.label)}</td><td>${fmt(r.br, r.unit)}</td><td>${fmt(r.gps, r.unit)}</td><td>${diff}</td><td class="unit">${r.unit}</td></tr>`;
  });
  $("compare").className = "metrics cmp";
  $("compare").innerHTML = `<tr><th>Metric</th><th>Blue Raven</th><th>GPS</th><th>Δ</th><th></th></tr>${rows.join("")}`;
  const L = g.landing;
  const ll = `${L.lat.toFixed(5)}, ${L.lon.toFixed(5)}`;
  $("gps-landing").innerHTML = `Landing: <b>${L.distance.toFixed(0)} ft</b> from the pad, bearing <b>${L.bearing.toFixed(0)}°</b><br/>` +
    `<a href="https://www.google.com/maps?q=${encodeURIComponent(ll)}" target="_blank" rel="noopener">${ll} ↗</a>`;
  $<HTMLInputElement>("gps-offset").value = g.offset.toFixed(2);
}

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
  $("events").innerHTML = A!.events
    .map((e, i) => {
      const alt = p.y[indexAt(p.t, e.t)];
      return `<li data-t="${e.t}"><span class="num">${i < 9 ? i + 1 : ""}</span><i style="background:${e.color}"></i>${escapeHtml(e.label)}<span class="alt">${alt.toFixed(0)} ft</span><span class="t">T+${e.t.toFixed(2)} s</span></li>`;
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
    const delay = s.options["Use_Delay"]?.[ch] === "TRUE" ? `, ${vals.delay} s delay` : "";
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
  const v = (n: string, unit: string) => `${n}<small>${unit}</small>`;
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
    <div><div class="k">Drift from pad</div><div class="v">${d.distance[k].toFixed(0)}<small>ft</small></div></div>
    <div><div class="k">GPS satellites</div><div class="v">${d.sats[k]}</div></div>`;
}

// ---------- playback ----------
function seek(time: number) {
  if (!A) return;
  t = Math.min(A.tEnd, Math.max(A.tStart, time));
  scrub.value = String(t);
  $("time").textContent = `T${t < 0 ? "−" : "+"}${Math.abs(t).toFixed(2)}`;
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
  replay.setCameraMode(mode);
}
document.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement;
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
  else if (k === "f" || k === "F") setCam("follow");
  else if (k === "o" || k === "O") setCam("overview");
  else if (k === "g" || k === "G") setCam("ground");
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

// ---------- library (saved in this browser) ----------
const saveDlg = $<HTMLDialogElement>("save-dialog");
const libDlg = $<HTMLDialogElement>("lib-dialog");

function flightDate(): string {
  // the GPS clock is reliable; the Blue Raven clock may not be set
  const g = flight?.gps;
  if (g) {
    const d = new Date(g.launchUnix * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const k = keyNumbersOf(A);
  const entry: LibraryEntry = {
    id: currentEntryId ?? newId(),
    kind: "flight", name, date, notes,
    savedAt: new Date().toISOString(),
    stats: { apogee: k.apogee, flightTime: k.flightTime, drift: k.drift, maxVel: k.maxVel, hasGps: !!flight.gps },
    files: lastFiles,
    recovery,
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
    $("save-open").textContent = "Edit saved flight";
    requestPersistence();
    showWarnings(A.warnings);
  } catch (err) {
    showWarnings([`Could not save to the library: ${(err as Error).message}`]);
  }
});

const num = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d));

async function renderLibrary() {
  const list = await listEntries();
  const el = $("lib-list");
  if (list.length === 0) {
    el.innerHTML = '<div class="lib-empty">No saved flights yet. Load a flight and press <b>Save flight</b>.</div>';
  } else {
    el.innerHTML = `<table class="lib-table"><tr><th>Date</th><th>Name</th><th style="text-align:right">Apogee</th><th style="text-align:right">Flight time</th><th style="text-align:right">Drift</th><th>Notes</th><th></th></tr>${list
      .map((e) => `<tr class="${e.id === currentEntryId ? "current" : ""}">
        <td>${escapeHtml(e.date || "-")}</td>
        <td>${escapeHtml(e.name)}${e.kind === "sim" ? '<span class="tag">SIM</span>' : ""}${e.stats.hasGps ? '<span class="tag">GPS</span>' : ""}</td>
        <td class="num">${num(e.stats.apogee)} ft</td>
        <td class="num">${num(e.stats.flightTime, 1)} s</td>
        <td class="num">${e.stats.drift != null ? num(e.stats.drift) + " ft" : "-"}</td>
        <td class="notes">${escapeHtml(e.notes)}</td>
        <td class="acts">
          ${e.kind === "flight" ? `<button class="btn small-btn" data-act="open" data-id="${e.id}">Open</button>` : ""}
          <button class="btn small-btn" data-act="cmp" data-id="${e.id}" ${!A || e.id === currentEntryId ? "disabled" : ""}>Compare</button>
          <button class="btn small-btn danger" data-act="del" data-id="${e.id}">Delete</button>
        </td></tr>`)
      .join("")}</table>`;
  }
  const u = await storageUse();
  $("lib-usage").textContent = `${list.length} saved${u ? `, ${(u.used / 1048576).toFixed(1)} MB used of ${(u.quota / 1073741824).toFixed(1)} GB available` : ""}`;
}

$("lib-open").addEventListener("click", async () => { await renderLibrary(); libDlg.showModal(); });
$("lib-close").addEventListener("click", () => libDlg.close());
$("lib-list").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
  if (!b) return;
  const entry = await getEntry(b.dataset.id!);
  if (!entry) return;
  if (b.dataset.act === "open") {
    libDlg.close();
    setBusy(true);
    recovery = entry.recovery ?? loadDefaultRecovery();
    try { await loadFiles(entry.files, entry.id); } finally { setBusy(false); }
  } else if (b.dataset.act === "cmp") {
    libDlg.close();
    await loadCompare(entry.files);
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
$("lib-export").addEventListener("click", async () => {
  const blob = await exportBackup();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `data-compare-library-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
{
  const inp = $<HTMLInputElement>("lib-import");
  inp.addEventListener("change", async () => {
    const f = inp.files?.[0];
    inp.value = "";
    if (!f) return;
    try {
      const n = await importBackup(await f.arrayBuffer());
      await renderLibrary();
      $("lib-usage").textContent = `Imported ${n} entr${n === 1 ? "y" : "ies"}. ` + $("lib-usage").textContent;
    } catch (err) {
      alert(`That file is not a Data Compare backup (${(err as Error).message}).`);
    }
  });
}

// open a sample straight from the URL, e.g. ?sample=SN0614
const qs = new URLSearchParams(location.search).get("sample");
if (qs && /^SN\d+$/.test(qs)) loadSample(qs);
