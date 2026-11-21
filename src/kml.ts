// KML of a GPS-tracked flight for Google Earth: the ascent and the descent as two 3D lines
// (absolute altitude, dropped to the ground so the shape reads), the pad, the landing and a
// placemark at each flight event where the GPS has a fix.

import type { GpsData } from "./parsers/featherweightGps";

export interface KmlEvent { label: string; t: number }

const FT = 0.3048;
const xml = (s: string) => s.replace(/[<&>"]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * @param tBr GPS sample times on the Blue Raven clock (same length as g.n), or null to use g.t
 * @param apogeeT apogee on that clock: splits ascent from descent
 */
export function buildKml(g: GpsData, name: string, tBr: ArrayLike<number> | null, apogeeT: number, events: KmlEvent[], landing: { lat: number; lon: number } | null): string {
  const t = tBr ?? g.t;
  const ok = (i: number) => !!g.fix[i] && Number.isFinite(g.lat[i]) && Number.isFinite(g.lon[i]) && !(g.lat[i] === 0 && g.lon[i] === 0) && Number.isFinite(g.altAsl[i]);
  const pt = (i: number) => `${g.lon[i].toFixed(7)},${g.lat[i].toFixed(7)},${(g.altAsl[i] * FT).toFixed(1)}`;
  const up: string[] = [], down: string[] = [];
  let lastUp = -1;
  for (let i = 0; i < g.n; i++) {
    if (!ok(i)) continue;
    if (t[i] <= apogeeT) { up.push(pt(i)); lastUp = i; } else down.push(pt(i));
  }
  if (lastUp >= 0 && down.length) down.unshift(pt(lastUp)); // join the two lines at apogee
  const near = (tt: number) => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < g.n; i++) if (ok(i) && Math.abs(t[i] - tt) < bd) { bd = Math.abs(t[i] - tt); best = i; }
    return bd <= 2 ? best : -1;
  };
  const place = (label: string, style: string, coord: string, mode = "absolute") =>
    `<Placemark><name>${xml(label)}</name><styleUrl>#${style}</styleUrl><Point><altitudeMode>${mode}</altitudeMode><coordinates>${coord}</coordinates></Point></Placemark>`;
  const marks: string[] = [];
  if (Number.isFinite(g.padLat) && Number.isFinite(g.padLon)) marks.push(place("Pad", "pad", `${g.padLon.toFixed(7)},${g.padLat.toFixed(7)},0`, "clampToGround"));
  if (landing) marks.push(place("Landing", "land", `${landing.lon.toFixed(7)},${landing.lat.toFixed(7)},0`, "clampToGround"));
  for (const e of events) {
    const i = near(e.t);
    if (i >= 0) marks.push(place(`${e.label} (GPS ${(g.altAgl[i]).toFixed(0)} ft AGL)`, "ev", pt(i)));
  }
  const line = (label: string, style: string, coords: string[]) => coords.length < 2 ? "" :
    `<Placemark><name>${xml(label)}</name><styleUrl>#${style}</styleUrl><LineString><extrude>1</extrude><tessellate>0</tessellate><altitudeMode>absolute</altitudeMode><coordinates>${coords.join(" ")}</coordinates></LineString></Placemark>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${xml(name)}</name>
<Style id="up"><LineStyle><color>ff1a7aff</color><width>3</width></LineStyle><PolyStyle><color>401a7aff</color></PolyStyle></Style>
<Style id="down"><LineStyle><color>ffffc46c</color><width>3</width></LineStyle><PolyStyle><color>40ffc46c</color></PolyStyle></Style>
<Style id="pad"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon></IconStyle></Style>
<Style id="land"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon></IconStyle></Style>
<Style id="ev"><IconStyle><scale>0.7</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>
${line("Ascent", "up", up)}
${line("Descent", "down", down)}
${marks.join("\n")}
</Document>
</kml>`;
}
