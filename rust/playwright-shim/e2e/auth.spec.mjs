// Auth flow as a drop-in Playwright spec: fill a real form, submit a POST, the
// session cookie persists across navigations, the gated page reflects it.
import { expect, test } from "@playwright/test";
import { startServer } from "./server.mjs";

let app;
test.beforeAll(async () => {
  app = await startServer();
});
test.afterAll(async () => {
  await app.close();
});

test("logging in sets a session and reveals the dashboard", async ({ page }) => {
  await page.goto(`${app.base}/login`);
  await page.getByTestId("email").fill("alice@example.com");
  await page.getByTestId("password").fill("secret");
  await expect(page.getByTestId("email")).toHaveValue("alice@example.com");
  await page.getByTestId("submit").click(); // POST /login → dashboard + Set-Cookie
  await expect(page.getByTestId("greeting")).toContainText("alice");
});

test("the session cookie persists to a gated route", async ({ page }) => {
  await page.goto(`${app.base}/login`);
  await page.getByTestId("email").fill("alice@example.com");
  await page.getByTestId("password").fill("secret");
  await page.getByTestId("submit").click();
  // a fresh navigation must carry the cookie set by the POST
  await page.goto(`${app.base}/dashboard`);
  await expect(page.getByTestId("greeting")).toContainText("alice");
  expect(page.context().storageState().cookies.length).toBeGreaterThan(0);
});

test("the dashboard is gated without a session", async ({ page }) => {
  await page.goto(`${app.base}/dashboard`);
  await expect(page.getByTestId("gate")).toContainText("Please log in");
});

test("bad credentials show an inline error", async ({ page }) => {
  await page.goto(`${app.base}/login`);
  await page.getByTestId("email").fill("alice@example.com");
  await page.getByTestId("password").fill("wrong");
  await page.getByTestId("submit").click();
  await expect(page.getByRole("alert")).toContainText("Invalid");
});
