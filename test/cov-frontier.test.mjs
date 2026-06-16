import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Frontier } from "../src/frontier.mjs";

describe("frontier coverage", () => {
  it("requeue bypasses the visited gate and size tracks visited", () => {
    const f = new Frontier();
    f.add("https://a.test/1");
    assert.equal(f.size, 1);
    const item = f.next();
    // requeue pushes without touching #visited.
    f.requeue(item);
    assert.equal(f.pending, 1);
    assert.equal(f.next().url, "https://a.test/1");
  });

  it("seen reports enqueued canonical URLs and false for invalid", () => {
    const f = new Frontier();
    f.add("https://a.test/page?utm_source=x");
    // Canonical match despite tracking param + fragment.
    assert.equal(f.seen("https://a.test/page#frag"), true);
    assert.equal(f.seen("https://a.test/other"), false);
    // Invalid URL → canonicalize null → false.
    assert.equal(f.seen("not a url"), false);
  });

  it("compacts the queue head after draining many items", () => {
    const f = new Frontier();
    const total = 3000;
    for (let i = 0; i < total; i++) f.add(`https://a.test/${i}`);
    assert.equal(f.size, total);
    // Drain enough to trip the head-compaction branch (#head > 1024 && head*2 > len).
    for (let i = 0; i < 2000; i++) {
      const item = f.next();
      assert.equal(item.url, `https://a.test/${i}`);
    }
    // Remaining items still come out in order after compaction.
    assert.equal(f.next().url, "https://a.test/2000");
    assert.equal(f.pending, total - 2001);
  });
});
