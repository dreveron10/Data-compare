import { describe, expect, it } from "vitest";
import { ev, sample } from "./helpers";
import { altAgree } from "../../src/altAgree";

describe("altAgree", () => {
  it("measures the GPS minus baro altitude over SN0614's flight", async () => {
    const { f, a } = await sample("SN0614");
    const r = altAgree(f.lr!.t, a.altSmooth, a.gps!.altOnLR, ev(a, "liftoff")!, ev(a, "apogee")!, ev(a, "landing")!)!;
    expect(r).not.toBeNull();
    // the GPS read 151 ft higher at apogee; over the flight the offset should be of that order
    expect(Math.abs(r.median)).toBeLessThan(400);
    expect(r.diff.length).toBeGreaterThan(100);
  });
  it("sees a constant offset exactly", () => {
    const t = Array.from({ length: 100 }, (_, i) => i * 0.5), baro = t.map((x) => 100 * x), gps = baro.map((v) => v + 40);
    const r = altAgree(t, baro, gps, 0, 25, 49.5)!;
    expect(r.median).toBe(40);
    expect(r.ascent).toBe(40);
    expect(r.descent).toBe(40);
  });
});
