import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRobots, RobotsCache } from "../src/robots.mjs";

const TXT = `
User-agent: *
Disallow: /private
Allow: /private/public
Crawl-delay: 2

User-agent: turbo-crawl
Disallow: /nope
`;

function cache(text, status = 200) {
  return new RobotsCache({ fetchText: async () => ({ status, text }) });
}

describe("parseRobots", () => {
  it("groups rules per user-agent", () => {
    const groups = parseRobots(TXT);
    assert.equal(groups.length, 2);
  });
});

describe("RobotsCache.allowed", () => {
  it("denies a disallowed path for *", async () => {
    assert.equal(await cache(TXT).allowed("https://a.test/private/x", "randombot"), false);
  });
  it("longest-match Allow overrides Disallow", async () => {
    assert.equal(await cache(TXT).allowed("https://a.test/private/public", "randombot"), true);
  });
  it("prefers the UA-specific group over *", async () => {
    const c = cache(TXT);
    assert.equal(await c.allowed("https://a.test/nope", "turbo-crawl"), false);
    // turbo-crawl's group has no /private rule → allowed
    assert.equal(await c.allowed("https://a.test/private", "turbo-crawl"), true);
  });
  it("allows everything when robots.txt is 404", async () => {
    assert.equal(await cache("Not found", 404).allowed("https://a.test/anything"), true);
  });
  it("surfaces crawl-delay for the scheduler", async () => {
    assert.equal(await cache(TXT).crawlDelay("https://a.test", "randombot"), 2);
  });
  it("supports $ end-anchor and * wildcards", async () => {
    const c = cache("User-agent: *\nDisallow: /*.pdf$");
    assert.equal(await c.allowed("https://a.test/doc.pdf", "b"), false);
    assert.equal(await c.allowed("https://a.test/doc.pdf?x=1", "b"), true);
  });
});
