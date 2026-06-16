import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Page } from "../src/page.mjs";
import { stubFetch } from "./helpers.mjs";

// Phase 1 acceptance (SPEC §12): drive a multi-page form flow with no JS —
// search box → results → follow a result link.
const HOME = "https://shop.test/";
const RESULTS = "https://shop.test/search?q=widget";
const PRODUCT = "https://shop.test/products/1";

const routes = {
  [HOME]: `<!doctype html><title>Home</title><body>
    <form action="/search" method="get"><input name="q" placeholder="Search"><button type="submit">Go</button></form>
  </body>`,
  "https://shop.test/search": `<!doctype html><title>Results</title><body><main>
    <a href="/products/1">Blue Widget</a></main></body>`,
  [PRODUCT]: `<!doctype html><title>Blue Widget — $9</title><body><main><h1>Blue Widget</h1></main></body>`,
};

describe("no-JS multi-page form flow", () => {
  it("search → results → follow link, via the link/form graph", async () => {
    const fetchHtml = stubFetch(routes);
    const page = new Page({ fetchHtml });

    await page.goto(HOME);
    const els = page.interactiveElements();
    const input = els.find((e) => e.tag === "input");
    page.fill(input.i, "widget");

    const results = await page.submit();
    assert.equal(results.title, "Results");
    assert.equal(fetchHtml.last()[0], RESULTS); // GET serialized the filled value

    const linkIdx = page.interactiveElements().find((e) => e.name === "Blue Widget").i;
    const product = await page.click(linkIdx);
    assert.equal(product.url, PRODUCT);
    assert.equal(product.title, "Blue Widget — $9");
  });

  it("click on an inert jsHandler element throws (honest, no silent no-op)", async () => {
    const page = new Page({
      fetchHtml: stubFetch({
        [HOME]: `<!doctype html><body><button onclick="x()">JS</button></body>`,
      }),
    });
    await page.goto(HOME);
    const idx = page.interactiveElements().find((e) => e.jsHandler).i;
    await assert.rejects(() => page.click(idx), /inert in Lane A/);
  });
});
