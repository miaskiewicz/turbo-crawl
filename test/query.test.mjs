import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { buildTools } from "../mcp/handlers.mjs";
import { Page } from "../src/page.mjs";
import { query } from "../src/query.mjs";
import { evaluateXPath } from "../src/xpath.mjs";
import { stubFetch } from "./helpers.mjs";

const HTML = `<body><div id="app"><ul class="list">
  <li class="item" data-id="1"><a href="/p/1">Widget</a></li>
  <li class="item" data-id="2"><a href="/p/2">Gadget</a></li>
</ul><p class="note">hello <b>world</b></p></div></body>`;
const doc = createEnvironment(HTML).document;

describe("query() — CSS", () => {
  it("returns {node, html, text} for each match", () => {
    const r = query(doc, ".item a");
    assert.equal(r.length, 2);
    assert.equal(r[0].text, "Widget");
    assert.equal(r[0].html, '<a href="/p/1">Widget</a>');
    assert.ok(r[0].node);
  });
  it("first:true returns a single match or null", () => {
    assert.equal(query(doc, ".item a", { first: true }).text, "Widget");
    assert.equal(query(doc, ".absent", { first: true }), null);
  });
  it("text() flattens nested inline markup", () => {
    assert.equal(query(doc, ".note", { first: true }).text, "hello world");
  });
});

describe("query() — XPath subset", () => {
  const xtext = (sel) => query(doc, sel).map((r) => r.value ?? r.text);

  it("descendant // and node test", () => {
    assert.deepEqual(xtext("//li").length, 2);
  });
  it("[@attr='v'] predicate + child step", () => {
    assert.deepEqual(xtext("//li[@data-id='2']/a"), ["Gadget"]);
  });
  it("[@attr] existence predicate", () => {
    assert.deepEqual(xtext("//a[@href]"), ["Widget", "Gadget"]);
  });
  it("contains(text(), ...) predicate", () => {
    assert.deepEqual(xtext("//p[contains(text(),'hello')]"), ["hello world"]);
  });
  it("positional [n] predicate", () => {
    assert.deepEqual(xtext("//li[1]/a"), ["Widget"]);
    assert.deepEqual(xtext("//li[2]/a"), ["Gadget"]);
  });
  it("trailing /@attr yields attribute values", () => {
    assert.deepEqual(xtext("//a/@href"), ["/p/1", "/p/2"]);
  });
  it("auto-detects XPath vs CSS by leading char", () => {
    assert.equal(query(doc, "//p", { first: true }).text, "hello world");
    assert.equal(query(doc, "p.note", { first: true }).text, "hello world");
  });
  it("evaluateXPath returns nodes or values directly", () => {
    assert.equal(evaluateXPath(doc, "//li").nodes.length, 2);
    assert.deepEqual(evaluateXPath(doc, "//a/@href").values, ["/p/1", "/p/2"]);
  });
});

describe("Page.query + MCP query tool", () => {
  it("Page.query delegates to the current document", async () => {
    const page = new Page({ fetchHtml: stubFetch({ "https://x/": HTML }) });
    await page.goto("https://x/");
    assert.deepEqual(
      page.query("//a/@href").map((r) => r.value),
      ["/p/1", "/p/2"],
    );
  });
  it("MCP query tool strips the live node from results", async () => {
    const page = new Page({ fetchHtml: stubFetch({ "https://x/": HTML }) });
    await page.goto("https://x/");
    const tool = buildTools(page).find((t) => t.name === "query");
    const out = tool.handler({ selector: ".item a" });
    assert.equal(out.length, 2);
    assert.ok(!("node" in out[0]));
    assert.equal(out[0].text, "Widget");
  });
});
