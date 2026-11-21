import { describe, expect, it } from "vitest";
import { sample } from "./helpers";
import { redundancy, sameFlight } from "../../src/redundancy";

describe("redundancy", () => {
  it("treats a flight compared with itself as the same flight with zero offsets", async () => {
    const x = await sample("SN0614"), y = await sample("SN0614");
    expect(sameFlight(x.f, x.a, y.f, y.a)).toBe(true);
    const r = redundancy(x.f, x.a, y.f, y.a);
    expect(r.baroOffset).toBeCloseTo(0, 5);
    expect(r.rows.filter((row) => row.flag)).toHaveLength(0);
  });
  it("sees a steady baro offset", async () => {
    const x = await sample("SN0614"), y = await sample("SN0614");
    for (let i = 0; i < y.a.altSmooth.length; i++) y.a.altSmooth[i] += 25;
    expect(redundancy(x.f, x.a, y.f, y.a).baroOffset).toBeCloseTo(25, 0);
  });
  it("does not pair two different flights", async () => {
    const x = await sample("SN0614"), y = await sample("SN1742");
    expect(sameFlight(x.f, x.a, y.f, y.a)).toBe(false);
  });
});
