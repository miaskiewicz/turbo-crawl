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
  await expect(page.screenshot()).rejects.toThrow(/unavailable/);
  await expect(page.pdf()).rejects.toThrow(/unavailable/);
});
