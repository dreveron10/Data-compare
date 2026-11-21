// Pre-flight mode: a deploy settings workbook dropped on its own gets checked, and a pad card can
// be printed from it. Needs no flight data.
import { CHANNELS, parseSettings, type Channel, type DeploySettings } from "./parsers/blueRaven";
import { checkSettings } from "./settingsCheck";
import { COND_MAP } from "./condLabels";
import { getVehicle, vehicleKeyOf, vehicleNames } from "./vehicle";
import { $, escapeHtml } from "./ui";
import { listEntries, type LibraryEntry } from "./library";

type InFile = { name: string; text?: string; buffer?: ArrayBuffer };
let showWarnings: (w: string[]) => void = () => undefined;
/** the page passes in how it shows warnings */
export function initPreflight(warn: (w: string[]) => void) { showWarnings = warn; }

let preState: { s: DeploySettings; name: string } | null = null;
export function preflight(file: InFile) {
  let s: DeploySettings;
  try { s = parseSettings(file.buffer!); }
  catch (e) { showWarnings([`${file.name}: not a Blue Raven deploy settings file (${(e as Error).message}).`]); return; }
  preState = { s, name: file.name };
  $("pre-vehicles").innerHTML = vehicleNames().map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
  const issues = checkSettings(s);
  const warns = issues.filter((i) => i.level === "warn").length;
  const notes = issues.length - warns;
  const parts = [warns ? `${warns} warning${warns === 1 ? "" : "s"}` : "", notes ? `${notes} note${notes === 1 ? "" : "s"}` : ""].filter(Boolean);
  $("pre-sub").textContent = `${file.name}: ${parts.length ? `${parts.join(" and ")} to look at before flying.` : "no common setup problems found."} Nothing is uploaded; this only reads the file.`;
  const chans = CHANNELS.map((ch: Channel) => {
    const vals: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.values)) vals[k] = v[ch];
    const chips = s.conditions.filter((c) => c.enabled[ch]).map((c) => `<span class="cond">${escapeHtml(COND_MAP[c.name]?.text(vals) ?? c.name)}</span>`).join("");
    const armed = s.options["Arm_by_default"]?.[ch] === "TRUE";
    const delay = s.options["Use_Delay"]?.[ch] === "TRUE" ? `${vals.delay} s delay` : "no delay";
    return `<div class="settings-ch"><h3>${ch} <span class="muted small">(${armed ? "armed by default" : "not armed by default"}, ${delay})</span></h3>${chips || '<span class="muted small">no conditions</span>'}</div>`;
  }).join("");
  $("pre-body").innerHTML = `<div class="set-check">${
    issues.length ? `<ul>${issues.map((i) => `<li class="${i.level}"><b>${escapeHtml(i.title)}</b><span>${escapeHtml(i.detail)}</span></li>`).join("")}</ul>` : ""
  }</div><div class="pre-chans">${chans}</div><p class="muted small">All conditions on a channel must be true for it to fire.</p>`;
  $<HTMLDialogElement>("pre-dialog").showModal();
}
$("pre-close").addEventListener("click", () => $<HTMLDialogElement>("pre-dialog").close());
/** the most recent saved flight of this vehicle, for the RSO table */
async function lastFlightOf(vname: string): Promise<LibraryEntry | null> {
  if (!vname) return null;
  const key = vehicleKeyOf(vname);
  try {
    const all = (await listEntries()).filter((x) => x.kind === "flight" && vehicleKeyOf(x.vehicle) === key);
    all.sort((a, b) => `${b.date || ""}|${b.savedAt}`.localeCompare(`${a.date || ""}|${a.savedAt}`));
    return all[0] ?? null;
  } catch { return null; }
}
function lastFlightBlock(x: LibraryEntry | null, vname: string): string {
  const e = escapeHtml;
  if (!vname) return "";
  if (!x) return `<section><h2>Last flight of this vehicle</h2><p>No saved flight of ${e(vname)} in this browser's library.</p></section>`;
  const st = x.stats;
  const n = (v: number | null | undefined, d: number, u: string) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v.toFixed(d)} ${u}`);
  const sl = st.slPass != null && st.slOver
    ? `${st.slPass} pass${st.slOver.length ? `, over the limit: ${e(st.slOver.join(", "))}` : ", none over"}`
    : "not stored (refresh stored numbers in the library)";
  const notes = x.notes ? (x.notes.length > 300 ? x.notes.slice(0, 300) + "..." : x.notes) : "";
  return `<section><h2>Last flight of this vehicle</h2><table>
    <tr><td>Flight</td><td class="n">${e(x.name)}${x.date ? `, ${e(x.date)}` : ""}${x.motor ? `, ${e(x.motor)}` : ""}</td></tr>
    <tr><td>Apogee</td><td class="n">${n(st.apogee, 0, "ft")}</td></tr>
    <tr><td>Main deployed at</td><td class="n">${n(st.mainAlt, 0, "ft")}</td></tr>
    <tr><td>Drogue / main descent</td><td class="n">${n(st.drogueRate === null || st.drogueRate === undefined ? null : Math.abs(st.drogueRate), 0, "ft/s")} / ${n(st.mainRate === null || st.mainRate === undefined ? null : Math.abs(st.mainRate), 0, "ft/s")}</td></tr>
    <tr><td>Drift</td><td class="n">${n(st.drift, 0, "ft")}</td></tr>
    <tr><td>Student Launch checks</td><td class="n">${sl}</td></tr>
    ${notes ? `<tr><td>Notes</td><td>${e(notes)}</td></tr>` : ""}
  </table></section>`;
}
$("pre-print").addEventListener("click", async () => {
  if (!preState) return;
  const { s, name } = preState;
  const e = escapeHtml;
  const vname = $<HTMLInputElement>("pre-vehicle").value.trim();
  const motor = $<HTMLInputElement>("pre-motor").value.trim();
  const apo = parseFloat($<HTMLInputElement>("pre-apogee").value);
  const v = getVehicle(vehicleKeyOf(vname));
  const lbs = (x: number | null) => (x === null ? "________" : `${x.toFixed(2)} lb`);
  const issues = checkSettings(s);
  const last = lastFlightBlock(await lastFlightOf(vname), vname);
  const chans = CHANNELS.map((ch: Channel) => {
    const vals: Record<string, number> = {};
    for (const [k, val] of Object.entries(s.values)) vals[k] = val[ch];
    const conds = s.conditions.filter((c) => c.enabled[ch]).map((c) => COND_MAP[c.name]?.text(vals) ?? c.name).join(", ");
    const armed = s.options["Arm_by_default"]?.[ch] === "TRUE" ? "yes" : "NO";
    const delay = s.options["Use_Delay"]?.[ch] === "TRUE" ? `${vals.delay} s` : "none";
    return `<tr><td><b>${ch}</b></td><td>${armed}</td><td>${delay}</td><td>${e(conds || "no conditions")}</td><td class="chk">☐</td></tr>`;
  }).join("");
  $("report").innerHTML = `
    <h1>Pad card${vname ? `: ${e(vname)}` : ""}</h1>
    <div class="meta">Date ____________ &nbsp; Flyer ____________________ &nbsp; Settings file ${e(name)}</div>
    <div class="cols">
      <section><h2>Vehicle</h2><table>
        <tr><td>Motor</td><td class="n">${motor ? e(motor) : "________"}</td></tr>
        <tr><td>Liftoff mass</td><td class="n">${v.burnoutLb !== null ? lbs(v.burnoutLb + (v.propLb ?? 0)) : "________"}</td></tr>
        <tr><td>Burnout mass</td><td class="n">${lbs(v.burnoutLb)}</td></tr>
        <tr><td>Body diameter</td><td class="n">${v.diaIn.toFixed(2)} in</td></tr>
        <tr><td>Expected apogee</td><td class="n">${Number.isFinite(apo) ? `${apo.toFixed(0)} ft` : "________"}</td></tr>
      </table></section>
      <section><h2>On the pad</h2><table>
        <tr><td>Altimeter armed, beeps OK</td><td class="chk">☐</td></tr>
        <tr><td>GPS tracker locked, sats ______</td><td class="chk">☐</td></tr>
        <tr><td>Charges and e-matches checked</td><td class="chk">☐</td></tr>
        <tr><td>Rail angle ______°, wind ______ mph</td><td class="chk">☐</td></tr>
        <tr><td>RSO initials ______</td><td class="chk">☐</td></tr>
      </table></section>
    </div>
    ${last}
    <section><h2>Deployment channels</h2><table><tr><th>Channel</th><th>Armed</th><th>Delay</th><th>Fires when all are true</th><th>OK</th></tr>${chans}</table></section>
    <section><h2>Settings check</h2>${issues.length ? `<table>${issues.map((i) => `<tr><td class="${i.level === "warn" ? "fail" : ""}">${i.level === "warn" ? "Warning" : "Note"}</td><td><b>${e(i.title)}</b>. ${e(i.detail)}</td></tr>`).join("")}</table>` : "<p>No common setup problems found.</p>"}</section>
    <div class="foot">Printed ${new Date().toLocaleString()} from Data Compare. Check against the altimeter itself before flight.</div>`;
  window.print();
});

