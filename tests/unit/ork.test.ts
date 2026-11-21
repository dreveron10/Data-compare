import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { gFromMaterial, parseOrk } from "../../src/parsers/ork";

const xml = `<?xml version="1.0"?><openrocket><rocket><name>Test</name><subcomponents><stage><subcomponents>
<bodytube><outerradius>0.0762</outerradius><subcomponents>
<trapezoidfinset><rootchord>0.2032</rootchord><tipchord>0.0762</tipchord><height>0.127</height><thickness>0.00476</thickness><material type="bulk" density="1850">Fiberglass</material></trapezoidfinset>
</subcomponents></bodytube></subcomponents></stage></subcomponents></rocket>
<simulations><simulation><flightdata><databranch name="Sim" types="Time,Mass">
<event time="2.0" type="burnout"/>
<datapoint>0,18</datapoint><datapoint>1,17</datapoint><datapoint>2,15.5</datapoint><datapoint>3,15.5</datapoint>
</databranch></flightdata></simulation></simulations></openrocket>`;

describe("parseOrk", () => {
  it("reads diameter, fins and masses from a zipped .ork", () => {
    const zip = zipSync({ "rocket.ork": strToU8(xml) });
    const o = parseOrk(zip.buffer as ArrayBuffer);
    expect(o.diaIn).toBeCloseTo(6.0, 2);
    expect(o.fin?.rootIn).toBeCloseTo(8, 2);
    expect(o.fin?.thickIn).toBeCloseTo(0.1874, 3);
    expect(o.liftoffLb).toBeCloseTo(18 * 2.20462, 1);
    expect(o.burnoutLb).toBeCloseTo(15.5 * 2.20462, 1);
  });
  it("maps materials to shear modulus", () => {
    expect(gFromMaterial("Fiberglass")).toBe(425000);
    expect(gFromMaterial("Unobtanium")).toBeNull();
  });
});
