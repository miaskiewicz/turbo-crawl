import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { markdown } from "../src/markdown.mjs";

describe("markdown coverage", () => {
  it("serializes an inline <br> as a newline inside a paragraph", () => {
    const { document } = createEnvironment(`<body><main><p>line one<br>line two</p></main></body>`);
    const out = markdown(document);
    assert.match(out, /line one\nline two/);
  });

  it("recurses into a nested container wrapping block content", () => {
    const { document } = createEnvironment(
      `<body><main><div><p>Wrapped paragraph.</p><h2>Heading</h2></div></main></body>`,
    );
    const out = markdown(document);
    assert.match(out, /Wrapped paragraph\./);
    assert.match(out, /## Heading/);
  });

  it("an empty list pushes nothing", () => {
    const { document } = createEnvironment(`<body><main><ul></ul><p>after</p></main></body>`);
    const out = markdown(document);
    assert.equal(out, "after");
  });

  it("a list item nested under another element is not a direct child and is skipped", () => {
    const { document } = createEnvironment(
      `<body><main><ul><li>direct</li><div><li>nested</li></div></ul></main></body>`,
    );
    const out = markdown(document);
    assert.match(out, /- direct/);
    assert.ok(!out.includes("nested"));
  });

  it("emits an ordered list with incrementing numbers", () => {
    const { document } = createEnvironment(
      `<body><main><ol><li>a</li><li>b</li></ol></main></body>`,
    );
    const out = markdown(document);
    assert.match(out, /1\. a/);
    assert.match(out, /2\. b/);
  });

  it("renders a <blockquote> with a > prefix", () => {
    const { document } = createEnvironment(
      `<body><main><blockquote>quoted text</blockquote></main></body>`,
    );
    const out = markdown(document);
    assert.match(out, /> quoted text/);
  });

  it("renders an <hr> as ---", () => {
    const { document } = createEnvironment(`<body><main><p>x</p><hr><p>y</p></main></body>`);
    const out = markdown(document);
    assert.match(out, /---/);
  });

  it("passthrough handles an inline span with no dedicated serializer", () => {
    const { document } = createEnvironment(
      `<body><main><p>plain <span>spanned</span> text</p></main></body>`,
    );
    const out = markdown(document);
    assert.match(out, /plain spanned text/);
  });
});
