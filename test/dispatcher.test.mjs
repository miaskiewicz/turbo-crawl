import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cachedLookup, createDispatcher } from "../src/dispatcher.mjs";

// A fake dns.lookup: records calls, answers with a fixed address (or an error).
function fakeLookup({ fail = false } = {}) {
  const fn = (hostname, options, callback) => {
    fn.calls.push({ hostname, options });
    if (fail) return callback(new Error("ENOTFOUND"));
    callback(null, "1.2.3.4", 4);
  };
  fn.calls = [];
  return fn;
}

describe("cachedLookup", () => {
  it("resolves via base on a miss and replays the cached args on a hit", () => {
    const base = fakeLookup();
    let clock = 1000;
    const lookup = cachedLookup({ ttlMs: 500, now: () => clock, base });
    const seen = [];
    const cb = (...args) => seen.push(args);

    lookup("a.test", {}, cb);
    lookup("a.test", {}, cb); // within ttl → served from cache
    assert.equal(base.calls.length, 1);
    assert.deepEqual(seen, [
      [null, "1.2.3.4", 4],
      [null, "1.2.3.4", 4],
    ]);
  });

  it("re-resolves once the ttl expires", () => {
    const base = fakeLookup();
    let clock = 0;
    const lookup = cachedLookup({ ttlMs: 100, now: () => clock, base });
    lookup("a.test", {}, () => {});
    clock = 101;
    lookup("a.test", {}, () => {});
    assert.equal(base.calls.length, 2);
  });

  it("does not cache failures", () => {
    const base = fakeLookup({ fail: true });
    const lookup = cachedLookup({ now: () => 0, base });
    let err;
    lookup("a.test", {}, (e) => {
      err = e;
    });
    lookup("a.test", {}, () => {});
    assert.equal(err.message, "ENOTFOUND");
    assert.equal(base.calls.length, 2); // not served from cache
  });

  it("accepts the 2-arg form lookup(host, callback)", () => {
    const base = fakeLookup();
    const lookup = cachedLookup({ now: () => 0, base });
    let got;
    lookup("a.test", (e, addr) => {
      got = addr;
    });
    assert.equal(got, "1.2.3.4");
    assert.deepEqual(base.calls[0].options, {});
  });

  it("keys separately on family / all so answer shapes don't cross", () => {
    const base = fakeLookup();
    const lookup = cachedLookup({ now: () => 0, base });
    lookup("a.test", { family: 4 }, () => {});
    lookup("a.test", { family: 6 }, () => {});
    lookup("a.test", { all: true }, () => {});
    assert.equal(base.calls.length, 3);
  });
});

describe("createDispatcher", () => {
  it("returns an undici Agent (closeable)", async () => {
    const agent = createDispatcher({ allowH2: true, dnsTtlMs: 1000 });
    assert.equal(typeof agent.close, "function");
    await agent.close();
  });
});
