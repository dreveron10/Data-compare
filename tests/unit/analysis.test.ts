import { describe, expect, it } from "vitest";
import { ev, sample } from "./helpers";
import { findFindings } from "../../src/findings";
import { checkSettings } from "../../src/settingsCheck";
import { windProfile } from "../../src/wind";
import { ejectionTimes } from "../../src/ejection";
import { aeroSeries } from "../../src/aero";
import { coastDrag } from "../../src/coast";
import { motorClass, thrustCurve } from "../../src/thrust";
import { keyNumbersOf, whatChanged } from "../../src/compare";

// Reference values from the sample flights, checked by hand when each feature was built.
// A change that moves one of these is either a bug or needs a deliberate update here.
describe("SN0614 bullet bill (Blue Raven + GPS)", async () => {
  const { f, a } = await sample("SN0614");
  const k = keyNumbersOf(a);

  it("finds the flight events", () => {
    expect(ev(a, "liftoff")).toBeCloseTo(0, 1);
    expect(ev(a, "burnout")).toBeCloseTo(2.44, 1);
    expect(ev(a, "apogee")).toBeCloseTo(16.18, 1);
    expect(ev(a, "fire_Main")).toBeCloseTo(50.4, 1);
    expect(ev(a, "landing")).toBeCloseTo(71.74, 0);
  });
  it("key numbers", () => {
    expect(k.apogee!).toBeGreaterThan(4000); expect(k.apogee!).toBeLessThan(4030);
    expect(k.drogueRate!).toBeCloseTo(-106, -1);
    expect(k.mainRate!).toBeCloseTo(-22, 0);
    expect(k.drift!).toBeCloseTo(2495, -1);
  });
  it("aligns the GPS", () => {
    expect(a.gps).toBeTruthy();
    expect(a.gps!.landing.bearing).toBeCloseTo(212, -1);
  });
  it("flags the known problems", () => {
    const titles = findFindings(f, a).map((x) => x.title);
    expect(titles).toContain("Large tilt at burnout");
    expect(titles).toContain("High roll rate on ascent");
    expect(titles.some((t) => /4th fired on a pressure spike/.test(t))).toBe(true);
    expect(titles.some((t) => /Main opened/.test(t))).toBe(false);
  });
  it("settings check: backup 3rd before Apo", () => {
    expect(checkSettings(f.settings!).map((i) => i.title)).toEqual(["Backup 3rd fires before Apo"]);
  });
  it("wind from GPS drift", () => {
    const w = windProfile(f.gps!, a)!;
    expect(w.mean.fromDeg).toBeGreaterThan(200); expect(w.mean.fromDeg).toBeLessThan(240);
  });
  it("ejection timing and main opening load", () => {
    const m = ejectionTimes(f, a).find((x) => x.key === "fire_Main")!;
    expect(m.delay!).toBeCloseTo(0.62, 1);
    expect(m.openG!).toBeGreaterThan(80);
  });
  it("max q, coast Cd and impulse with the reference mass", () => {
    const ae = aeroSeries(f, a)!;
    expect(ae.maxQ).toBeCloseTo(342, -1);
    const cd = coastDrag(f, a, 40, 6)!.cd50;
    expect(cd).toBeCloseTo(0.31, 1);
    expect(thrustCurve(f, a, 40, 0, 6, cd)!.impulseNs).toBeCloseTo(3620, -2);
  });
});

describe("SN1742", async () => {
  const { f, a } = await sample("SN1742");
  it("flags the early Apo and the low main", () => {
    const titles = findFindings(f, a).map((x) => x.title);
    expect(titles).toContain("Apo fired before apogee");
    expect(titles).toContain("Main opened very low");
  });
  it("settings check explains both", () => {
    const titles = checkSettings(f.settings!).map((i) => i.title);
    expect(titles).toContain("Apo can fire before apogee");
    expect(titles).toContain("Main, 3rd and 4th set to fire at 50 ft");
  });
  it("coast drag stops at the early fire", () => {
    expect(coastDrag(f, a, 40, 6)!.cutBy?.label).toBe("Apo fired");
  });
});

describe("helpers", () => {
  it("motor class", () => {
    expect(motorClass(2000)).toBe("56% K");
    expect(motorClass(161)).toBe("1% H");
  });
  it("what changed sentence", async () => {
    const A = keyNumbersOf((await sample("SN0614")).a), B = keyNumbersOf((await sample("SN1742")).a);
    expect(whatChanged(A, B, "X")).toMatch(/^Against X, this flight /);
  });
});

import { predictLanding } from "../../src/predict";
describe("landing what-if", async () => {
  const { f, a } = await sample("SN0614");
  const w = windProfile(f.gps!, a)!;
  const k = keyNumbersOf(a);
  it("lands near the real landing with the flown settings", () => {
    const p = predictLanding(w, { east: 0, north: 0, alt: k.apogee! }, k.mainAlt!, Math.abs(k.drogueRate!), Math.abs(k.mainRate!));
    expect(p.distance).toBeGreaterThan(500);
    expect(p.bearing).toBeGreaterThan(0);
  });
  it("a lower main drifts less", () => {
    const hi = predictLanding(w, { east: 0, north: 0, alt: 4000 }, 800, 100, 20);
    const lo = predictLanding(w, { east: 0, north: 0, alt: 4000 }, 400, 100, 20);
    expect(lo.distance).toBeLessThan(hi.distance);
  });
});
