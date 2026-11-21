import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";

test.beforeEach(async ({ page }) => {
  await page.route(/arcgisonline|amazonaws/, (r) => r.abort());
  await page.addInitScript(() => localStorage.setItem("dc.toured", "1"));
  page.on("dialog", (d) => d.accept());
});

async function openSample(page: Page, sn = "SN0614") {
  await page.goto("/");
  await page.click(`[data-sample="${sn}"]`);
  await expect(page.locator("#sl-panel")).toBeVisible({ timeout: 60_000 });
}
async function save(page: Page, name: string) {
  await page.click("#save-open");
  await expect(page.locator("#save-dialog")).toBeVisible();
  await page.fill("#save-name", name);
  await page.click("#save-confirm");
  await expect(page.locator("#save-dialog")).toBeHidden();
}
/** SN0614's own files under another name, as if a second unit had flown in the same rocket */
const secondUnit = () => ["HR", "LR", "summary"].map((n) => ({
  name: `SN0614_${n}_unit2.csv`, mimeType: "text/csv", buffer: readFileSync(`public/samples/SN0614/${n}.csv`),
}));

test("library: delete goes to the trash and restore brings it back", async ({ page }) => {
  await openSample(page);
  await save(page, "Trash test");
  await page.click("#lib-open");
  await expect(page.locator("#lib-list tr")).toHaveCount(2);
  await page.click('#lib-list button[data-act="del"]');
  await expect(page.locator("#lib-trash-sum")).toHaveText("Trash (1)");
  await expect(page.locator(".lib-empty")).toBeVisible();
  await page.click("#lib-trash-sum");
  await page.click('#lib-trash-list button[data-trash="restore"]');
  await expect(page.locator("#lib-trash")).toBeHidden();
  await expect(page.locator("#lib-list tr")).toHaveCount(2);
});

test("vehicle card fills from an OpenRocket .ork", async ({ page }) => {
  const xml = `<?xml version="1.0"?><openrocket><rocket><name>Test</name><subcomponents><stage><subcomponents>
<bodytube><outerradius>0.0762</outerradius><subcomponents><trapezoidfinset><rootchord>0.2032</rootchord><tipchord>0.0762</tipchord><height>0.127</height><thickness>0.00476</thickness><material type="bulk" density="1850">Fiberglass</material></trapezoidfinset></subcomponents></bodytube>
</subcomponents></stage></subcomponents></rocket><simulations><simulation><flightdata><databranch name="Sim" types="Time,Mass"><event time="2.0" type="burnout"/>
<datapoint>0,18</datapoint><datapoint>2,15.5</datapoint><datapoint>3,15.5</datapoint></databranch></flightdata></simulation></simulations></openrocket>`;
  await openSample(page);
  await page.setInputFiles("#veh-ork", { name: "test.ork", mimeType: "application/octet-stream", buffer: Buffer.from(zipSync({ "rocket.ork": strToU8(xml) })) });
  await expect(page.locator("#veh-dia")).toHaveValue("6.00");
  await expect(page.locator("#veh-burnout")).toHaveValue("34.17");
  await expect(page.locator("#fl-root")).toHaveValue(/^8/);
});

test("comparison CSV and the same-rocket toggle", async ({ page }) => {
  await openSample(page);
  await page.click("#cmp-sample");
  await expect(page.locator("#cmp-summary > p")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator(".redund")).toHaveCount(0);
  await page.setInputFiles("#cmp-input", secondUnit());
  await expect(page.locator(".redund")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator(".redund summary")).toContainText("the two altimeters agree");
  // mark SN1742 as the same rocket by hand, then take the copy off
  await page.locator("[data-same]").nth(0).check();
  await expect(page.locator(".redund")).toHaveCount(2);
  await page.locator("[data-same]").nth(1).uncheck();
  await expect(page.locator(".redund")).toHaveCount(1);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#cmp-csv")]);
  const csv = readFileSync((await dl.path())!, "utf8");
  expect(csv).toContain("Key numbers");
  expect(csv).toContain("Student Launch checks");
  expect(csv).toContain("Altimeter agreement with BlRv_SN1742");
});
