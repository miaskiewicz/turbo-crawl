// Crawler (SPEC §9): drives bulk crawls over a Frontier with global + per-host
// concurrency, per-host politeness delay, backoff on 429/5xx, retry budget, and
// depth/page caps. Output is a backpressure-aware async iterator of page records.
// A pool of warm Pages is reused across the frontier (env reset per hop).

import { detectJsRequired } from "./detect.mjs";
import { extractSchema } from "./schema.mjs";
import { Frontier } from "./frontier.mjs";
import { Page } from "./page.mjs";
import { isHttpUrl } from "./url.mjs";

const DEFAULTS = {
  maxPages: 100,
  maxDepth: 3,
  concurrency: 4,
  perHostConcurrency: 2,
  politenessMs: 0,
  sameHostOnly: true,
  userAgent: "turbo-crawl",
  retryBudget: 2,
  backoffMs: 200,
};

const RETRYABLE = (status) => status === 429 || (status >= 500 && status < 600);

const realSleep = (ms, signal) =>
  ms <= 0
    ? Promise.resolve()
    : new Promise((res, rej) => {
        const t = setTimeout(res, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        });
      });

// A tiny single-producer/many-consumer async channel for the iterator output.
class Channel {
  #buf = [];
  #waiting = [];
  #closed = false;

