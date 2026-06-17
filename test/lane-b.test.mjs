// JS-required detection + generic Crawler fallback routing. No Chromium/Playwright
// adapter — the fallback is just another fetchHtml (the future no-browser JS tier
// plugs in here; see docs/js-execution-tier.md).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { Crawler } from "../src/crawl.mjs";
import { detectJsRequired } from "../src/detect.mjs";
import { stubFetch } from "./helpers.mjs";

const SHELL = `<!doctype html><html><head>
  <script src="/app.js"></script></head><body><div id="root"></div></body></html>`;
const RENDERED = `<!doctype html><title>App</title><body><main><h1>Rendered Content Here And More</h1>
  <a href="/page2">Next</a></main></body>`;
const SSR = `<!doctype html><body><main><h1>Plenty of server-rendered prose that exceeds the threshold so the
  detector is confident this page needs no browser at all to be useful to an agent.</h1></main></body>`;

describe("detectJsRequired", () => {
  it("flags an empty SPA shell", () => {
    const { document } = createEnvironment(SHELL);
    const d = detectJsRequired(document);
    assert.equal(d.jsRequired, true);
    assert.match(d.reason, /SPA mount|near-empty/);
  });
  it("passes a server-rendered page", () => {
    const { document } = createEnvironment(SSR);
    assert.equal(detectJsRequired(document).jsRequired, false);
  });
});

describe("Crawler fallback routing (generic fetcher, no browser)", () => {
  it("escalates a JS-required page to the configured fallback fetcher", async () => {
    const laneA = stubFetch({ "https://spa.test/": SHELL });
    const laneB = stubFetch({ "https://spa.test/": RENDERED });
    const recs = [];
    for await (const rec of new Crawler({
      start: "https://spa.test/",
      maxDepth: 0,
      concurrency: 1,
      fetchHtml: laneA,
      fallback: laneB,
      sleep: async () => {},
      now: () => 0,
    })) {
      recs.push(rec);
    }
    assert.equal(recs.length, 1);
    assert.equal(recs[0].lane, "B");
    assert.equal(recs[0].title, "App");
    assert.equal(laneB.calls.length, 1); // fallback actually used
  });
});
