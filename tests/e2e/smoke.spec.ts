import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // map tiles come from other sites; keep the test offline from them
  await page.route(/arcgisonline|amazonaws/, (r) => r.abort());
  await page.addInitScript(() => localStorage.setItem("dc.toured", "1"));
});

test("sample flight loads with every panel and no page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.click('[data-sample="SN0614"]');
  await expect(page.locator("#cmp-panel")).toBeVisible({ timeout: 60_000 });
  for (const id of ["#find-panel", "#veh-panel", "#rec-panel", "#desc-panel", "#coast-panel", "#motor-panel", "#gps-panel", "#marks-panel", "#settings-panel"])
    await expect(page.locator(id)).toBeVisible();
  await expect(page.locator("#findings li")).toHaveCount(13);
  await expect(page.locator(".chart")).toHaveCount(9);
  await expect(page.locator("#view3d canvas")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("compare with a second flight and line it up at apogee", async ({ page }) => {
  await page.goto("/");
  await page.click('[data-sample="SN0614"]');
  await expect(page.locator("#cmp-panel")).toBeVisible({ timeout: 60_000 });
  await page.click("#cmp-sample");
  await expect(page.locator("#cmp-summary > p")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator("#cmp-summary > p").first()).toContainText("this flight");
  await page.click('[data-align="apogee"]');
  await expect(page.locator("[data-off]").first()).toHaveValue("1.54");
});

test("pre-flight settings check from the XLSX alone", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#file-input", "public/samples/SN1742/deploy_settings.xlsx");
  await expect(page.locator("#pre-dialog")).toBeVisible();
  await expect(page.locator("#pre-sub")).toContainText("4 warnings and 2 notes");
});

test("GPS log on its own opens the GPS-only summary", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#file-input", ["public/samples/SN0614/gps.csv", "public/samples/SN0614/gps_summary.csv"]);
  await expect(page.locator("#gpsonly-dialog")).toBeVisible();
  await expect(page.locator("#gpsonly-body")).toContainText("4167 ft");
});
