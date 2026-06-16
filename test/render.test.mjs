import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { accessibilityTree } from "../src/ax.mjs";
import { markdown } from "../src/markdown.mjs";

const BASE = "https://docs.test/";
const env = createEnvironment(`<!doctype html><body>
  <nav><a href="/skip">should be dropped</a></nav>
  <main>
    <h1>Widgets</h1>
    <p>A <strong>fast</strong> crawler with a <a href="/link">link</a>.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre>const x = 1;</pre>
  </main>
  <footer>footer boilerplate</footer>
</body>`);

describe("markdown()", () => {
  const md = markdown(env.document, BASE);

  it("emits headings", () => assert.match(md, /^# Widgets/m));
  it("renders inline emphasis and absolute links", () => {
    assert.match(md, /\*\*fast\*\*/);
    assert.match(md, /\[link\]\(https:\/\/docs\.test\/link\)/);
  });
  it("renders list items", () => {
    assert.match(md, /^- one$/m);
    assert.match(md, /^- two$/m);
  });
  it("renders fenced code", () => assert.match(md, /```\nconst x = 1;\n```/));
  it("drops nav and footer boilerplate", () => {
    assert.ok(!md.includes("should be dropped"));
    assert.ok(!md.includes("footer boilerplate"));
  });
});

describe("accessibilityTree()", () => {
  const tree = accessibilityTree(env.document);
  const flat = [];
  (function walk(n) {
    flat.push(n);
    for (const c of n.children ?? []) walk(c);
  })(tree);

  it("includes a heading node with its name", () => {
    assert.ok(flat.some((n) => n.role === "heading" && n.name === "Widgets"));
  });
  it("includes a link node", () => {
    assert.ok(flat.some((n) => n.role === "link" && n.name === "link"));
  });
  it("includes a list with listitems", () => {
    assert.ok(flat.some((n) => n.role === "list"));
    assert.equal(flat.filter((n) => n.role === "listitem").length, 2);
  });
  it("prunes aria-hidden subtrees", () => {
    const e2 = createEnvironment(`<body><main aria-hidden="true"><h1>hidden</h1></main></body>`);
    const t = accessibilityTree(e2.document);
    const names = [];
    (function w(n) {
      if (n.name) names.push(n.name);
      for (const c of n.children ?? []) w(c);
    })(t);
    assert.ok(!names.includes("hidden"));
  });
});
