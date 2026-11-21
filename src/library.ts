// Flight library stored in this browser (IndexedDB). Each entry keeps the original files so
// opening it later re-runs the same analysis. Backups are a .zip of all entries.

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { RecoveryConfig } from "./recovery";

export interface StoredFile { name: string; text?: string; buffer?: ArrayBuffer }

export interface LibraryEntry {
  id: string;
  kind: "flight" | "sim";
  name: string;
  date: string; // YYYY-MM-DD
  notes: string;
  vehicle?: string;
  motor?: string;
  tags?: string[];
  savedAt: string; // ISO
  stats: {
    apogee?: number | null; flightTime?: number | null; drift?: number | null; maxVel?: number | null; hasGps?: boolean;
    drogueRate?: number | null; mainRate?: number | null; maxAccel?: number | null; mainAlt?: number | null;
    /** from the accelerometer, using the vehicle masses at save time */
    coastCd?: number | null; impulseNs?: number | null;
    maxQ?: number | null; maxMach?: number | null;
    /** altimeter health: battery on the pad, lowest in flight, and data-quality warnings */
    padBattV?: number | null; minBattV?: number | null; dataWarnings?: number | null;
  };
  files: StoredFile[];
  /** recovery check setup for this vehicle (section masses, limits) */
  recovery?: RecoveryConfig;
  /** notes pinned to moments in the flight (s, flight time) */
  marks?: { t: number; text: string }[];
  /** set when moved to the trash (ISO); emptied for good after TRASH_DAYS */
  deletedAt?: string;
}

export const TRASH_DAYS = 30;

const DB = "data-compare";
const STORE = "flights";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: "id" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(req.result); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}

const allEntries = () => tx<LibraryEntry[]>("readonly", (s) => s.getAll());

/** Saved flights and sims, not counting the trash. */
export async function listEntries(): Promise<LibraryEntry[]> {
  const all = (await allEntries()).filter((e) => !e.deletedAt);
  return all.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.savedAt.localeCompare(a.savedAt));
}

export const getEntry = (id: string) => tx<LibraryEntry | undefined>("readonly", (s) => s.get(id));
export const putEntry = (e: LibraryEntry) => tx("readwrite", (s) => s.put(e));
/** Removes an entry for good. The library's Delete button uses trashEntry instead. */
export const deleteEntry = (id: string) => tx("readwrite", (s) => s.delete(id));

/** Move to the trash; it can be restored for TRASH_DAYS days. */
export async function trashEntry(id: string) {
  const e = await getEntry(id);
  if (e) await putEntry({ ...e, deletedAt: new Date().toISOString() });
}
export async function restoreEntry(id: string) {
  const e = await getEntry(id);
  if (!e) return;
  const { deletedAt: _d, ...rest } = e;
  await putEntry(rest);
}
/** Days left before a trashed entry is removed for good. */
export const trashDaysLeft = (e: LibraryEntry, now = Date.now()) =>
  Math.max(0, Math.ceil(TRASH_DAYS - (now - Date.parse(e.deletedAt ?? "")) / 86_400_000));

/** Trash newest first. Anything older than TRASH_DAYS is removed for good first. */
export async function listTrash(now = Date.now()): Promise<LibraryEntry[]> {
  const trashed = (await allEntries()).filter((e) => e.deletedAt);
  const keep: LibraryEntry[] = [];
  for (const e of trashed) {
    if (trashDaysLeft(e, now) <= 0) await deleteEntry(e.id);
    else keep.push(e);
  }
  return keep.sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!));
}

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ask the browser not to evict the library when space is low. */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

export async function storageUse(): Promise<{ used: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch { return null; }
}

// ---------- backup ----------

/** zip layout: <id>/entry.json (metadata) + <id>/<file name>. Pass entries to export only those. */
export async function exportBackup(only?: LibraryEntry[]): Promise<Blob> {
  const entries = only ?? (await listEntries());
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) {
    const { files: fs, ...meta } = e;
    files[`${e.id}/entry.json`] = strToU8(JSON.stringify({ ...meta, fileNames: fs.map((f) => f.name) }, null, 2));
    for (const f of fs) files[`${e.id}/${f.name}`] = f.buffer ? new Uint8Array(f.buffer) : strToU8(f.text ?? "");
  }
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });
}

/** Import a backup or shared-flight zip; entries with an existing id are replaced. Returns the imported entries. */
export async function importBackup(buf: ArrayBuffer): Promise<LibraryEntry[]> {
  const all = unzipSync(new Uint8Array(buf));
  const imported: LibraryEntry[] = [];
  for (const path of Object.keys(all).filter((p) => p.endsWith("/entry.json"))) {
    const dir = path.slice(0, -"entry.json".length);
    const meta = JSON.parse(strFromU8(all[path])) as Omit<LibraryEntry, "files"> & { fileNames: string[] };
    const files: StoredFile[] = [];
    for (const name of meta.fileNames) {
      const data = all[dir + name];
      if (!data) continue;
      files.push(/\.xlsx$/i.test(name) ? { name, buffer: data.slice().buffer as ArrayBuffer } : { name, text: strFromU8(data) });
    }
    const { fileNames: _ignored, ...rest } = meta;
    const entry = { ...rest, files };
    await putEntry(entry);
    imported.push(entry);
  }
  if (imported.length === 0) throw new Error("no flights found in the zip");
  return imported;
}
