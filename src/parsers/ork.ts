// OpenRocket design file (.ork): pulls out what the Vehicle card and fin flutter check need.
// An .ork is a ZIP holding rocket.ork (XML), or gzip'd / plain XML in older versions. Lengths
// are metres and masses kilograms inside. Masses come from a saved simulation's data (Mass at
// liftoff and at burnout), since computing them from parts would mean re-doing OpenRocket.
import { gunzipSync, strFromU8, unzipSync } from "fflate";

export interface OrkVehicle {
  name: string;
  diaIn: number | null;
  liftoffLb: number | null;
  burnoutLb: number | null;
  fin: { rootIn: number; tipIn: number; spanIn: number; thickIn: number; material: string } | null;
  notes: string[];
}

const M_TO_IN = 39.3701, KG_TO_LB = 2.20462;

function xmlText(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x50 && u8[1] === 0x4b) { // ZIP
    const files = unzipSync(u8);
    const key = Object.keys(files).find((k) => /\.ork$/i.test(k)) ?? Object.keys(files).find((k) => /\.xml$/i.test(k)) ?? Object.keys(files)[0];
    if (!key) throw new Error("empty .ork archive");
    return strFromU8(files[key]);
  }
  if (u8[0] === 0x1f && u8[1] === 0x8b) return strFromU8(gunzipSync(u8)); // gzip
  return strFromU8(u8);
}

export function parseOrk(buf: ArrayBuffer): OrkVehicle {
  const doc = new DOMParser().parseFromString(xmlText(buf), "application/xml");
  if (!doc.getElementsByTagName("openrocket").length && !doc.getElementsByTagName("rocket").length) throw new Error("not an OpenRocket design file");
  const notes: string[] = [];
  const num = (el: Element | null | undefined, tag: string) => {
    const c = el ? Array.from(el.children).find((x) => x.tagName === tag) : undefined;
    const v = c ? parseFloat(c.textContent ?? "") : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const rocket = doc.getElementsByTagName("rocket")[0];
  const name = rocket ? Array.from(rocket.children).find((x) => x.tagName === "name")?.textContent?.trim() ?? "Rocket" : "Rocket";

  // body diameter: the largest body tube with a numeric outer radius ("auto" is skipped)
  let r = 0;
  for (const bt of Array.from(doc.getElementsByTagName("bodytube"))) { const v = num(bt, "outerradius"); if (v && v > r) r = v; }
  const diaIn = r > 0 ? 2 * r * M_TO_IN : null;
  if (!diaIn) notes.push("No body tube with a fixed outer radius (they may all be set to automatic).");

  // first trapezoidal fin set
  const fs = doc.getElementsByTagName("trapezoidfinset")[0];
  let fin: OrkVehicle["fin"] = null;
  if (fs) {
    const root = num(fs, "rootchord"), tip = num(fs, "tipchord"), h = num(fs, "height"), t = num(fs, "thickness");
    const mat = Array.from(fs.children).find((x) => x.tagName === "material")?.textContent?.trim() ?? "";
    if (root && h && t) fin = { rootIn: root * M_TO_IN, tipIn: (tip ?? 0) * M_TO_IN, spanIn: h * M_TO_IN, thickIn: t * M_TO_IN, material: mat };
  } else notes.push("No trapezoidal fin set found (elliptical or free-form fins aren't read).");

  // masses from the first simulation that saved its data
  let liftoffLb: number | null = null, burnoutLb: number | null = null;
  for (const br of Array.from(doc.getElementsByTagName("databranch"))) {
    const types = (br.getAttribute("types") ?? "").split(",");
    const iT = types.indexOf("Time"), iM = types.indexOf("Mass");
    if (iT < 0 || iM < 0) continue;
    const rows = Array.from(br.getElementsByTagName("datapoint")).map((d) => (d.textContent ?? "").split(",").map(Number));
    if (!rows.length) continue;
    const bo = Array.from(br.getElementsByTagName("event")).find((e) => e.getAttribute("type") === "burnout");
    const tBo = bo ? parseFloat(bo.getAttribute("time") ?? "") : NaN;
    liftoffLb = rows[0][iM] * KG_TO_LB;
    const after = Number.isFinite(tBo) ? rows.find((x) => x[iT] >= tBo) : rows[rows.length - 1];
    burnoutLb = after ? after[iM] * KG_TO_LB : null;
    break;
  }
  if (liftoffLb === null) notes.push("No saved simulation data with a Mass column: run a simulation in OpenRocket and save the file to read the masses.");
  return { name, diaIn, liftoffLb, burnoutLb, fin, notes };
}

/** shear modulus guess from OpenRocket's material name */
export function gFromMaterial(name: string): number | null {
  if (/fiberglass|fibreglass|g-?10|fr-?4/i.test(name)) return 425_000;
  if (/alumin/i.test(name)) return 3_800_000;
  if (/plywood|birch/i.test(name)) return 90_000;
  return null;
}
