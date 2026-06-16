import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { interactiveElements, links } from "../src/extract.mjs";
import { fixture } from "./helpers.mjs";

const BASE = "https://shop.test/catalog/";
const env = createEnvironment(fixture("sample.html"));

describe("links()", () => {
  const got = links(env.document, BASE);

  it("resolves relative hrefs against the base URL", () => {
    assert.ok(got.includes("https://shop.test/"));
    assert.ok(got.includes("https://shop.test/about"));
    assert.ok(got.includes("https://shop.test/products/1"));
  });

  it("keeps absolute external links", () => {
    assert.ok(got.includes("https://example.org/external"));
  });

  it("drops non-http(s) links (mailto:)", () => {
    assert.ok(!got.some((u) => u.startsWith("mailto:")));
  });

  it("dedupes", () => {
    assert.equal(new Set(got).size, got.length);
  });
});

describe("interactiveElements()", () => {
  const els = interactiveElements(env.document, BASE, env.window);
  const byName = (n) => els.find((e) => e.name === n);

  it("assigns stable sequential indices", () => {
    els.forEach((e, idx) => assert.equal(e.i, idx));
  });

  it("resolves link hrefs to absolute URLs", () => {
    const blue = byName("Blue Widget");
    assert.equal(blue.tag, "a");
    assert.equal(blue.role, "link");
    assert.equal(blue.href, "https://shop.test/products/1");
  });

  it("captures input placeholder as the accessible name", () => {
    const q = byName("Search widgets");
    assert.equal(q.tag, "input");
    assert.equal(q.role, "textbox");
  });

  it("flags JS-only handlers as inert (jsHandler) with no href", () => {
    const js = byName("JS Only");
    assert.equal(js.jsHandler, true);
    assert.equal(js.href, undefined);
  });

  it("does NOT flag a submit button as jsHandler", () => {
    const go = byName("Go");
    assert.equal(go.type, "submit");
    assert.equal(go.jsHandler, false);
  });

  it("marks type=hidden inputs not visible", () => {
    const hidden = els.find((e) => e.tag === "input" && e.type === "hidden");
    assert.equal(hidden.visible, false);
  });

  it("visibility:false opt-out reports every element visible (no cascade pass)", () => {
    const fast = interactiveElements(env.document, BASE, env.window, { visibility: false });
    assert.equal(fast.length, els.length);
    assert.ok(fast.every((e) => e.visible === true));
    // a type=hidden input is not-visible with the cascade pass, but visible when opted out
    const hidden = fast.find((e) => e.tag === "input" && e.type === "hidden");
    assert.equal(hidden.visible, true);
  });
});
