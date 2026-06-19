// Crawler registry for the multi-page CRAWL benchmark. Each entry is one crawler
// engine that, given a target + a page cap, performs a same-host BFS crawl and
// returns { pages, items, ms }:
//   pages — distinct pages actually fetched (capped at opts.pages)
//   items — total matches of target.itemSelector across those pages (correctness)
//   ms    — wall time for the crawl
//
// turbo-surf entries always run (only the repo's existing deps + network). Every
// competitor is lazy-loaded behind available(): if its package isn't installed,
// available() returns false and run.mjs prints "skipped (not installed)".
//
// Sets:
//   nojs — compared against turbo-surf (no-js): fetch+parse HTML, no page JS.
//   js   — compared against turbo-surf (js-fast) AND (js-secure): execute page JS
//          in a real engine (browser, or turbo-surf's render tier).
//
// FAIRNESS: every engine uses the SAME target.itemSelector to count items, the
// SAME page cap, the SAME tiny politeness delay, stays same-host, and is warmed
// once by run.mjs before the timed iterations.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const POLITENESS_MS = 150;
const CONCURRENCY = 2;
const HERE = dirname(fileURLToPath(import.meta.url));

function ms(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Is a CLI tool on PATH? Probe by running it with a harmless flag; non-zero exit
// or spawn error → not available (the harness prints "skipped (not installed)").
function commandExists(cmd, probeArgs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, probeArgs, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// Parse the final JSON line {pages, items} a subprocess crawler prints (logs go
// to stderr; only the result is on stdout).
function parseResult(out, code) {
  const line = out.trim().split("\n").filter(Boolean).pop();
  const { pages, items } = JSON.parse(line ?? "");
  if (typeof pages !== "number") throw new Error(`bad output (code ${code})`);
  return { pages, items };
}

// Spawn a subprocess crawler in HERE, collect stdout, resolve {pages, items}.
function runSubprocess(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: HERE, env: process.env });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(parseResult(out, code));
      } catch (err) {
        reject(new Error(`${cmd}: ${err.message}\n${out.slice(0, 300)}`));
      }
    });
  });
}

// Does a dependency resolve? Used by competitor available() probes — we never
// install these; we only detect them.
async function canImport(spec) {
  try {
    await import(spec);
    return true;
  } catch {
    return false;
  }
}

// Read one item's string from a cheerio-wrapped element, honoring itemAttr.
function cheerioItemText($, el, attr) {
  const node = $(el);
  if (attr && attr !== "text") {
    const v = node.attr(attr);
    if (v != null && v !== "") return v.trim();
  }
  return node.text().replace(/\s+/g, " ").trim();
}

// Same-host link extraction from a cheerio doc, absolutized + filtered.
function cheerioLinks($, baseUrl, host, allow) {
  const out = [];
  $("a[href]").each((_i, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/.test(abs)) return;
    let u;
    try {
      u = new URL(abs);
    } catch {
      return;
    }
    if (u.host !== host) return;
    if (allow && !allow(abs)) return;
    out.push(abs.split("#")[0]);
  });
  return out;
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));

// ── turbo-surf: the whole crawl runs in Rust via the napi addon ─────────────
// `native.crawl` does the BFS, fetch (pooled client), parse, same-host gate, and
// per-page item count (itemSelector) entirely in Rust — only the JSON result
// crosses to Node. Same page cap / concurrency / politeness as every other engine.
let turboRustNative;
function loadTurboRustNative() {
  if (turboRustNative === undefined) {
    try {
      const require = createRequire(import.meta.url);
      turboRustNative = require("../../rust/crates/turbo-surf-napi/index.js");
    } catch {
      turboRustNative = null;
    }
  }
  return turboRustNative;
}

