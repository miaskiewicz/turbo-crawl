import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { Page } from "../src/page.mjs";
import { text } from "../src/text.mjs";
import { stubFetch } from "./helpers.mjs";

describe("text() — structured plain text", () => {
  it("breaks lines at block boundaries, keeps inline on one line", () => {
    const { document } = createEnvironment(
      `<body><h1>Title</h1><p>A <b>bold</b> and <a href="/x">linked</a> sentence.</p><div>Second block</div></body>`,
    );
    const out = text(document);
    assert.deepEqual(out.split("\n"), ["Title", "A bold and linked sentence.", "Second block"]);
  });

  it("treats <br> as a line break and strips markup entirely", () => {
    const { document } = createEnvironment(`<body><p>line one<br>line two</p></body>`);
    assert.deepEqual(text(document).split("\n"), ["line one", "line two"]);
    assert.ok(!text(document).includes("<"));
  });

  it("gives each list item its own line", () => {
    const { document } = createEnvironment(`<body><ul><li>one</li><li>two</li></ul></body>`);
    assert.deepEqual(text(document).split("\n"), ["one", "two"]);
  });

  it("preserves <pre> content and drops script/style", () => {
    const { document } = createEnvironment(
      `<body><style>.x{}</style><pre>a\n  b</pre><script>z()</script></body>`,
    );
    const out = text(document);
    assert.match(out, /a\n {2}b/);
    assert.ok(!out.includes("z()"));
    assert.ok(!out.includes(".x"));
  });

  it("collapses runs of whitespace within a line", () => {
    const { document } = createEnvironment(`<body><p>spaced     out\n   text</p></body>`);
    assert.equal(text(document), "spaced out text");
  });
});

describe("Page.html() and Page.text()", () => {
  const HOME = "https://app.test/";
  function page() {
    return new Page({
      fetchHtml: stubFetch({
        [HOME]: `<!doctype html><html><head><title>App</title></head><body><main><h1>Hi</h1><p>Body text.</p></main></body></html>`,
      }),
    });
  }

  it("html() serializes the current DOM with a doctype", async () => {
    const p = page();
    await p.goto(HOME);
    const html = p.html();
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>App<\/title>/);
    assert.match(html, /<h1>Hi<\/h1>/);
  });

  it("text() returns markup-free structured text", async () => {
    const p = page();
    await p.goto(HOME);
    assert.deepEqual(p.text().split("\n"), ["Hi", "Body text."]);
  });
});
