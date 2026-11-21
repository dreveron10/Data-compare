import { readFileSync } from "node:fs";
import { loadBlueRaven } from "../../src/parsers/blueRaven";
import { analyze } from "../../src/analysis";

/** load one of the bundled sample flights the way the site does */
export async function sample(sn: "SN0614" | "SN1742") {
  const dir = `public/samples/${sn}/`;
  const text = (n: string) => ({ name: `${sn}_${n.replace(".csv", "")}_sample.csv`, text: readFileSync(dir + n, "utf8") });
  const files: { name: string; text?: string; buffer?: ArrayBuffer }[] = [text("HR.csv"), text("LR.csv"), text("summary.csv")];
  if (sn === "SN0614") files.push(text("gps.csv"), text("gps_summary.csv"));
  const x = readFileSync(dir + "deploy_settings.xlsx");
  files.push({ name: "deploy_settings.xlsx", buffer: x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer });
  const { flight } = await loadBlueRaven(files);
  return { f: flight, a: analyze(flight) };
}
export const ev = (a: { events: { key: string; t: number }[] }, k: string) => a.events.find((e) => e.key === k)?.t;
