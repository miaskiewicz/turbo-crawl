// A vanilla Playwright spec — imports straight from "@playwright/test". Run with
//   node --import ./playwright-shim/register.mjs --test playwright-shim/dropin.spec.mjs
// the register redirects it to the napi-backed turbo-crawl engine (no browser),
// with NO edits to this spec.
import { expect, test } from "@playwright/test";

test("locators + expect on the native engine", async ({ page }) => {
  await page.setContent(
    "<main><h1>Widget</h1><button>Add</button><button>Remove</button></main>" +
      "<label for='q'>Search</label><input id='q'>",
  );
  await expect(page.locator("h1")).toHaveText("Widget");
  await expect(page.locator("button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add" })).toHaveCount(1);
  await page.getByLabel("Search").fill("rust");
  await expect(page.getByLabel("Search")).toHaveValue("rust");
});
