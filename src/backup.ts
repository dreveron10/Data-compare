// Library backup: export, and the reminder after a few saves that aren't in a backup yet
// (browser storage can be cleared).
import { exportBackup, listEntries } from "./library";
import { $ } from "./ui";

export async function exportLibrary() {
  const blob = await exportBackup();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `data-compare-library-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  try { localStorage.setItem("dc.lastBackup", new Date().toISOString()); localStorage.removeItem("dc.backupSnooze"); } catch { /* ignore */ }
  $("backup-toast").hidden = true;
  renderBackupNudge();
}
$("lib-export").addEventListener("click", () => exportLibrary());

// ---------- backup reminder: browser storage can be cleared, so nudge after a few new saves ----------
const NUDGE_AFTER = 3;
async function unbackedCount() {
  const since = localStorage.getItem("dc.lastBackup") ?? "";
  return (await listEntries()).filter((e) => e.savedAt > since).length;
}
export async function renderBackupNudge() {
  const n = await unbackedCount();
  const last = localStorage.getItem("dc.lastBackup");
  const el = $("lib-nudge");
  el.hidden = n === 0;
  el.innerHTML = n ? `${n} saved ${n === 1 ? "entry is" : "entries are"} not in a backup yet${last ? ` (last backup ${new Date(last).toLocaleDateString()})` : ""}. <button class="btn small-btn primary" type="button" data-backup>Export backup</button>` : "";
}
$("lib-nudge").addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("[data-backup]")) exportLibrary(); });
export async function maybeNudgeAfterSave() {
  const n = await unbackedCount();
  const snooze = Number(localStorage.getItem("dc.backupSnooze") ?? "0");
  if (n < NUDGE_AFTER || n < snooze) return;
  $("backup-toast-text").textContent = `${n} flights saved since your last library backup. Browser data can be cleared, so keep a copy.`;
  $("backup-toast").hidden = false;
}
$("backup-now").addEventListener("click", () => exportLibrary());
$("backup-later").addEventListener("click", async () => {
  // ask again after a few more saves
  try { localStorage.setItem("dc.backupSnooze", String((await unbackedCount()) + NUDGE_AFTER)); } catch { /* ignore */ }
  $("backup-toast").hidden = true;
});
