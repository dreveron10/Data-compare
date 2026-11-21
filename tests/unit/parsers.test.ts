import { describe, expect, it } from "vitest";
import { isGenericAlt, parseGenericAlt } from "../../src/parsers/genericAlt";
import { traceFromAltimeter } from "../../src/compare";

// a simple synthetic flight: climbs to about 2000 ft in 10 s, drogue at 90 ft/s down to 600 ft, then main at 20 ft/s
function flight(): { t: number; h: number }[] {
  const out: { t: number; h: number }[] = [];
  let h = 0;
  for (let t = -2; t < 120; t += 0.05) {
    if (t < 0) h = 0;
    else if (t < 10) h = 300 * t - 10 * t * t;
    else if (h > 600 && t > 12) h -= 90 * 0.05;
    else if (t > 12) h = Math.max(0, h - 20 * 0.05);
    out.push({ t, h });
  }
  return out;
}

describe("other altimeters", () => {
  const rows = flight();
  const cases: [string, string][] = [
    ["StratoLogger", "PerfectFlite StratoLoggerCF\nTime,Altitude,Velocity\n" + rows.map((r) => `${(r.t + 2).toFixed(2)},${r.h.toFixed(1)},0`).join("\n")],
    ["RRC3", "Missile Works RRC3\nTime (sec),Altitude (ft),Velocity (ft/sec)\n" + rows.map((r) => `${(r.t + 2).toFixed(2)},${r.h.toFixed(1)},0`).join("\n")],
    ["Altus Metrum", "version,serial,flight,time,state_name,height,speed\n" + rows.map((r) => `2,1,1,${r.t.toFixed(2)},boost,${(r.h * 0.3048).toFixed(2)},0`).join("\n")],
    ["Eggtimer", "Eggtimer Quantum\nT,Alt,Veloc\n" + rows.map((r) => `${Math.round((r.t + 2) * 1000)},${r.h.toFixed(0)},0`).join("\n")],
  ];
  for (const [brand, text] of cases) {
    it(brand, () => {
      expect(isGenericAlt(text)).toBe(true);
      const tr = traceFromAltimeter(parseGenericAlt(text, "x.csv"));
      expect(tr.name.startsWith(brand)).toBe(true);
      expect(tr.key.apogee!).toBeCloseTo(2000, -2);
      expect(Math.abs(tr.key.drogueRate!)).toBeCloseTo(90, -1);
      expect(Math.abs(tr.key.mainRate!)).toBeCloseTo(20, -1);
    });
  }
  it("rejects files with no altitude column", () => {
    expect(isGenericAlt("a,b,c\n1,2,3\n4,5,6\n7,8,9\n1,1,1\n")).toBe(false);
  });
});

import { diameterFor, diameterFromCdA } from "../../src/chute";
describe("chute sizing", () => {
  it("40 lb at 22 ft/s on a Cd 2.2 chute needs about 76 in", () => {
    expect(diameterFor(40, 22, 2.2)).toBeCloseTo(76, 0);
  });
  it("diameter from CdA round-trips", () => {
    const d = 60, cd = 1.5, cdA = cd * Math.PI * (d / 12) ** 2 / 4;
    expect(diameterFromCdA(cdA, cd)).toBeCloseTo(60, 6);
  });
});
