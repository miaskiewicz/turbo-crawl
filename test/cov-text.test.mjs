import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { text } from "../src/text.mjs";

describe("text() coverage", () => {
  it("<br> flushes the current line", () => {
    const { document } = createEnvironment(`<body><p>a<br>b</p></body>`);
    assert.deepEqual(text(document).split("\n"), ["a", "b"]);
  });

  it("<hr> flushes the current line", () => {
    const { document } = createEnvironment(`<body>before<hr>after</body>`);
    assert.deepEqual(text(document).split("\n"), ["before", "after"]);
  });

  it("<pre> preserves its content verbatim on its own line", () => {
    const { document } = createEnvironment(`<body>lead<pre>  x\n  y  </pre></body>`);
    const out = text(document);
    assert.equal(out, "lead\n  x\n  y");
  });

  it("table cells (td/th) stay on their row's single line", () => {
    // The CELL branch appends a tab after each cell; flush() then collapses the
    // run of whitespace to a single space, so the row is space-joined.
    const { document } = createEnvironment(
      `<body><table><tr><td>a</td><th>b</th></tr></table></body>`,
    );
    const out = text(document);
    assert.equal(out, "a b");
    assert.ok(!out.includes("\n"));
  });

  it("SKIP tags (script/style) produce no text", () => {
    const { document } = createEnvironment(
      `<body><script>doThing()</script><style>.c{}</style><p>visible</p></body>`,
    );
    const out = text(document);
    assert.equal(out, "visible");
  });

  it("nested inline elements stay on a single line", () => {
    const { document } = createEnvironment(`<body><p>x <span>y <b>z</b></span> w</p></body>`);
    assert.equal(text(document), "x y z w");
  });

  it("non-element/non-text nodes (comments) are ignored", () => {
    const { document } = createEnvironment(`<body><!-- c --><p>kept</p></body>`);
    assert.equal(text(document), "kept");
  });

  it("operates on a passed element root without querySelector body lookup", () => {
    const { document } = createEnvironment(`<body><p>one</p><p>two</p></body>`);
    const p = document.querySelector("p");
    assert.equal(text(p), "one");
  });
});
