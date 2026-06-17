import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installGlobals } from "@miaskiewicz/turbo-dom/install";

import { ariaSnapshot, matchesAriaSnapshot } from "../src/aria-snapshot.mjs";

function body(html) {
  const g = {};
  installGlobals(g, { html: `<body>${html}</body>`, url: "http://x/" });
  return g.document.querySelector("body");
}

describe("aria-snapshot — serialize", () => {
  it("emits indented role/name lines, eliding generic wrappers, skipping script/style", () => {
    const root = body(
      `<nav><a href="/">Home</a></nav><div><button>Go</button></div><script>1</script>`,
    );
    const text = ariaSnapshot(root);
    assert.match(text, /- navigation/);
    assert.match(text, /- link "Home"/);
    assert.match(text, /- button "Go"/);
    assert.doesNotMatch(text, /script/);
    // link is nested under navigation → deeper indent
    assert.match(text, /\n {2}- link "Home"/);
  });

  it("a roleless element with no children yields empty text", () => {
    assert.equal(ariaSnapshot(body("")), "");
  });
});

describe("aria-snapshot — match", () => {
  const root = () => body(`<h1>Title</h1><button>Save draft</button><a href="/x">More</a>`);

  it("matches an ordered subset by exact name, bare role, and regex", () => {
    assert.ok(matchesAriaSnapshot(root(), `- heading "Title"`));
    assert.ok(matchesAriaSnapshot(root(), `- button`)); // name omitted → any
    assert.ok(matchesAriaSnapshot(root(), `- button /save/i`));
    assert.ok(matchesAriaSnapshot(root(), `- heading "Title"\n- link "More"`));
  });

  it("rejects wrong name, wrong role, and out-of-order sequences", () => {
    assert.equal(matchesAriaSnapshot(root(), `- button "Nope"`), false);
    assert.equal(matchesAriaSnapshot(root(), `- textbox`), false);
    assert.equal(matchesAriaSnapshot(root(), `- link "More"\n- heading "Title"`), false);
  });

  it("ignores blank and unparseable lines in the template", () => {
    assert.ok(matchesAriaSnapshot(root(), `\n  \n- button "Save draft"\n: not a line\n`));
  });
});
