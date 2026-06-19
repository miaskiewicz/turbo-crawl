// Apples-to-apples head-to-head: turbo-rust (no-js) vs crawlee CheerioCrawler on
// the SAME crawl — same site, same page cap, same concurrency, and a MATCHED
// politeness (crawlee's `maxRequestsPerMinute` rate ↔ turbo-rust's per-host token
// bucket at the same interval). Same-process, same network, median of N runs.
//
//   node harness/crawlers/head-to-head.mjs [--pages=20] [--iters=5]
//
// Needs crawlee + cheerio installed (npm i -D crawlee cheerio) and the napi addon
// built (cargo build --release -p turbo-surf-napi).

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../../rust/crates/turbo-surf-napi/index.js");

const TARGET = "https://books.toscrape.com/";
const ITEM_SELECTOR = ".product_pod h3 a";
const CONCURRENCY = 2;

const flag = (n, d) => {
  const f = process.argv.find((a) => a.startsWith(`--${n}=`));
  return f ? Number(f.split("=")[1]) : d;
};
const PAGES = flag("pages", 20);
const ITERS = flag("iters", 5);
// politeness=0 → raw engine speed (no throttle, the truest apples-to-apples, since
// the two throttle MODELS differ: turbo-rust enforces a strict per-host interval,
// crawlee's maxRequestsPerMinute is a lenient sliding window over short bursts).
const POLITENESS_MS = flag("politeness", 150);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// turbo-rust: the whole BFS runs in Rust (one napi call), per-host token-bucket
// politeness at POLITENESS_MS with burst = concurrency.
async function turboRust() {
  const t0 = process.hrtime.bigint();
  const recs = JSON.parse(
    await native.crawl(
      JSON.stringify({
        start: [TARGET],
        maxPages: PAGES,
        maxDepth: 1_000_000,
        sameHost: true,
        itemSelector: ITEM_SELECTOR,
        concurrency: CONCURRENCY,
        perHostConcurrency: CONCURRENCY,
        politenessMs: POLITENESS_MS,
      }),
    ),
  );
  let pages = 0;
  let items = 0;
  for (const r of recs) {
    if (!r.error) {
      pages++;
      items += r.items || 0;
    }
  }
  return { pages, items, ms: ms(t0) };
}

// crawlee CheerioCrawler: maxConcurrency + maxRequestsPerMinute (the rate that
// matches POLITENESS_MS spacing — crawlee throttles by rate, not a fixed gap).
let qn = 0;
async function cheerio() {
  const { CheerioCrawler, RequestQueue, log } = await import("crawlee");
  const cheerioMod = await import("cheerio");
  void cheerioMod;
  log.setLevel(log.LEVELS.OFF);
  const requestQueue = await RequestQueue.open(`h2h-${process.pid}-${qn++}`);
  let pages = 0;
  let items = 0;
  const t0 = process.hrtime.bigint();
  const crawler = new CheerioCrawler({
    requestQueue,
    maxRequestsPerCrawl: PAGES,
    maxConcurrency: CONCURRENCY,
    // match POLITENESS_MS as a rate; 0 → no throttle (raw).
    ...(POLITENESS_MS > 0 ? { maxRequestsPerMinute: Math.round(60000 / POLITENESS_MS) } : {}),
    async requestHandler({ $, enqueueLinks }) {
      pages++;
      items += $(ITEM_SELECTOR).length;
      await enqueueLinks({ strategy: "same-hostname" });
    },
    failedRequestHandler() {},
  });
  await crawler.run([TARGET]);
  await requestQueue.drop();
  return { pages, items, ms: ms(t0) };
}

async function measure(name, fn) {
  await fn(); // warm (DNS, JIT, connection pool)
  const times = [];
  let last;
  for (let i = 0; i < ITERS; i++) {
    last = await fn();
    times.push(last.ms);
  }
  const med = median(times);
  console.log(
    `  ${name.padEnd(24)} pages=${last.pages}  items=${last.items}  median ${med.toFixed(0).padStart(6)}ms  ${(last.pages / (med / 1000)).toFixed(1)} pages/s`,
  );
}

console.log(
  `head-to-head: ${PAGES}-page same-host crawl of books.toscrape.com\n` +
    `concurrency=${CONCURRENCY}  politeness=${POLITENESS_MS}ms  iters=${ITERS}  (median, live network)\n`,
);
await measure("turbo-rust (no-js)", turboRust);
await measure("crawlee CheerioCrawler", cheerio);
process.exit(0);
