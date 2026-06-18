// A vanilla Playwright spec — imports straight from "@playwright/test", no edits.
// Run via the register redirect so it executes on the no-browser Rust engine:
//   node --import ../register.mjs --test navigation.spec.mjs
import { expect, test } from "@playwright/test";
import { startServer } from "./server.mjs";

let app;
test.beforeAll(async () => {
  app = await startServer();
});
test.afterAll(async () => {
  await app.close();
});

test("home page renders server-side", async ({ page }) => {
  const res = await page.goto(`${app.base}/`);
  expect(res.status()).toBeLessThan(400);
  await expect(page).toHaveTitle("Home");
  await expect(page.locator("h1")).toHaveText("Welcome");
  await expect(page.locator(".tagline")).toContainText("catalog");
});

test("nav links carry the user across pages", async ({ page }) => {
  await page.goto(`${app.base}/`);
  await page.getByTestId("nav-products").click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.locator("h1")).toHaveText("Products");
});

test("back / forward history", async ({ page }) => {
  await page.goto(`${app.base}/`);
  await page.goto(`${app.base}/products`);
  await expect(page.locator("h1")).toHaveText("Products");
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("Welcome");
  await page.goForward();
  await expect(page.locator("h1")).toHaveText("Products");
});

test("404 surfaces a non-2xx status", async ({ page }) => {
  const res = await page.goto(`${app.base}/nope`);
  expect(res.status()).toBe(404);
});
