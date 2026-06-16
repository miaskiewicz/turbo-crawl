import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalize, isHttpUrl, resolve } from "../src/url.mjs";

describe("url coverage", () => {
  it("resolve returns null for empty/non-string href", () => {
    assert.equal(resolve("https://a.test/", ""), null);
    assert.equal(resolve("https://a.test/", undefined), null);
  });

  it("resolve returns null for an unresolvable href", () => {
    // No base + relative href → URL constructor throws → null (lines 13-14).
    assert.equal(resolve(undefined, "/relative"), null);
  });

  it("canonicalize returns null for an invalid URL", () => {
    assert.equal(canonicalize("not a url"), null);
  });

  it("isHttpUrl returns false for non-string and invalid URL", () => {
    assert.equal(isHttpUrl(42), false);
    assert.equal(isHttpUrl("::::"), false);
  });
});
