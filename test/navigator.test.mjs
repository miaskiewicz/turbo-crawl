import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Page } from "../src/page.mjs";

// Capture the headers each fetch receives so we can assert the HTTP User-Agent.
function captureFetch() {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push(opts.headers ?? {});
    return { html: "<body>x</body>", finalUrl: url, status: 200, headers: new Headers() };
  };
  fn.calls = calls;
  return fn;
}

describe("navigator / User-Agent configuration", () => {
  it("applies userAgent to both navigator and the HTTP header", async () => {
    const fetchHtml = captureFetch();
    const page = new Page({ fetchHtml, userAgent: "MyBot/2.0" });
    await page.goto("https://a.test/");
    assert.equal(page.navigator.userAgent, "MyBot/2.0");
    assert.equal(fetchHtml.calls.at(-1)["user-agent"], "MyBot/2.0");
  });

  it("overrides arbitrary navigator props (platform, language, languages)", async () => {
    const page = new Page({
      fetchHtml: captureFetch(),
      navigator: { platform: "Win32", language: "de-DE", languages: ["de-DE", "en"] },
    });
    await page.goto("https://a.test/");
    assert.equal(page.navigator.platform, "Win32");
    assert.equal(page.navigator.language, "de-DE");
    assert.deepEqual(page.navigator.languages, ["de-DE", "en"]);
  });

  it("setUserAgent persists across navigations", async () => {
    const fetchHtml = captureFetch();
    const page = new Page({ fetchHtml });
    await page.goto("https://a.test/1");
    page.setUserAgent("MyBot/3.0");
    await page.goto("https://a.test/2");
    assert.equal(page.navigator.userAgent, "MyBot/3.0");
    assert.equal(fetchHtml.calls.at(-1)["user-agent"], "MyBot/3.0");
  });

  it("per-call headers override the configured User-Agent", async () => {
    const fetchHtml = captureFetch();
    const page = new Page({ fetchHtml, userAgent: "MyBot/2.0" });
    await page.goto("https://a.test/", { headers: { "user-agent": "Override/9" } });
    assert.equal(fetchHtml.calls.at(-1)["user-agent"], "Override/9");
  });

  it("navigator getter throws before the first goto", () => {
    assert.throws(() => new Page().navigator, /no page loaded/);
  });
});
