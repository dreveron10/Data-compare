import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";

test.beforeEach(async ({ page }) => {
  await page.route(/arcgisonline|amazonaws/, (r) => r.abort());
  await page.addInitScript(() => localStorage.setItem("dc.toured", "1"));
  page.on("dialog", (d) => d.accept());
});

/** serious and critical problems only; each listed with the first few elements it hit */
async function check(page: import("@playwright/test").Page, include?: string) {
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).exclude("#view3d canvas");
  if (include) b = b.include(include);
  const r = await b.analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  return bad.map((v) => `${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("flight page with comparisons has no serious accessibility problems", async ({ page }) => {
  await page.goto("/");
  await page.click('[data-sample="SN0614"]');
  await expect(page.locator("#cmp-panel")).toBeVisible({ timeout: 60_000 });
  await page.click("#cmp-sample");
  await expect(page.locator("#cmp-summary > p")).toHaveCount(1, { timeout: 60_000 });
  await page.setInputFiles("#cmp-input", ["HR", "LR", "summary"].map((n) => ({ name: `SN0614_${n}_unit2.csv`, mimeType: "text/csv", buffer: readFileSync(`public/samples/SN0614/${n}.csv`) })));
  await expect(page.locator(".redund")).toHaveCount(1, { timeout: 60_000 });
  expect(await check(page)).toEqual([]);
});

test("library dialog has no serious accessibility problems", async ({ page }) => {
  await page.goto("/");
  await page.click('[data-sample="SN0614"]');
  await expect(page.locator("#sl-panel")).toBeVisible({ timeout: 60_000 });
  await page.click("#save-open");
  await page.fill("#save-name", "A11y");
  await page.fill("#save-tags", "demo");
  await page.click("#save-confirm");
  await page.click("#lib-open");
  await expect(page.locator("#lib-list tr")).toHaveCount(2);
  expect(await check(page, "#lib-dialog")).toEqual([]);
});
