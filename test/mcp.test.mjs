import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTools } from "../mcp/handlers.mjs";
import { Page } from "../src/page.mjs";
import { stubFetch } from "./helpers.mjs";

const HOME = "https://shop.test/";
const PRODUCT = "https://shop.test/p/1";

function tools() {
  const page = new Page({
    fetchHtml: stubFetch({
      [HOME]: `<title>Home</title><body><main><h1>Shop</h1><a href="/p/1">Widget</a></main></body>`,
      [PRODUCT]: `<title>Widget — $9</title><body><main><h1>Widget</h1><span class="price">$9</span></main></body>`,
    }),
  });
  const map = new Map(buildTools(page).map((t) => [t.name, t]));
  return { map, call: (name, args) => map.get(name).handler(args ?? {}) };
}

describe("MCP handlers (Page API 1:1)", () => {
  it("exposes the full §10 tool set", () => {
    const { map } = tools();
    for (const name of [
      "goto",
      "interactive_elements",
      "accessibility_tree",
      "markdown",
      "html",
      "text",
      "links",
      "click",
      "fill",
      "submit",
      "extract",
    ]) {
      assert.ok(map.has(name), `missing tool ${name}`);
    }
  });

  it("drives goto → links → click → extract end to end", async () => {
    const { call } = tools();
    const nav = await call("goto", { url: HOME });
    assert.equal(nav.title, "Home");

    const els = await call("interactive_elements");
    const widget = els.find((e) => e.name === "Widget");
    const after = await call("click", { i: widget.i });
    assert.equal(after.url, PRODUCT);

    const out = await call("extract", { schema: { price: { selector: ".price" } } });
    assert.equal(out.price, "$9");
  });

  it("markdown and accessibility_tree return content", async () => {
    const { call } = tools();
    await call("goto", { url: HOME });
    assert.match(await call("markdown"), /# Shop/);
    assert.equal((await call("accessibility_tree")).role !== undefined, true);
  });
});
