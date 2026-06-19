// React-SPA-style hydration through the shim, NO browser. The server ships an empty
// shell; the client bundle injects chunks at runtime and mounts the login form only
// after they load (correlated via document.currentScript). `page.hydrate()` runs that
// bundle to quiescence; the locator/expect surface then drives the mounted form.
import { expect, test } from "@playwright/test";
import { startSpaServer } from "./spa-server.mjs";

let app;
test.beforeAll(async () => {
  app = await startSpaServer();
});
test.afterAll(async () => {
  await app.close();
});

test("the server shell has no form before hydration", async ({ page }) => {
  // `waitUntil: 'commit'` opts out of auto-hydration → inspect the raw server shell.
  await page.goto(`${app.base}/`, { waitUntil: "commit" });
  expect(await page.getByTestId("login-email-input").count()).toBe(0);
  await expect(page.getByTestId("boot")).toContainText("Loading");
});

test("hydration pump mounts the SPA login form", async ({ page }) => {
  await page.goto(`${app.base}/`);
  await page.hydrate(); // run the page's own bundle: inject runtime → app chunk → mount
  await expect(page.getByTestId("login-form")).toBeVisible();
  await expect(page.getByTestId("login-email-input")).toBeVisible();
  await expect(page.getByTestId("login-submit")).toHaveText("Sign in");
});

test("the hydrated form is interactable through the shim", async ({ page }) => {
  await page.goto(`${app.base}/`);
  await page.hydrate();
  await page.getByTestId("login-email-input").fill("alice@example.com");
  await expect(page.getByTestId("login-email-input")).toHaveValue("alice@example.com");
});

test("dynamic chunks self-identify via document.currentScript", async ({ page }) => {
  // If currentScript were a single static element, the app chunk would register under
  // 'WRONG-CURRENTSCRIPT', __run('app') would never fire, and no form would mount.
  await page.goto(`${app.base}/`);
  await page.hydrate();
  await expect(page.getByTestId("login-email-input")).toHaveCount(1);
});
