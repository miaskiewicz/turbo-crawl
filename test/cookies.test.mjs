import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CookieJar } from "../src/cookies.mjs";

describe("CookieJar", () => {
  it("round-trips a simple cookie to a same-host request", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://a.test/", ["sid=abc; Path=/"]);
    assert.equal(jar.cookieHeader("https://a.test/page"), "sid=abc");
  });

  it("scopes by path", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://a.test/admin", ["k=v; Path=/admin"]);
    assert.equal(jar.cookieHeader("https://a.test/admin/x"), "k=v");
    assert.equal(jar.cookieHeader("https://a.test/other"), "");
  });

  it("honors Secure (no send over http)", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://a.test/", ["s=1; Secure"]);
    assert.equal(jar.cookieHeader("http://a.test/"), "");
    assert.equal(jar.cookieHeader("https://a.test/"), "s=1");
  });

  it("applies to subdomains when Domain is set", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://a.test/", ["d=1; Domain=a.test"]);
    assert.equal(jar.cookieHeader("https://api.a.test/"), "d=1");
  });

  it("rejects a Domain the response host is not within", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://evil.test/", ["x=1; Domain=bank.test"]);
    assert.equal(jar.cookieHeader("https://bank.test/"), "");
  });

  it("expires via Max-Age=0 (deletion)", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://a.test/", ["k=v"]);
    jar.setFromResponse("https://a.test/", ["k=v; Max-Age=0"]);
    assert.equal(jar.cookieHeader("https://a.test/"), "");
  });

  it("drops cookies past Max-Age at send time", () => {
    const jar = new CookieJar();
    jar.setFromResponse("https://a.test/", ["k=v; Max-Age=10"], 1_000_000);
    assert.equal(jar.cookieHeader("https://a.test/", 1_000_000 + 5_000), "k=v");
    assert.equal(jar.cookieHeader("https://a.test/", 1_000_000 + 20_000), "");
  });
});
