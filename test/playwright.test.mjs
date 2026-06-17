import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chromium, expect, firefox, webkit } from "../playwright/index.mjs";
import { stubFetch } from "./helpers.mjs";

const HTML = `<body><main><h1>Shop</h1>
  <form action="/search" method="get"><label for="q">Search</label>
    <input id="q" name="q"><button type="submit">Go</button></form>
  <input type="checkbox" name="agree">
  <a href="/p/1">Blue Widget</a></main></body>`;

function browserOpts() {
  return {
    fetchHtml: stubFetch({
      "https://s/": HTML,
      "https://s/search": "<title>Results</title><body><a href='/p/1'>Blue Widget</a></body>",
      "https://s/p/1": "<title>P1</title><body>one</body>",
    }),
  };
}

describe("playwright compat façade", () => {
  it("chromium/firefox/webkit all launch the same engine", async () => {
    assert.equal(chromium, firefox);
    assert.equal(firefox, webkit);
    const b = await chromium.launch();
    assert.equal(typeof (await b.newPage()).goto, "function");
  });

  it("runs a Playwright-style script end to end", async () => {
    const browser = await chromium.launch(browserOpts());
    const page = await browser.newPage(browserOpts());

    const resp = await page.goto("https://s/");
    assert.equal(resp.status(), 200);
    assert.equal(resp.ok(), true);

    await page.fill("#q", "widgets");
    await expect(page.getByLabel("Search")).toHaveValue("widgets");

    await page.check("input[name=agree]");
    await expect(page.getByRole("checkbox")).toBeChecked();
    await expect(page.getByRole("button", { name: "Go" })).toBeVisible();

    await page.getByRole("button", { name: "Go" }).press();
    assert.equal(page.url(), "https://s/search?q=widgets");
    assert.equal(await page.title(), "Results");

    await expect(page.getByText("Blue Widget")).toHaveText("Blue Widget");
    await page.getByText("Blue Widget").click();
    assert.equal(await page.title(), "P1");
    await browser.close();
  });

  it("newContext().newPage() works", async () => {
    const browser = await chromium.launch();
    const ctx = await browser.newContext(browserOpts());
    const page = await ctx.newPage();
    assert.equal((await page.goto("https://s/")).ok(), true);
    await ctx.close();
  });

  it("selector shorthands + accessors", async () => {
    const page = await (await chromium.launch(browserOpts())).newPage(browserOpts());
    await page.goto("https://s/");
    assert.equal(await page.getAttribute("a", "href"), "/p/1");
    assert.equal(await page.textContent("h1"), "Shop");
    assert.equal(await page.isVisible("h1"), true);
    assert.equal(await page.innerHTML("h1"), "Shop");
  });

  it("expect.not and assertion failures throw", async () => {
    const page = await (await chromium.launch(browserOpts())).newPage(browserOpts());
    await page.goto("https://s/");
    await expect(page.getByText("absent-xyz")).not.toBeVisible();
    await assert.rejects(() => expect(page.locator("h1")).toHaveText("Wrong"), /toHaveText/);
  });

  it("waiting methods resolve immediately; waitForSelector finds present nodes", async () => {
    const page = await (await chromium.launch(browserOpts())).newPage(browserOpts());
    await page.goto("https://s/");
    await page.waitForLoadState();
    await page.waitForTimeout(1000);
    await page.waitForURL("**/s/");
    assert.ok(await page.waitForSelector("h1"));
    await assert.rejects(
      () => page.waitForSelector(".missing"),
      /needs JavaScript|waitForSelector/,
    );
  });

  it("evaluate / $eval run against the rendered DOM", async () => {
    const page = await (await chromium.launch(browserOpts())).newPage(browserOpts());
    await page.goto("https://s/");
    assert.equal(await page.evaluate(() => document.querySelectorAll("a").length), 1);
    assert.equal(await page.$eval("a", (el) => el.getAttribute("href")), "/p/1");
  });

  it("pixel/render-only APIs throw a clear, pointed error", async () => {
    const page = await (await chromium.launch(browserOpts())).newPage(browserOpts());
    await page.goto("https://s/");
    for (const fn of ["screenshot", "pdf", "route"]) {
      assert.throws(() => page[fn](), /no-JS engine|JavaScript/);
    }
    await assert.rejects(() => page.hover(), /no-JS engine|JavaScript/);
  });

  it("goBack/goForward/reload + content()", async () => {
    const page = await (await chromium.launch(browserOpts())).newPage(browserOpts());
    await page.goto("https://s/");
    await page.goto("https://s/p/1");
    assert.equal((await page.goBack()).url(), "https://s/");
    assert.equal((await page.goForward()).url(), "https://s/p/1");
    assert.equal(await page.goForward(), null);
    assert.match(await page.content(), /^<!DOCTYPE html>/);
    assert.equal((await page.reload()).ok(), true);
  });
});
