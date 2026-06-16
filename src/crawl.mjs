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

export class Crawler {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Crawl, yielding { url, status, depth, title, links, view?, extracted? }.
   * Async-iterable, so `for await (const rec of new Crawler({...}))` works.
   */
  async *[Symbol.asyncIterator]() {
    const o = this.options;
    const sleep = o.sleep ?? realSleep;
    const now = o.now ?? Date.now;
    const channel = new Channel();

    const starts = [].concat(o.start ?? []).filter(isHttpUrl);
    const startHosts = new Set(starts.map((u) => new URL(u).host));
    const frontier = new Frontier();
    for (const s of starts) frontier.add(s, 0);

    const hostState = new Map(); // host → { inFlight, nextAt }
    const hs = (host) => {
      let s = hostState.get(host);
      if (!s) hostState.set(host, (s = { inFlight: 0, nextAt: 0 }));
      return s;
    };

    let produced = 0;
    let active = 0;
    const pool = Array.from(
      { length: o.concurrency },
      () => new Page({ fetchHtml: o.fetchHtml, jar: o.jar }),
    );
    // Lazy per-worker Lane-B page; only built if a page trips the JS-required gate.
    const fallbackPages = new WeakMap();
    const fallbackFor = (worker) => {
      if (!o.fallback) return null;
      let fb = fallbackPages.get(worker);
      if (!fb) fallbackPages.set(worker, (fb = new Page({ fetchHtml: o.fallback })));
      return fb;
    };

    const allowedByRobots = (url) =>
      o.robots ? o.robots.allowed(url, o.userAgent) : Promise.resolve(true);

    const acceptLink = (url) => {
      if (!isHttpUrl(url)) return false;
      if (o.sameHostOnly && !startHosts.has(new URL(url).host)) return false;
      if (o.allow && !o.allow(url)) return false;
      return true;
    };

    // Pull the next fetchable item whose host is under its concurrency cap and
    // past its politeness gate; returns { item, wait } or null when nothing ready.
    const claim = () => {
      const deferred = [];
      let item;
      let minWait = Infinity;
      while ((item = frontier.next())) {
        const host = new URL(item.url).host;
        const state = hs(host);
        const wait = state.nextAt - now();
        if (state.inFlight >= o.perHostConcurrency) {
          deferred.push(item);
          continue;
        }
        if (wait > 0) {
          deferred.push(item);
          minWait = Math.min(minWait, wait);
          continue;
        }
        break;
      }
      // Re-queue what we passed over (bypass visited gate — already counted).
      for (const d of deferred) frontier.requeue(d);
      if (!item) return { item: null, wait: minWait === Infinity ? 0 : minWait };
      return { item, wait: 0 };
    };

    const worker = async (page) => {
      while (produced < o.maxPages) {
        const { item, wait } = claim();
        if (!item) {
          if (active === 0 && frontier.pending === 0) return; // truly drained
          await sleep(wait > 0 ? wait : 5, o.signal);
          continue;
        }
        const host = new URL(item.url).host;
        const state = hs(host);
        state.inFlight++;
        active++;
        try {
          if (!(await allowedByRobots(item.url))) continue;
          const res = await this.#fetchOne(page, item, o, sleep, now, state, fallbackFor(page));
          if (!res) continue;
          if (produced >= o.maxPages) return;
          produced++;
          channel.push(res.rec);

          if (!res.rec.error && item.depth < o.maxDepth) {
            for (const link of res.source.links()) {
              if (acceptLink(link)) frontier.add(link, item.depth + 1);
            }
          }
        } finally {
          state.inFlight--;
          active--;
        }
      }
    };

    Promise.all(pool.map((p) => worker(p)))
      .catch((err) => channel.push({ error: String(err) }))
      .finally(() => channel.close());

    while (true) {
      const { value, done } = await channel.next();
      if (done) return;
      yield value;
    }
  }

  async #fetchOne(page, item, o, sleep, now, state, fallbackPage) {
    let attempt = 0;
    while (true) {
      try {
        const nav = await page.goto(item.url);
        state.nextAt = now() + o.politenessMs;
        if (RETRYABLE(nav.status) && attempt < o.retryBudget) {
          attempt++;
          await sleep(o.backoffMs * 2 ** (attempt - 1), o.signal);
          continue;
        }

        // Lane B routing (SPEC §11): if the no-JS parse looks shell-only and a
        // fallback fetcher is configured, re-render through it and use that DOM.
        let source = page;
        let finalNav = nav;
        let lane = "A";
        if (fallbackPage && detectJsRequired(page.document, o.detect).jsRequired) {
          finalNav = await fallbackPage.goto(item.url);
          source = fallbackPage;
          lane = "B";
        }

        const rec = {
          url: finalNav.url,
          status: finalNav.status,
          depth: item.depth,
          lane,
          title: finalNav.title,
          links: source.links(),
        };
        if (o.view !== false) {
          rec.view = { interactiveElements: source.interactiveElements() };
          if (o.markdown) rec.view.markdown = source.markdown();
        }
        if (o.schema) rec.extracted = extractSchema(source.document, o.schema, finalNav.url);
        return { rec, source };
      } catch (err) {
        state.nextAt = now() + o.politenessMs;
        if (attempt < o.retryBudget) {
          attempt++;
          await sleep(o.backoffMs * 2 ** (attempt - 1), o.signal);
          continue;
        }
        return {
          rec: { url: item.url, status: 0, depth: item.depth, error: String(err) },
          source: page,
        };
      }
    }
  }
}
