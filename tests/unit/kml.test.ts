import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { sample } from "./helpers";
import { buildKml } from "../../src/kml";

describe("buildKml", () => {
  it("writes ascent, descent, pad, landing and events as valid KML (SN0614)", async () => {
    const { f, a } = await sample("SN0614");
    const apo = a.events.find((e) => e.key === "apogee")!.t;
    const evs = a.events.filter((e) => e.key.startsWith("fire_")).map((e) => ({ label: e.label, t: e.t }));
    const kml = buildKml(f.gps!, "Bullet bill & co", a.gps!.t, apo, evs, a.gps!.landing);
    const doc = new DOMParser().parseFromString(kml, "text/xml");
    const lines = doc.getElementsByTagName("LineString");
    expect(lines.length).toBe(2);
    const names = Array.from(doc.getElementsByTagName("Placemark")).map((p) => p.getElementsByTagName("name")[0].textContent);
    expect(names).toContain("Pad");
    expect(names).toContain("Landing");
    expect(names.some((n) => n?.startsWith("Apo fired"))).toBe(true);
    // lon,lat,alt order and the pad near SN0614's site
    const [lon, lat] = doc.getElementsByTagName("coordinates")[0].textContent!.trim().split(" ")[0].split(",").map(Number);
    expect(lat).toBeGreaterThan(34);
    expect(lon).toBeLessThan(-80);
    expect(doc.getElementsByTagName("name")[0].textContent).toBe("Bullet bill & co");
  });
});
