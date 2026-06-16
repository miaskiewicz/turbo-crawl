import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Crawler } from "../src/crawl.mjs";
import { stubFetch } from "./helpers.mjs";

const H = "https://site.test";

async function collect(c) {
  const recs = [];
  for await (const rec of c) recs.push(rec);
  return recs;
}

describe("Crawler coverage", () => {
  // realSleep: do NOT inject sleep, use a tiny real politeness delay so the
  // crawler actually hits the setTimeout path (crawl.mjs 27-34).
  it("uses the real timer sleep path with a tiny politeness delay", async () => {
    const c = new Crawler({
      start: `${H}/`,
      concurrency: 1,
      // Small but reliably-positive delay so the worker actually defers /a and
      // calls realSleep(ms>0) at least once before /a is past its gate.
      politenessMs: 20,
      fetchHtml: stubFetch({
        [`${H}/`]: `<title>Home</title><a href="/a">A</a>`,
        [`${H}/a`]: `<title>A</title>`,
      }),
      // no sleep, no now → realSleep + Date.now
    });
    const urls = (await collect(c)).map((r) => r.url).sort();
    assert.deepEqual(urls, [`${H}/`, `${H}/a`]);
  });

  // realSleep abort path (crawl.mjs 31-34): abort the signal while a worker is
  // parked in a real politeness sleep so the abort listener fires (clearTimeout +
  // reject). The rejected sleep surfaces as an { error } record on the channel.
  it("aborts a real timer sleep via the signal", async () => {
    const ac = new AbortController();
    const c = new Crawler({
      start: `${H}/`,
      concurrency: 1,
      politenessMs: 1000, // long enough that we abort mid-sleep
      signal: ac.signal,
      fetchHtml: stubFetch({
        [`${H}/`]: `<title>Home</title><a href="/a">A</a>`,
        [`${H}/a`]: `<title>A</title>`,
      }),
      // no sleep injected → realSleep
    });
    const recs = [];
    const iter = c[Symbol.asyncIterator]();
    // Pull the first record (/) so a worker is now parked sleeping on /a's gate.
    const first = await iter.next();
    recs.push(first.value);
    // Abort while the worker sits in realSleep(1000).
    ac.abort();
    // Drain: the aborted sleep rejects → an { error } record, then close.
    let n;
    while (!(n = await iter.next()).done) recs.push(n.value);
    assert.ok(
      recs.some((r) => r?.error && /abort/.test(r.error)),
      "expected an aborted-sleep error record",
    );
  });

  // allowBlocked true branch (crawl.mjs 105): an allow predicate that rejects /b.
  it("drops links rejected by the allow predicate", async () => {
    const c = new Crawler({
      start: `${H}/`,
      concurrency: 2,
      sleep: async () => {},
      now: () => 0,
      allow: (url) => !url.endsWith("/b"),
      fetchHtml: stubFetch({
        [`${H}/`]: `<title>Home</title><a href="/a">A</a><a href="/b">B</a>`,
        [`${H}/a`]: `<title>A</title>`,
        [`${H}/b`]: `<title>B</title>`,
      }),
    });
    const urls = (await collect(c)).map((r) => r.url).sort();
    assert.deepEqual(urls, [`${H}/`, `${H}/a`]);
  });

  // gotoWithRetry: retryable status (503) then 200 → exercises shouldRetryStatus
  // true branch + backoff (crawl.mjs 229-232, 247, 250-253).
  it("retries on a retryable 5xx status then succeeds", async () => {
    let hits = 0;
    const fetchHtml = async (url) => {
      if (url === `${H}/`) {
        hits++;
        const status = hits === 1 ? 503 : 200;
        return { html: `<title>Home</title>`, finalUrl: url, status, headers: new Headers() };
      }
      throw new Error(`no route ${url}`);
    };
    const c = new Crawler({
      start: `${H}/`,
      concurrency: 1,
      retryBudget: 2,
      sleep: async () => {},
      now: () => 0,
      fetchHtml,
    });
    const recs = await collect(c);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, 200);
    assert.ok(hits >= 2, "fetched again after the 503");
  });

  // gotoWithRetry: a fetch that throws every time → retry until budget then
  // terminal-error record with status 0 + error (crawl.mjs 234-241).
  it("records a terminal error after the retry budget is exhausted", async () => {
    const fetchHtml = async () => {
      throw new Error("boom");
    };
    const c = new Crawler({
      start: `${H}/`,
      concurrency: 1,
      retryBudget: 1,
      sleep: async () => {},
      now: () => 0,
      fetchHtml,
    });
    const recs = await collect(c);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, 0);
    assert.equal(recs[0].url, `${H}/`);
    assert.match(recs[0].error, /boom/);
  });
});
