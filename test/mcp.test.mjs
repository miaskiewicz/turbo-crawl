import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTools } from "../mcp/handlers.mjs";
import { createServer } from "../mcp/server.mjs";
import { Page } from "../src/page.mjs";
import { stubFetch } from "./helpers.mjs";

const HOME = "https://shop.test/";
const PRODUCT = "https://shop.test/p/1";
const FORM = "https://shop.test/signup";
const SPA = "https://shop.test/app";

function tools() {
  const page = new Page({
    fetchHtml: stubFetch({
      [HOME]: `<title>Home</title><body><main><h1>Shop</h1><a href="/p/1">Widget</a></main></body>`,
      [PRODUCT]: `<title>Widget — $9</title><body><main><h1>Widget</h1><span class="price">$9</span></main></body>`,
      [FORM]: `<title>Sign up</title><body><form action="/signup" method="post"><input name="email"><button type="submit">Go</button></form></body>`,
      [SPA]: `<title>App</title><body><div id="root"></div><script>window.__APP="live";document.getElementById("root").textContent="Hydrated"</script></body>`,
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
      "batch",
      "crawl",
      "render",
      "set_mode",
      "detect_js",
      "robots_check",
      "get_cookies",
      "set_cookie",
      "set_extra_headers",
      "snapshot",
      "forms",
      "find_text",
      "fetch_json",
      "fetch_raw",
      "fill_many",
      "extract_links",
      "eval_js",
      "inject_js",
      "latest_dom",
      "dom_history",
    ]) {
      assert.ok(map.has(name), `missing tool ${name}`);
    }
  });

  it("eval_js runs a statement body; inject_js mutates the DOM", async () => {
    const { call } = tools();
    await call("goto", { url: HOME });
    assert.equal(
      await call("eval_js", {
        code: "return document.querySelectorAll('a').length + arguments[0]",
        args: [10],
      }),
      11,
    );
    await call("inject_js", { code: "document.querySelector('h1').textContent = 'Mutated'" });
    assert.equal(await call("text_content", { selector: "h1" }), "Mutated");
    assert.match(await call("html"), /<script>/);
  });

  it("render mode: eval_js reaches the live heap; latest_dom / dom_history", async () => {
    const { call } = tools();
    const nav = await call("render", { mode: "fast", url: SPA });
    assert.equal(nav.title, "App");
    // window global set by the page script — present only in the live render heap
    assert.equal(await call("eval_js", { code: "return window.__APP" }), "live");
    assert.match(await call("latest_dom"), /Hydrated/);
    assert.ok((await call("dom_history")).length >= 1);
    await call("eval_js", { code: "document.body.appendChild(document.createElement('hr'))" });
    assert.ok((await call("dom_history")).length >= 2);
  });

  it("offline tools: detect_js, cookies, snapshot, forms, find_text, fill_many, extract_links, set_mode", async () => {
    const { call } = tools();
    await call("goto", { url: HOME });

    assert.equal(typeof (await call("detect_js")).jsRequired, "boolean");

    await call("set_cookie", { name: "sid", value: "x", domain: "shop.test" });
    assert.equal((await call("get_cookies"))[0].name, "sid");
    assert.deepEqual(await call("set_extra_headers", { headers: { "x-a": "1" } }), { ok: true });
    assert.deepEqual(await call("set_mode", { mode: "no-js" }), { mode: "no-js" });

    const snap = await call("snapshot");
    assert.equal(snap.title, "Home");
    assert.ok(snap.headings.some((h) => h.text === "Shop"));
    assert.ok(snap.links.includes("https://shop.test/p/1"));

    assert.deepEqual(await call("extract_links", { sameHost: true }), ["https://shop.test/p/1"]);
    const found = await call("find_text", { text: "Widget" });
    assert.ok(found.length >= 1);
  });

  it("forms enumerates fields; fill_many sets them", async () => {
    const { call } = tools();
    await call("goto", { url: FORM });
    const [form] = await call("forms");
    assert.equal(form.method, "POST");
    assert.ok(form.fields.some((f) => f.name === "email"));
    assert.deepEqual(
      await call("fill_many", { fields: [{ selector: "[name=email]", value: "a@b.c" }] }),
      {
        ok: true,
        filled: 1,
      },
    );
    assert.equal(await call("input_value", { selector: "[name=email]" }), "a@b.c");
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

  it("interactive_elements forwards fast → visibility:false", () => {
    let seen;
    const page = {
      interactiveElements: (o) => {
        seen = o;
        return [];
      },
    };
    const map = new Map(buildTools(page).map((t) => [t.name, t]));
    map.get("interactive_elements").handler({ fast: true });
    assert.deepEqual(seen, { visibility: false });
    map.get("interactive_elements").handler({});
    assert.deepEqual(seen, { visibility: true });
  });
});

describe("createServer wiring", () => {
  it("defaults a Page with an HTTP/2 dispatcher + a 304 cache", async () => {
    const { server, page, dispatcher, cache } = createServer();
    assert.ok(server && page);
    assert.equal(typeof dispatcher.close, "function"); // undici Agent
    assert.equal(typeof cache.validators, "function"); // ResponseCache
    await dispatcher.close();
  });

  it("honors a caller-supplied Page and adds no dispatcher/cache", () => {
    const page = new Page();
    const r = createServer({ page });
    assert.equal(r.page, page);
    assert.equal(r.dispatcher, undefined);
    assert.equal(r.cache, undefined);
  });
});
