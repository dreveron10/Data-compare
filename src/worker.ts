// Parses Blue Raven / GPS files and runs the analysis off the main thread so the page stays responsive.
// The settings XLSX is parsed on the main thread (it needs DOMParser, which workers don't have).

import { analyze, type AnalyzeOptions } from "./analysis";
import { loadBlueRaven } from "./parsers/blueRaven";

export interface WorkRequest {
  id: number;
  files: { name: string; text: string }[];
  opts?: AnalyzeOptions;
}

self.onmessage = async (ev: MessageEvent<WorkRequest>) => {
  const { id, files, opts } = ev.data;
  try {
    const { flight, warnings } = await loadBlueRaven(files);
    const analysis = flight.lr ? analyze(flight, opts) : undefined;
    (self as unknown as Worker).postMessage({ id, ok: true, flight, analysis, warnings });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (e as Error).message });
  }
};
