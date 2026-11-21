import { describe, expect, it } from "vitest";
import { sample } from "./helpers";
import { settingsDiff } from "../../src/settingsDiff";

describe("settingsDiff", () => {
  it("finds nothing when both units carry the same workbook", async () => {
    const x = await sample("SN0614");
    expect(settingsDiff(x.f.settings!, x.f.settings!)).toEqual([]);
  });
  it("lists the channel-by-channel differences between two workbooks", async () => {
    const x = await sample("SN0614"), y = await sample("SN1742");
    const d = settingsDiff(x.f.settings!, y.f.settings!);
    expect(d.length).toBeGreaterThan(0);
    for (const r of d) expect(r.a).not.toEqual(r.b);
  });
});
