import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import {
  extractScripts,
  extractScriptsFromHtml,
  readImportMapFromHtml,
} from "../src/render/scripts.mjs";

const BASE = "https://s/";

describe("extractScriptsFromHtml (no-parse string scan)", () => {
  it("handles double / single / unquoted attrs, inline code, modules; skips json", () => {
    const html = `
      <script src="/a.js"></script>
      <script src='/b.js'></script>
      <script type=module src=/c.js></script>
      <script>var x = 1;</script>
      <script type="application/json">{"k":1}</script>`;
    const items = extractScriptsFromHtml(html, BASE);
    assert.deepEqual(
      items.map((i) => i.url ?? i.code.trim()),
      ["https://s/a.js", "https://s/b.js", "https://s/c.js", "var x = 1;"],
    );
    assert.equal(items[2].module, true); // type=module flagged
    assert.equal(items[3].module, false);
  });

  it("matches the DOM-based extractScripts on the same input", () => {
    const html = `<script src="/a.js"></script><script>go()</script>`;
    const viaString = extractScriptsFromHtml(html, BASE);
    const viaDom = extractScripts(createEnvironment(html).document, BASE);
    assert.deepEqual(viaString, viaDom);
  });

  it("preserves rawSrc (the authored attribute) alongside the resolved url", () => {
    // Bundler runtimes read getAttribute('src') = the raw attribute; the resolved
    // absolute url is for fetching only. Both must be carried, distinctly.
    const [item] = extractScriptsFromHtml(`<script src="/_next/c.js"></script>`, BASE);
    assert.equal(item.rawSrc, "/_next/c.js"); // authored, root-relative
    assert.equal(item.url, "https://s/_next/c.js"); // resolved for fetch
    const [viaDom] = extractScripts(
      createEnvironment(`<script src="/_next/c.js"></script>`).document,
      BASE,
    );
    assert.equal(viaDom.rawSrc, "/_next/c.js");
  });
});

describe("readImportMapFromHtml", () => {
  it("parses a valid import map", () => {
    const html = `<script type="importmap">{"imports":{"x":"/x.js"}}</script>`;
    assert.deepEqual(readImportMapFromHtml(html), { imports: { x: "/x.js" } });
  });
  it("returns {} for malformed JSON", () => {
    assert.deepEqual(readImportMapFromHtml(`<script type="importmap">{ bad</script>`), {});
  });
  it("returns {} when absent", () => {
    assert.deepEqual(readImportMapFromHtml(`<body><script>x()</script></body>`), {});
  });
});
