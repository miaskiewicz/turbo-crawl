import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { playwrightFetcher } from "../adapters/playwright.mjs";
import { Crawler } from "../src/crawl.mjs";
import { detectJsRequired } from "../src/detect.mjs";
import { Page } from "../src/page.mjs";
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

// A fake Playwright BrowserType that "renders" by returning fixed HTML.
function fakeLauncher(renderedHtml) {
  const page = {
    goto: async () => ({ status: () => 200, headers: () => ({}) }),
    content: async () => renderedHtml,
    url: () => "https://spa.test/",
  };
  const context = { newPage: async () => page, close: async () => {} };
  const browser = { newContext: async () => context, close: async () => {} };
  return { launch: async () => browser };
}

describe("playwrightFetcher (Lane B as a renderer)", () => {
  it("returns rendered DOM that the core Page can extract from", async () => {
    const { fetchHtml, close } = playwrightFetcher({ launcher: fakeLauncher(RENDERED) });
    const page = new Page({ fetchHtml });
    const nav = await page.goto("https://spa.test/");
    assert.equal(nav.title, "App");
    assert.ok(page.links().includes("https://spa.test/page2"));
    await close();
  });
});

describe("Crawler Lane-B routing", () => {
  it("escalates a JS-required page to the fallback fetcher", async () => {
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
