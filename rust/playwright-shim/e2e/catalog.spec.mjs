// Catalog browsing exercising the locator + expect surface a real suite leans on:
// getByTestId, getByRole, nth/filter, counts, attribute/text matchers.
import { expect, test } from "@playwright/test";
import { startServer } from "./server.mjs";

let app;
test.beforeAll(async () => {
  app = await startServer();
});
test.afterAll(async () => {
  await app.close();
});

test("product list shows every product", async ({ page }) => {
  await page.goto(`${app.base}/products`);
  await expect(page.getByTestId("product-list")).toBeVisible();
  await expect(page.locator("[data-testid^='product-'] a")).toHaveCount(3);
  await expect(page.getByTestId("product-1")).toContainText("Widget");
  await expect(page.locator(".price").first()).toHaveText("$9.99");
});

test("filtering + nth narrow the list", async ({ page }) => {
  await page.goto(`${app.base}/products`);
  const items = page.locator("li[data-testid^='product-']");
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: "Gadget" })).toHaveCount(1);
  await expect(items.nth(2)).toContainText("Gizmo");
});

test("drilling into a product detail page", async ({ page }) => {
  await page.goto(`${app.base}/products`);
  await page.getByTestId("product-2").locator("a").click();
  await expect(page).toHaveURL(/\/products\/2$/);
  await expect(page.getByTestId("product-name")).toHaveText("Gadget");
  await expect(page.getByTestId("product-price")).toHaveText("$19.99");
  await expect(page.getByRole("button", { name: "Add to cart" })).toBeVisible();
});

test("links expose their href via getAttribute", async ({ page }) => {
  await page.goto(`${app.base}/products`);
  const href = await page.getByTestId("product-3").locator("a").getAttribute("href");
  expect(href).toBe("/products/3");
});
