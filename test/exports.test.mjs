import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import { stubFetch } from "./helpers.mjs";

// The `@playwright/test` runner resolves test files with CJS `require`. A drop-in
// suite statically imports `expect` (the engine — chromium/page — is loaded via a
// dynamic import() in the page fixture, which already works). turbo-dom's parser
// uses top-level await, so the *engine* graph can never be require()d — but the
// façade `expect` graph is TLA-free, so it ships at a dedicated requirable subpath
// `@miaskiewicz/turbo-crawl/playwright/expect` (STATUS Gap 3).
const require = createRequire(import.meta.url);

describe("package exports — CJS require of the façade expect (Gap 3)", () => {
  it("./playwright/expect is require-able and exposes expect", () => {
    const { expect } = require("@miaskiewicz/turbo-crawl/playwright/expect");
    assert.equal(typeof expect, "function");
    assert.equal(typeof expect.poll, "function");
  });
  it("the engine subpath stays import-only (turbo-dom TLA can't be require()d)", () => {
    // import-only export → not resolvable in a require context, and even if it
    // were, turbo-dom's top-level-await parser makes the engine graph un-require()able.
    assert.throws(() => require("@miaskiewicz/turbo-crawl/playwright"), /exports|ASYNC_MODULE/);
  });
});

describe("façade expect accepts a turbo Locator (Gap 2)", () => {
  it("evaluates the assertion instead of brand-rejecting it", async () => {
    const { expect } = require("@miaskiewicz/turbo-crawl/playwright/expect");
    const { chromium } = await import("../playwright/index.mjs");
    const b = await chromium.launch({
      fetchHtml: stubFetch({ "http://x/": "<body><button>Go</button></body>" }),
    });
    const p = await b.newPage();
    await p.goto("http://x/", { waitUntil: "load" });
    // Real @playwright/test's expect throws "can be only used with Locator object"
    // here; the façade expect accepts turbo's Locator and runs the matcher.
    await expect(p.getByRole("button", { name: "Go" })).toBeVisible();
  });
});
