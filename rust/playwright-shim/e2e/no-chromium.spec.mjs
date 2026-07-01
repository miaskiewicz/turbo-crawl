// Guard: prove the suite runs on turbo-surf, NOT a real browser. The register
// redirect rewrites `@playwright/test` to the shim, so `chromium.launch()` yields
// the turbo-surf stub (version "turbo-surf"); a real Playwright build would
// report a Chromium version string and spawn a browser process. If this fails,
// the redirect isn't active and Chromium could launch.
import { chromium, expect, test } from "@playwright/test";

test("the engine is turbo-surf — no Chromium is launched", async () => {
  const browser = await chromium.launch();
  expect(browser.version()).toBe("turbo-surf");
  expect(chromium.name()).toBe("chromium"); // shaped like Playwright…
  expect(typeof chromium.executablePath).toBe("undefined"); // …but no browser binary
  await browser.close();
});

test("pixel/real-browser APIs reject honestly instead of silently passing", async ({ page }) => {
  await page.setContent("<button>x</button>");
  // page.screenshot is a real synthetic render now; pdf + element screenshot stay honest throws.
  await expect(page.pdf()).rejects.toThrow(/unavailable/);
  await expect(page.locator("button").screenshot()).rejects.toThrow(/unavailable/);
});

test("page.screenshot produces a synthetic PNG without a browser", async ({ page }) => {
  await page.setContent("<button>x</button>");
  const png = await page.screenshot();
  expect(Buffer.isBuffer(png) && png.length > 0).toBe(true);
  expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});
