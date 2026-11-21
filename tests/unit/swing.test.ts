import { describe, expect, it } from "vitest";
import { sample } from "./helpers";
import { descentPhases } from "../../src/descent";
import { canopySwing } from "../../src/swing";

describe("canopySwing", () => {
  it("reads hang angle, swing, period and spin under each chute (SN0614)", async () => {
    const { f, a } = await sample("SN0614");
    const sw = canopySwing(f, descentPhases(f, a, 40));
    const main = sw.find((s) => s.name === "Main")!;
    expect(main.frozen).toBe(false);
    expect(main.hangDeg).toBeGreaterThan(15);
    expect(main.hangDeg).toBeLessThan(35);
    expect(main.periodS).toBeGreaterThan(2);
    expect(main.periodS).toBeLessThan(4.5);
    expect(sw.find((s) => s.name === "Drogue")!.spinDps).toBeGreaterThan(180);
  });
  it("flags a phase with almost no motion logged (SN1742 drogue)", async () => {
    const { f, a } = await sample("SN1742");
    const sw = canopySwing(f, descentPhases(f, a, 40));
    expect(sw[0].frozen).toBe(true);
  });
});
