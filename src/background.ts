// Run parsing + analysis in a Web Worker, falling back to the main thread if workers are unavailable.

import { analyze, type Analysis, type AnalyzeOptions } from "./analysis";
import { loadBlueRaven, parseSettings, type BlueRavenFlight } from "./parsers/blueRaven";

type InFile = { name: string; text?: string; buffer?: ArrayBuffer };
export interface Loaded { flight: BlueRavenFlight; analysis?: Analysis; warnings: string[] }

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Loaded) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => {
      const { id, ok, flight, analysis, warnings, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve({ flight, analysis, warnings });
      else p.reject(new Error(error));
    };
    worker.onerror = () => { worker = null; };
  } catch {
    worker = null;
  }
  return worker;
}

/** Load a set of flight files and analyze them, off the main thread when possible. */
export async function loadAndAnalyze(files: InFile[], opts?: AnalyzeOptions): Promise<Loaded> {
  const xlsx = files.filter((f) => f.buffer && /\.xlsx$/i.test(f.name));
  const texts = files
    .filter((f) => !xlsx.includes(f))
    .map((f) => ({ name: f.name, text: f.text ?? (f.buffer ? new TextDecoder().decode(f.buffer) : "") }));

  let res: Loaded;
  const w = getWorker();
  if (w) {
    try {
      res = await new Promise<Loaded>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, files: texts, opts });
      });
    } catch (e) {
      // a worker-side failure is a real data error: report it, don't silently retry
      throw e;
    }
  } else {
    const r = await loadBlueRaven(texts);
    res = { flight: r.flight, warnings: r.warnings, analysis: r.flight.lr ? analyze(r.flight, opts) : undefined };
  }
  for (const f of xlsx) {
    try { res.flight.settings = parseSettings(f.buffer!); }
    catch (e) { res.warnings.push(`${f.name}: ${(e as Error).message}`); }
  }
  return res;
}