async function turboRustCrawl(target, opts) {
  const native = loadTurboRustNative();
  const t0 = process.hrtime.bigint();
  const recs = JSON.parse(
    await native.crawl(
      JSON.stringify({
        start: [target.start],
        maxPages: opts.pages,
        maxDepth: 1_000_000,
        concurrency: CONCURRENCY,
        perHostConcurrency: CONCURRENCY,
        politenessMs: POLITENESS_MS,
        sameHost: true,
        itemSelector: target.itemSelector,
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

// ── turbo-rust (js): a JS BFS over the napi render tier (no browser) ──────────
// Each page is fetched + its own scripts run in a true V8 isolate over the native
// rtdom DOM (the same path that renders quotes.toscrape.com/js); items are counted
// post-render, links enqueued same-host within the target's allow filter.
async function turboRustJsCrawl(target, opts) {
  const { loadTurboRust } = await import("../competitive/rust-engine.mjs");
  const browser = await (await loadTurboRust("js")).launch();
  const page = await browser.newPage();
  const seen = new Set([target.start]);
  const queue = [target.start];
  let pages = 0;
  let items = 0;
  const countExpr = `document.querySelectorAll(${JSON.stringify(target.itemSelector)}).length`;
  const hrefExpr = `Array.prototype.map.call(document.querySelectorAll('a[href]'), (a) => a.getAttribute('href'))`;
  const t0 = process.hrtime.bigint();
  while (queue.length && pages < opts.pages) {
    const url = queue.shift();
    await page.goto(url); // fetch + run the page's own JS, then read the hydrated DOM
    pages++;
    items += (await page.evaluate(countExpr)) || 0;
    for (const href of (await page.evaluate(hrefExpr)) || []) {
      let abs;
      try {
        abs = new URL(href, url).href;
      } catch {
        continue;
      }
      if (sameHost(abs, target.host) && (!target.allow || target.allow(abs)) && !seen.has(abs)) {
        seen.add(abs);
        queue.push(abs);
      }
    }
    await sleep(POLITENESS_MS);
  }
  return { pages, items, ms: ms(t0) };
}

function sameHost(url, host) {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

// ── got + cheerio (hand-rolled BFS) ──────────────────────────────────────────
async function gotCheerioCrawl(target, opts) {
  const { default: got } = await import("got");
  const cheerio = await import("cheerio");
  const seen = new Set();
  const queue = [target.start];
  seen.add(target.start);
  let pages = 0;
  let items = 0;
  const t0 = process.hrtime.bigint();
  while (queue.length && pages < opts.pages) {
    const url = queue.shift();
    let body;
    try {
      const res = await got(url, { timeout: { request: 20000 } });
      body = res.body;
    } catch {
      continue;
    }
    pages++;
    const $ = cheerio.load(body);
    $(target.itemSelector).each((_i, el) => {
      if (cheerioItemText($, el, target.itemAttr)) items++;
    });
    for (const link of cheerioLinks($, url, target.host, target.allow)) {
      if (!seen.has(link) && seen.size < opts.pages * 50) {
        seen.add(link);
        queue.push(link);
      }
    }
    await sleep(POLITENESS_MS);
  }
  return { pages, items, ms: ms(t0) };
}

// ── crawlee CheerioCrawler (nojs) ────────────────────────────────────────────
let crawleeRun = 0; // crawlee dedupes URLs in a PERSISTENT queue; use a fresh one per run
async function crawleeCheerioCrawl(target, opts) {
  const { CheerioCrawler, RequestQueue, log } = await import("crawlee");
  log.setLevel(log.LEVELS.OFF); // keep the benchmark table clean
  const requestQueue = await RequestQueue.open(`tc-bench-${crawleeRun++}`);
  let pages = 0;
  let items = 0;
  const t0 = process.hrtime.bigint();
  const crawler = new CheerioCrawler({
    requestQueue,
    maxRequestsPerCrawl: opts.pages,
    maxConcurrency: CONCURRENCY,
    // crawlee throttles by rate, not a fixed gap — match our ~POLITENESS_MS spacing.
    maxRequestsPerMinute: Math.round(60000 / POLITENESS_MS),
    async requestHandler({ $, request, enqueueLinks }) {
      pages++;
      $(target.itemSelector).each((_i, el) => {
        if (cheerioItemText($, el, target.itemAttr)) items++;
      });
      await enqueueLinks({
        strategy: "same-hostname",
        transformRequestFunction: (req) => (target.allow && !target.allow(req.url) ? false : req),
      });
      void request;
    },
  });
  await crawler.run([target.start]);
  await requestQueue.drop();
  return { pages, items, ms: ms(t0) };
}

// ── node-crawler (the `crawler` package, nojs) ───────────────────────────────
async function nodeCrawlerCrawl(target, opts) {
  const mod = await import("crawler");
  const Crawler = mod.default ?? mod.Crawler ?? mod;
  let pages = 0;
  let items = 0;
  const seen = new Set([target.start]);
  const t0 = process.hrtime.bigint();
  await new Promise((resolve) => {
    const c = new Crawler({
      maxConnections: CONCURRENCY,
      rateLimit: POLITENESS_MS,
      callback(err, res, done) {
        if (!err && res?.$ && pages < opts.pages) {
          pages++;
          const $ = res.$;
          $(target.itemSelector).each((_i, el) => {
            if (cheerioItemText($, el, target.itemAttr)) items++;
          });
          // Resolve relative links against the page's OWN url (res.options.url);
          // res.request.uri is undefined here, so deep pages must not fall back
          // to the root or their `../` links 404.
          const base = res.options?.url ?? target.start;
          for (const link of cheerioLinks($, base, target.host, target.allow)) {
            if (!seen.has(link) && pages + c.queueSize < opts.pages) {
              seen.add(link);
              c.add(link);
            }
          }
        }
        done();
      },
    });
    c.add(target.start);
    c.on("drain", resolve);
  });
  return { pages, items, ms: ms(t0) };
}

// ── x-ray (optional, nojs) — single-page paginated crawl over the catalog ────
async function xrayCrawl(target, opts) {
  const { default: Xray } = await import("x-ray");
  const x = Xray();
  let items = 0;
  let pages = 0;
  const t0 = process.hrtime.bigint();
  await new Promise((resolve, reject) => {
    x(target.start, target.itemSelector, [
      { v: target.itemAttr === "text" ? "" : `@${target.itemAttr}` },
    ])
      .paginate(".next a@href, li.next a@href")
      .limit(opts.pages)((err, arr) => {
      if (err) return reject(err);
      pages = opts.pages; // x-ray paginates internally; approximate page count
      items = Array.isArray(arr) ? arr.length : 0;
      resolve();
    });
  });
  return { pages, items, ms: ms(t0) };
}

// ── spider-rs (Rust core, Node bindings; nojs) ───────────────────────────────
// spider markets itself as the fastest crawler; native Rust does the fetch+link
// graph, we cheerio-parse each page's HTML to count items with the shared
// selector (fairness). withBudget {"*":N} caps pages; crawl() stays same-domain.
async function spiderRsCrawl(target, opts) {
  const { Website } = await import("@spider-rs/spider-rs");
  const cheerio = await import("cheerio");
  let pages = 0;
  let items = 0;
  const website = new Website(target.start)
    .withBudget({ "*": opts.pages })
    .withDelay(POLITENESS_MS) // same per-request politeness as every other engine
    .build();
  const onPage = (_err, page) => {
    if (pages >= opts.pages || !page?.content) return;
    if (target.allow && !target.allow(page.url)) return;
    pages++;
    const $ = cheerio.load(page.content);
    $(target.itemSelector).each((_i, el) => {
      if (cheerioItemText($, el, target.itemAttr)) items++;
    });
  };
  const t0 = process.hrtime.bigint();
  await website.crawl(onPage);
  return { pages, items, ms: ms(t0) };
}

// ── Scrapy (Python, CLI subprocess; nojs) ────────────────────────────────────
// Runs the spider via Scrapy's own CLI (pipx/venv install on PATH) so it executes
// in Scrapy's environment; we pass the shared selector/host/cap and parse its
// printed {pages, items}.
async function scrapyCrawl(target, opts) {
  const args = [
    "runspider",
    "scrapy_spider.py",
    "-a",
    `start=${target.start}`,
    "-a",
    `selector=${target.itemSelector}`,
    "-a",
    `pages=${opts.pages}`,
    "-a",
    `host=${target.host}`,
    "-s",
    "LOG_ENABLED=False",
    "-s",
    `CONCURRENT_REQUESTS=${CONCURRENCY}`,
    "-s",
    `DOWNLOAD_DELAY=${POLITENESS_MS / 1000}`,
    "-s",
    "ROBOTSTXT_OBEY=False",
  ];
  const t0 = process.hrtime.bigint();
  const { pages, items } = await runSubprocess("scrapy", args);
  return { pages, items, ms: ms(t0) };
}

// ── Colly (Go, CLI subprocess; nojs) ─────────────────────────────────────────
// `go run .` builds + runs colly_crawler.go (module deps cached after the first,
// untimed warmup run). Same selector/host/cap; parses its printed {pages, items}.
async function collyCrawl(target, opts) {
  const args = [
    "run",
    ".",
    `-start=${target.start}`,
    `-selector=${target.itemSelector}`,
    `-pages=${opts.pages}`,
    `-host=${target.host}`,
  ];
  const t0 = process.hrtime.bigint();
  const { pages, items } = await runSubprocess("go", args);
  return { pages, items, ms: ms(t0) };
}

// ── crawlee Playwright/Puppeteer (js) ────────────────────────────────────────
async function crawleeBrowserCrawl(target, opts, which) {
  const crawlee = await import("crawlee");
  crawlee.log.setLevel(crawlee.log.LEVELS.OFF);
  const CrawlerClass = which === "puppeteer" ? crawlee.PuppeteerCrawler : crawlee.PlaywrightCrawler;
  const requestQueue = await crawlee.RequestQueue.open(`tc-bench-${crawleeRun++}`);
  let pages = 0;
  let items = 0;
  const t0 = process.hrtime.bigint();
  const crawler = new CrawlerClass({
    requestQueue,
    maxRequestsPerCrawl: opts.pages,
    maxConcurrency: CONCURRENCY,
    async requestHandler({ page, enqueueLinks }) {
      pages++;
      const n = await page.$$eval(target.itemSelector, (els) => els.length).catch(() => 0);
      items += n;
      await enqueueLinks({
        strategy: "same-hostname",
        transformRequestFunction: (req) => (target.allow && !target.allow(req.url) ? false : req),
      });
    },
  });
  await crawler.run([target.start]);
  await requestQueue.drop();
  return { pages, items, ms: ms(t0) };
}

// ── puppeteer-cluster (optional, js) ─────────────────────────────────────────
async function puppeteerClusterCrawl(target, opts) {
  const { Cluster } = await import("puppeteer-cluster");
  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: CONCURRENCY,
  });
  let pages = 0;
  let items = 0;
  const seen = new Set([target.start]);
  const t0 = process.hrtime.bigint();
  await cluster.task(async ({ page, data: url }) => {
    if (pages >= opts.pages) return;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
    pages++;
    const n = await page.$$eval(target.itemSelector, (els) => els.length).catch(() => 0);
    items += n;
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.href)).catch(() => []);
    for (const href of hrefs) {
      let u;
      try {
        u = new URL(href);
      } catch {
        continue;
      }
      const clean = href.split("#")[0];
      if (
        u.host === target.host &&
        !seen.has(clean) &&
        seen.size < opts.pages &&
        (!target.allow || target.allow(clean))
      ) {
        seen.add(clean);
        cluster.queue(clean);
      }
    }
    await sleep(POLITENESS_MS);
  });
  cluster.queue(target.start);
  await cluster.idle();
  await cluster.close();
  return { pages, items, ms: ms(t0) };
}

// Registry. `set` selects which workload/comparison an entry belongs to.
export const CRAWLERS = [
  // ── Set A: non-JS ──────────────────────────────────────────────────────────
  {
    name: "turbo-surf (no-js)",
    set: "nojs",
    turbo: true,
    available: () => Promise.resolve(loadTurboRustNative() != null),
    crawl: turboRustCrawl,
  },
  {
    name: "spider-rs (Rust)",
    set: "nojs",
    available: async () =>
      (await canImport("@spider-rs/spider-rs")) && (await canImport("cheerio")),
    crawl: spiderRsCrawl,
  },
  {
    name: "Scrapy (Python)",
    set: "nojs",
    available: () => commandExists("scrapy", ["version"]),
    crawl: scrapyCrawl,
  },
  {
    name: "Colly (Go)",
    set: "nojs",
    available: () => commandExists("go", ["version"]),
    crawl: collyCrawl,
  },
  {
    name: "crawlee CheerioCrawler",
    set: "nojs",
    available: () => canImport("crawlee"),
    crawl: crawleeCheerioCrawl,
  },
  {
    name: "got + cheerio",
    set: "nojs",
    available: async () => (await canImport("got")) && (await canImport("cheerio")),
    crawl: gotCheerioCrawl,
  },
  {
    name: "node-crawler (crawler)",
    set: "nojs",
    available: () => canImport("crawler"),
    crawl: nodeCrawlerCrawl,
  },
  {
    name: "x-ray",
    set: "nojs",
    available: () => canImport("x-ray"),
    crawl: xrayCrawl,
  },

  // ── Set B: JS-executing ─────────────────────────────────────────────────────
  {
    name: "turbo-surf (js)",
    set: "js",
    turbo: true,
    available: () => Promise.resolve(loadTurboRustNative() != null),
    crawl: turboRustJsCrawl,
  },
  {
    name: "crawlee PlaywrightCrawler",
    set: "js",
    available: async () => (await canImport("crawlee")) && (await canImport("playwright")),
    crawl: (target, opts) => crawleeBrowserCrawl(target, opts, "playwright"),
  },
  {
    name: "crawlee PuppeteerCrawler",
    set: "js",
    available: async () => (await canImport("crawlee")) && (await canImport("puppeteer")),
    crawl: (target, opts) => crawleeBrowserCrawl(target, opts, "puppeteer"),
  },
  {
    name: "puppeteer-cluster",
    set: "js",
    available: () => canImport("puppeteer-cluster"),
    crawl: puppeteerClusterCrawl,
  },
];

export function crawlersForSet(set) {
  return CRAWLERS.filter((c) => c.set === set);
}
