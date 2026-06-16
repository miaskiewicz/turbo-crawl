import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Frontier } from "../src/frontier.mjs";

describe("Frontier", () => {
  it("dedupes on canonical form (fragment, utm, query order)", () => {
    const f = new Frontier();
    assert.equal(f.add("https://a.test/p?b=2&a=1"), true);
    assert.equal(f.add("https://a.test/p?a=1&b=2#frag"), false); // same canonical
    assert.equal(f.add("https://a.test/p?a=1&b=2&utm_source=x"), false); // utm stripped
    assert.equal(f.pending, 1);
  });

  it("FIFO order and drains to undefined", () => {
    const f = new Frontier();
    f.add("https://a.test/1");
    f.add("https://a.test/2");
    assert.equal(f.next().url, "https://a.test/1");
    assert.equal(f.next().url, "https://a.test/2");
    assert.equal(f.next(), undefined);
  });

  it("tracks depth", () => {
    const f = new Frontier();
    f.add("https://a.test/deep", 3);
    assert.equal(f.next().depth, 3);
  });
});
