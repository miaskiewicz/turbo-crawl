import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CookieJar } from "../src/cookies.mjs";

describe("CookieJar coverage", () => {
  it("applies Path and Secure attribute handlers", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://a.test/", ["sid=xyz; Path=/app; Secure"]);
    // Path scoping: applies to /app but not /other.
    assert.equal(jar.cookieHeader("https://a.test/app"), "sid=xyz");
    assert.equal(jar.cookieHeader("https://a.test/other"), "");
  });

  it("applies HttpOnly and Expires attribute handlers (lines 19, 28)", () => {
    const jar = new CookieJar();
    const future = new Date(Date.now() + 60_000).toUTCString();
    jar.setFromResponse("https://a.test/", [`sid=xyz; HttpOnly; Expires=${future}`]);
    assert.equal(jar.cookieHeader("https://a.test/"), "sid=xyz");
  });

  it("exposes live cookie count via size getter (lines 162-163)", () => {
    const jar = new CookieJar();
    assert.equal(jar.size, 0);
    jar.setFromResponse("https://a.test/", ["a=1", "b=2"]);
    assert.equal(jar.size, 2);
  });
});
