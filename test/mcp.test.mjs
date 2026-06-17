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
      "requests",
      "click",
      "fill",
      "submit",
      "extract",
      "hydration_state",
      "query",
      "get_by",
      "click_selector",
      "fill_selector",
      "select_option",
      "check",
      "uncheck",
      "get_attribute",
      "text_content",
      "inner_html",
      "input_value",
      "is_visible",
      "is_checked",
      "is_enabled",
      "count",
      "evaluate",
      "set_user_agent",
      "go_back",
      "go_forward",
      "reload",
    ]) {
      assert.ok(map.has(name), `missing tool ${name}`);
    }
  });

  it("evaluate + accessor tools work over MCP", async () => {
    const { call } = tools();
    await call("goto", { url: HOME });
    assert.equal(
      await call("evaluate", { expression: "document.querySelectorAll('a').length" }),
      1,
    );
    assert.equal(await call("text_content", { selector: "h1" }), "Shop");
    assert.equal(await call("count", { selector: "a" }), 1);
    assert.equal(await call("is_visible", { selector: "h1" }), true);
  });

  it("get_by + click_selector + get_attribute work over MCP", async () => {
    const { call } = tools();
    await call("goto", { url: HOME });
    const byText = await call("get_by", { kind: "text", value: "Widget" });
    assert.ok(byText.some((m) => m.text === "Widget" && m.html.includes("/p/1")));
    assert.equal(await call("get_attribute", { selector: "a", name: "href" }), "/p/1");
    const after = await call("click_selector", { selector: "a" });
    assert.equal(after.url, PRODUCT);
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
