import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RobotsCache } from "../src/robots.mjs";

describe("RobotsCache coverage", () => {
  it("allows all when fetchText throws (lines 143-144)", async () => {
    const cache = new RobotsCache({
      fetchText: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(await cache.allowed("https://a.test/anything"), true);
  });

  it("allows all on a non-2xx robots response (isOk false branch)", async () => {
    const cache = new RobotsCache({
      fetchText: async () => ({ status: 404, text: "Disallow: /" }),
    });
    assert.equal(await cache.allowed("https://a.test/secret"), true);
  });

  it("uses the default fetch path (lines 170-173)", async () => {
    const realFetch = globalThis.fetch;
    let calledUrl;
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { status: 200, text: async () => "User-agent: *\nDisallow: /no" };
    };
    try {
      const cache = new RobotsCache();
      assert.equal(await cache.allowed("https://a.test/no/page"), false);
      assert.equal(await cache.allowed("https://a.test/yes"), true);
      assert.match(calledUrl, /\/robots\.txt$/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
