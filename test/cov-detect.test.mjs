import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { detectJsRequired } from "../src/detect.mjs";

describe("detectJsRequired coverage", () => {
  it("server-rendered page → jsRequired false, reason 'server-rendered content present'", () => {
    const body = `<p>${"word ".repeat(60)}</p>`;
    const { document } = createEnvironment(`<body>${body}<script src="/app.js"></script></body>`);
    const res = detectJsRequired(document);
    assert.equal(res.jsRequired, false);
    assert.equal(res.reason, "server-rendered content present");
    assert.ok(res.textLength >= 200);
    assert.equal(res.scripts, 1);
  });

  it("empty SPA mount + external script → 'empty SPA mount + external scripts'", () => {
    const { document } = createEnvironment(
      `<body><div id="root"></div><script src="/bundle.js"></script></body>`,
    );
    const res = detectJsRequired(document);
    assert.equal(res.jsRequired, true);
    assert.equal(res.reason, "empty SPA mount + external scripts");
  });

  it("near-empty body + external script, no mount → 'near-empty body + external scripts'", () => {
    const { document } = createEnvironment(
      `<body><span>hi</span><script src="/bundle.js"></script></body>`,
    );
    const res = detectJsRequired(document);
    assert.equal(res.jsRequired, true);
    assert.equal(res.reason, "near-empty body + external scripts");
  });

  it("empty SPA mount but no external script → not jsRequired (server-rendered reason path)", () => {
    // Long text so shellish is false; mount empty but no script → emptyMount&&scripts false.
    const filler = `<p>${"word ".repeat(60)}</p>`;
    const { document } = createEnvironment(`<body><div id="root"></div>${filler}</body>`);
    const res = detectJsRequired(document);
    assert.equal(res.jsRequired, false);
    assert.equal(res.reason, "server-rendered content present");
  });
});