  push(v) {
    if (this.#waiting.length) this.#waiting.shift()({ value: v, done: false });
    else this.#buf.push(v);
  }
  close() {
    this.#closed = true;
    while (this.#waiting.length) this.#waiting.shift()({ value: undefined, done: true });
  }
  next() {
    if (this.#buf.length) return Promise.resolve({ value: this.#buf.shift(), done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((res) => this.#waiting.push(res));
  }
}

// Mutable shared state for a single crawl run; passed to the module-level
// helpers below so each helper carries its own cc budget instead of nesting
// as a closure inside the iterator.
function makeState(crawler) {
  const o = crawler.options;
  return {
    crawler,
    o,
    sleep: o.sleep ?? realSleep,
    now: o.now ?? Date.now,
    channel: new Channel(),
    frontier: new Frontier(),
    startHosts: new Set(),
    hostState: new Map(), // host → { inFlight, nextAt }
    fallbackPages: new WeakMap(),
    produced: 0,
    active: 0,
  };
}

// Per-host { inFlight, nextAt } record, created on first use.
function hostStateFor(st, host) {
  let s = st.hostState.get(host);
  if (!s) st.hostState.set(host, (s = { inFlight: 0, nextAt: 0 }));
  return s;
}

// Lazy per-worker Lane-B page; only built if a page trips the JS-required gate.
function fallbackFor(st, worker) {
  if (!st.o.fallback) return null;
  let fb = st.fallbackPages.get(worker);
  if (!fb) st.fallbackPages.set(worker, (fb = new Page({ fetchHtml: st.o.fallback })));
  return fb;
}

function allowedByRobots(st, url) {
  if (!st.o.robots) return Promise.resolve(true);
  return st.o.robots.allowed(url, st.o.userAgent);
}

function hostBlocked(st, url) {
  if (!st.o.sameHostOnly) return false;
  return !st.startHosts.has(new URL(url).host);
}

function allowBlocked(st, url) {
  if (!st.o.allow) return false;
  return !st.o.allow(url);
}

function acceptLink(st, url) {
  if (!isHttpUrl(url)) return false;
  if (hostBlocked(st, url)) return false;
  if (allowBlocked(st, url)) return false;
  return true;
}

// True when an item's host is under its concurrency cap and past its politeness
// gate. Mutates `acc` to track the minimum wait across deferred items.
function itemReady(st, item, acc) {
  const state = hostStateFor(st, new URL(item.url).host);
  if (state.inFlight >= st.o.perHostConcurrency) return false;
  const wait = state.nextAt - st.now();
  if (wait > 0) {
    acc.minWait = Math.min(acc.minWait, wait);
    return false;
  }
  return true;
}

// Pull the next fetchable item whose host is under its concurrency cap and
// past its politeness gate; returns { item, wait } or null when nothing ready.
function claim(st) {
  const deferred = [];
  const acc = { minWait: Infinity };
  let item;
  let ready = null;
  while ((item = st.frontier.next())) {
    if (itemReady(st, item, acc)) {
      ready = item;
      break;
    }
    deferred.push(item);
  }
  // Re-queue what we passed over (bypass visited gate — already counted).
  for (const d of deferred) st.frontier.requeue(d);
  if (ready) return { item: ready, wait: 0 };
  return { item: null, wait: clampWait(acc.minWait) };
}

function clampWait(minWait) {
  return minWait === Infinity ? 0 : minWait;
}

// Enqueue accepted out-links from a freshly fetched record at the next depth.
function harvestLinks(st, item, res) {
  if (res.rec.error || item.depth >= st.o.maxDepth) return;
  for (const link of res.source.links()) {
    if (acceptLink(st, link)) st.frontier.add(link, item.depth + 1);
  }
}

// Fetch one claimed item, publish its record, and harvest links. Returns true
// when the worker should stop (page cap reached during processing).
async function processItem(st, page, item) {
  const state = hostStateFor(st, new URL(item.url).host);
  state.inFlight++;
  st.active++;
  try {
    if (!(await allowedByRobots(st, item.url))) return false;
    await resolvePoliteness(st, item.url, state);
    const res = await st.crawler._fetchOne(page, item, st, state, fallbackFor(st, page));
    if (!res) return false;
    if (st.produced >= st.o.maxPages) return true;
    st.produced++;
    st.channel.push(res.rec);
    harvestLinks(st, item, res);
    return false;
  } finally {
    state.inFlight--;
    st.active--;
  }
}

// Resolve a host's effective politeness delay once: max of the configured
// politenessMs and any robots.txt Crawl-delay (seconds → ms). Cached on the
// host state so robots is consulted at most once per host.
async function resolvePoliteness(st, url, state) {
  if (state.politenessMs !== undefined) return;
  let ms = st.o.politenessMs;
  if (st.o.robots?.crawlDelay) {
    const cd = await st.o.robots.crawlDelay(new URL(url).origin, st.o.userAgent);
    if (cd) ms = Math.max(ms, cd * 1000);
  }
  state.politenessMs = ms;
}

function politenessFor(st, state) {
  return state.politenessMs ?? st.o.politenessMs;
}

function isDrained(st) {
  return st.active === 0 && st.frontier.pending === 0;
}

// Poll cadence while idle: honor a host's politeness wait, else a short tick.
function idleWait(wait) {
  return wait > 0 ? wait : 5;
}

// One worker pulls items until the page cap is hit or the frontier truly drains.
async function worker(st, page) {
  while (st.produced < st.o.maxPages) {
    const { item, wait } = claim(st);
    if (!item) {
      if (isDrained(st)) return; // truly drained
      await st.sleep(idleWait(wait), st.o.signal);
      continue;
    }
    if (await processItem(st, page, item)) return;
  }
}

// Navigate once with retry/backoff on retryable statuses or thrown errors.
// Returns { nav } to continue building a record, or { rec } on terminal error.
async function gotoWithRetry(st, page, item, state) {
  let attempt = 0;
  while (true) {
    try {
      const nav = await page.goto(item.url);
      state.nextAt = st.now() + politenessFor(st, state);
      if (shouldRetryStatus(st, nav.status, attempt)) {
        attempt = await backoff(st, attempt);
        continue;
      }
      return { nav };
    } catch (err) {
      state.nextAt = st.now() + politenessFor(st, state);
      if (attempt < st.o.retryBudget) {
        attempt = await backoff(st, attempt);
        continue;
      }
      return { rec: { url: item.url, status: 0, depth: item.depth, error: String(err) } };
    }
  }
}

function shouldRetryStatus(st, status, attempt) {
  if (!RETRYABLE(status)) return false;
  return attempt < st.o.retryBudget;
}

function backoff(st, attempt) {
  const next = attempt + 1;
  return st.sleep(st.o.backoffMs * 2 ** (next - 1), st.o.signal).then(() => next);
}

// Lane B routing (SPEC §11): if the no-JS parse looks shell-only and a
// fallback fetcher is configured, re-render through it and use that DOM.
async function maybeLaneB(st, page, item, nav, fallbackPage) {
  if (fallbackPage && detectJsRequired(page.document, st.o.detect).jsRequired) {
    return { source: fallbackPage, finalNav: await fallbackPage.goto(item.url), lane: "B" };
  }
  return { source: page, finalNav: nav, lane: "A" };
}

function buildRecord(st, item, source, finalNav, lane) {
  const rec = {
    url: finalNav.url,
    status: finalNav.status,
    depth: item.depth,
    lane,
    title: finalNav.title,
    links: source.links(),
  };
  if (st.o.view !== false) {
    rec.view = { interactiveElements: source.interactiveElements() };
    if (st.o.markdown) rec.view.markdown = source.markdown();
  }
  if (st.o.schema) rec.extracted = extractSchema(source.document, st.o.schema, finalNav.url);
  return { rec, source };
}

// Seed the frontier from the configured start URLs and record their hosts.
function seedFrontier(st) {
  const starts = [].concat(st.o.start ?? []).filter(isHttpUrl);
  for (const s of starts) st.startHosts.add(new URL(s).host);
  for (const s of starts) st.frontier.add(s, 0);
}

export class Crawler {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Crawl, yielding { url, status, depth, title, links, view?, extracted? }.
   * Async-iterable, so `for await (const rec of new Crawler({...}))` works.
   */
  async *[Symbol.asyncIterator]() {
    const st = makeState(this);
    seedFrontier(st);

    const pool = Array.from(
      { length: st.o.concurrency },
      () => new Page({ fetchHtml: st.o.fetchHtml, jar: st.o.jar }),
    );

    Promise.all(pool.map((p) => worker(st, p)))
      .catch((err) => st.channel.push({ error: String(err) }))
      .finally(() => st.channel.close());

    while (true) {
      const { value, done } = await st.channel.next();
      if (done) return;
      yield value;
    }
  }

  async _fetchOne(page, item, st, state, fallbackPage) {
    const out = await gotoWithRetry(st, page, item, state);
    if (out.rec) return { rec: out.rec, source: page };
    const { source, finalNav, lane } = await maybeLaneB(st, page, item, out.nav, fallbackPage);
    return buildRecord(st, item, source, finalNav, lane);
  }
}
