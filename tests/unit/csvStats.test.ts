import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../../src/csv";
import { statChanges } from "../../src/libraryStats";

describe("csv", () => {
  it("rounds numbers, quotes awkward text and leaves gaps empty", () => {
    expect(csvCell(4015.7612)).toBe("4015.76");
    expect(csvCell(NaN)).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell("Apogee in the 4,000 band")).toBe('"Apogee in the 4,000 band"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(true)).toBe("yes");
    expect(toCsv([["a", 1], [null, "b,c"]])).toBe('a,1\n,"b,c"');
  });
});

describe("statChanges", () => {
  it("ignores tiny differences and reports real ones by name", () => {
    expect(statChanges({ apogee: 4016 }, { apogee: 4017 })).toEqual([]);
    expect(statChanges({ apogee: 4016 }, { apogee: 4100 })).toEqual(["apogee"]);
  });
  it("treats a missing number as changed and compares lists exactly", () => {
    expect(statChanges({}, { coastCd: 0.31 })).toEqual(["coast Cd"]);
    expect(statChanges({ slPass: 5, slOver: ["Booster"] }, { slPass: 5, slOver: ["Booster"] })).toEqual([]);
    expect(statChanges({ slPass: 5, slOver: ["Booster"] }, { slPass: 6, slOver: [] })).toEqual(["SL checks"]);
  });
  it("skips fields with no readable name", () => {
    expect(statChanges({ hasGps: false }, { hasGps: true })).toEqual([]);
  });
});
