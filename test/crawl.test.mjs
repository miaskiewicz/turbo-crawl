import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Crawler } from "../src/crawl.mjs";
import { stubFetch } from "./helpers.mjs";

const H = "https://site.test";
const SITE = {
  [`${H}/`]: `<title>Home</title><a href="/a">A</a><a href="/b">B</a><a href="/a">dup</a><a href="https://other.test/x">ext</a>`,
  [`${H}/a`]: `<title>A</title><a href="/a1">A1</a><a href="/">home</a>`,
  [`${H}/b`]: `<title>B</title><a href="/b1">B1</a>`,
  [`${H}/a1`]: `<title>A1</title>`,
  [`${H}/b1`]: `<title>B1</title>`,
};

function crawler(extra = {}) {
  const fetchHtml = stubFetch(SITE);
  const c = new Crawler({
    start: `${H}/`,
    concurrency: 3,
    fetchHtml,
    sleep: async () => {},
    now: () => 0,
    ...extra,
  });
  return { c, fetchHtml };
}

async function collect(c) {
  const recs = [];
  for await (const rec of c) recs.push(rec);
  return recs;
}

describe("Crawler", () => {
  it("crawls the whole same-host graph with no duplicate fetches", async () => {
    const { c, fetchHtml } = crawler();
    const recs = await collect(c);
    const urls = recs.map((r) => r.url).sort();
    assert.deepEqual(urls, [`${H}/`, `${H}/a`, `${H}/a1`, `${H}/b`, `${H}/b1`]);
    // each page fetched exactly once despite the dup <a> and the back-link to /
    assert.equal(fetchHtml.calls.length, 5);
  });

  it("drops off-host links (sameHostOnly)", async () => {
    const { c } = crawler();
    const recs = await collect(c);
    assert.ok(!recs.some((r) => r.url.includes("other.test")));
  });

  it("honors maxDepth", async () => {
    const { c } = crawler({ maxDepth: 1 });
    const urls = (await collect(c)).map((r) => r.url).sort();
    // depth 0: /, depth 1: /a /b — their children (/a1 /b1) are depth 2, excluded
    assert.deepEqual(urls, [`${H}/`, `${H}/a`, `${H}/b`]);
  });

  it("honors maxPages", async () => {
    const { c } = crawler({ maxPages: 2 });
    assert.equal((await collect(c)).length, 2);
  });

  it("respects robots.txt", async () => {
    const robots = {
      allowed: async (url) => !url.endsWith("/b"),
    };
    const { c } = crawler({ robots });
    const urls = (await collect(c)).map((r) => r.url);
    assert.ok(!urls.includes(`${H}/b`));
    assert.ok(urls.includes(`${H}/a`));
  });

  it("includes the agent view and extracted schema", async () => {
    const { c } = crawler({
      maxPages: 1,
      schema: { title: { selector: "title" } },
    });
    const [rec] = await collect(c);
    assert.ok(Array.isArray(rec.view.interactiveElements));
    assert.equal(rec.extracted.title, "Home");
  });

  it("enforces per-host politeness ordering via the clock", async () => {
    // With politeness and a single host, nextAt gating must not deadlock.
    let t = 0;
    const { c } = crawler({
      concurrency: 2,
      politenessMs: 100,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    const recs = await collect(c);
    assert.equal(recs.length, 5);
  });
});
