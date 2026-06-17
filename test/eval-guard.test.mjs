import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertSafeEval } from "../src/eval-guard.mjs";
import { Page } from "../src/page.mjs";
import { stubFetch } from "./helpers.mjs";

describe("assertSafeEval (node:vm best-effort guard)", () => {
  it("passes ordinary DOM code unchanged", () => {
    const code = "return document.querySelectorAll('a').length";
    assert.equal(assertSafeEval(code), code);
  });

  it("blocks the obvious host-escape tokens", () => {
    for (const bad of [
      "return process.env",
      "require('fs')",
      "module.exports = 1",
      "return globalThis",
      "global.x = 1",
      "({}).constructor.constructor('return process')()",
      "return Function('return 1')()",
      "import('fs')",
      "obj.__proto__ = null",
      "Reflect.get(x, 'y')",
      "new Proxy({}, {})",
    ]) {
      assert.throws(() => assertSafeEval(bad), /eval blocked/, bad);
    }
  });

  it("Page.evalJs (node:vm path) enforces the guard; clean code still runs", async () => {
    const page = new Page({
      fetchHtml: stubFetch({ "https://s/": "<title>T</title><body><a>x</a></body>" }),
    });
    await page.goto("https://s/");
    assert.equal(page.evalJs("return document.title"), "T");
    assert.throws(() => page.evalJs("return process.pid"), /eval blocked|secure/);
    assert.throws(() => page.injectJs("require('fs')"), /eval blocked|secure/);
  });
});
