import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Crawler, Page, version } from "../src/index.mjs";

describe("public API barrel", () => {
  it("exports a semver-shaped version string", () => {
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  it("exports Page and Crawler constructors", () => {
    assert.equal(typeof Page, "function");
    assert.equal(typeof Crawler, "function");
  });

  it("Crawler retains its options (merged over defaults)", () => {
    const crawler = new Crawler({ start: "https://example.com", maxPages: 10 });
    assert.equal(crawler.options.start, "https://example.com");
    assert.equal(crawler.options.maxPages, 10);
    assert.equal(typeof crawler.options.concurrency, "number"); // default filled in
  });

  it("Page queried before goto throws", () => {
    const page = new Page();
    assert.throws(() => page.interactiveElements(), /no page loaded/);
  });
});
