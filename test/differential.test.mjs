// Differential test (SPEC §14): compare turbo-crawl's no-JS extraction against a
// Playwright (Chromium) oracle on a fixture corpus, to bound representation drift.
// Auto-skips when `playwright` isn't installed (it's an optional peer dep), so the
// offline CI suite stays green; install it to exercise this.
//
// The fixture is served over a real loopback HTTP server so both engines resolve
// hrefs against the same real base URL (Playwright's setContent ignores baseURL).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { interactiveElements, links } from "../src/extract.mjs";

// Skip unless playwright AND its Chromium browser binary are both installed
// (the module can be present in CI via npm ci without `playwright install`).
let chromium = null;
try {
  ({ chromium } = await import("playwright"));
  if (!existsSync(chromium.executablePath())) chromium = null;
} catch {
  chromium = null;
}

const CORPUS = [
  `<!doctype html><body><main><h1>Shop</h1>
    <a href="/p/1">One</a><a href="/p/2">Two</a>
    <form action="/s"><input name="q" placeholder="Search"><button type="submit">Go</button></form>
   </main></body>`,
  `<!doctype html><body><nav><a href="/">Home</a></nav>
    <article><a href="https://ext.test/x">External</a>
    <button onclick="x()">JS</button></article></body>`,
];

// Serve `current.html` at any path on a loopback server; returns { base, close }.
async function serveCorpus(current) {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(current.html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) };
}

describe("differential vs Playwright oracle", { skip: !chromium }, () => {
  it("links() and interactiveElements() match the Chromium oracle", async () => {
    const current = { html: "" };
    const { base, close } = await serveCorpus(current);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      for (const html of CORPUS) {
        current.html = html;
        await page.goto(base, { waitUntil: "load" });

        const env = createEnvironment(html);
        const ours = links(env.document, base).sort();
        const els = interactiveElements(env.document, base, env.window);

        const truthLinks = await page.$$eval("a[href]", (as) => as.map((a) => a.href));
        const truthButtons = await page.$$eval("button", (bs) => bs.length);

        assert.deepEqual(ours, [...new Set(truthLinks)].sort(), "link set drift");
        assert.equal(els.filter((e) => e.tag === "button").length, truthButtons, "button drift");
      }
    } finally {
      await browser.close();
      await close();
    }
  });
});
