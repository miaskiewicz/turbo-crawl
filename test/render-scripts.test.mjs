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
