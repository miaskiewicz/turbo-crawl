import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ResponseCache } from "../src/cache.mjs";
import { fetchHtml } from "../src/net.mjs";
import { Page } from "../src/page.mjs";

describe("ResponseCache", () => {
  it("stores ETag + Last-Modified and replays them as validators", () => {
    const c = new ResponseCache();
    c.store(
      "https://a.test/",
      new Headers({ etag: '"v1"', "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" }),
      "<h1>hi</h1>",
      200,
    );
    assert.equal(c.size, 1);
    assert.deepEqual(c.validators("https://a.test/"), {
      "if-none-match": '"v1"',
      "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT",
    });
    assert.equal(c.body("https://a.test/"), "<h1>hi</h1>");
  });

  it("only stores entries that carry a validator", () => {
    const c = new ResponseCache();
    c.store("https://a.test/", new Headers(), "<h1>hi</h1>", 200);
    assert.equal(c.size, 0);
    assert.deepEqual(c.validators("https://a.test/"), {});
    assert.equal(c.body("https://a.test/"), "");
  });

  it("emits only the validators it has", () => {
    const c = new ResponseCache();
    c.store("https://a.test/", new Headers({ etag: '"v1"' }), "x", 200);
    assert.deepEqual(c.validators("https://a.test/"), { "if-none-match": '"v1"' });
  });
});

// Fake fetch that records the request headers and answers per-spec.
function recordingFetch(spec) {
  const fn = async (_url, init) => {
    fn.lastHeaders = init.headers;
    const headers = new Headers(spec.headers ?? { "content-type": "text/html" });
    return {
      url: spec.finalUrl ?? _url,
      status: spec.status ?? 200,
      headers,
      body: (async function* () {
        yield new TextEncoder().encode(spec.body ?? "");
      })(),
    };
  };
  return fn;
}

describe("fetchHtml conditional requests (304)", () => {
  it("sends validators on recrawl and reuses the cached body on 304", async () => {
    const cache = new ResponseCache();
    const url = "https://a.test/";

    // First crawl: 200 with an ETag → body stored.
    const first = await fetchHtml(url, {
      cache,
      fetch: recordingFetch({
        body: "<h1>v1</h1>",
        headers: { "content-type": "text/html", etag: '"v1"' },
      }),
    });
    assert.equal(first.html, "<h1>v1</h1>");
    assert.equal(first.notModified, undefined);

    // Recrawl: server answers 304 with no body → cached body reused.
    const revFetch = recordingFetch({ status: 304, body: "" });
    const second = await fetchHtml(url, { cache, fetch: revFetch });
    assert.equal(revFetch.lastHeaders["if-none-match"], '"v1"');
    assert.equal(second.status, 304);
    assert.equal(second.notModified, true);
    assert.equal(second.html, "<h1>v1</h1>");
  });
});

describe("Page threads the cache to its fetcher", () => {
  it("passes opts.cache through #fetch", async () => {
    const cache = new ResponseCache();
    let seen;
    const fetchHtml = async (_url, opts) => {
      seen = opts.cache;
      return { html: "<title>t</title>", finalUrl: _url, status: 200, headers: new Headers() };
    };
    const page = new Page({ fetchHtml, cache });
    await page.goto("https://a.test/");
    assert.equal(seen, cache);
  });
});
