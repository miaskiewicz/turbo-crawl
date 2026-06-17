// Batch crawl: fetch + view a list of URLs under a chosen execution mode, with
// bounded concurrency. Per-URL failures are captured in the result, never abort
// the batch.
//
//   await batch(urls, { mode: "fast", view: "markdown", concurrency: 8 })
//
// mode:  "no-js"  — Lane A, static fetch + parse, no page scripts (fastest, safe)
//        "fast"   — in-process node:vm JS render (trusted targets only)
//        "secure" — isolated-vm JS render (open-web safe; needs the optional dep)
//
// The JS render tiers share one backend/clock, so they run SEQUENTIALLY (a render
// owns turbo-dom's global virtual clock); only "no-js" parallelizes.

import { fetchHtml } from "./net.mjs";
import { Page } from "./page.mjs";
import { jsRenderer } from "./render/index.mjs";

// Accepted mode spellings → canonical mode.
const MODE_ALIAS = {
  "no-js": "no-js",
  nojs: "no-js",
  static: "no-js",
  fast: "fast",
  "fast-js": "fast",
  "fast js": "fast",
  secure: "secure",
  "secure-js": "secure",
  "secure js": "secure",
};

// Per-URL views the caller can request (default: markdown).
const VIEWS = {
  markdown: (page) => page.markdown(),
  text: (page) => page.text(),
  html: (page) => page.html(),
  links: (page) => page.links(),
  interactive: (page) => page.interactiveElements(),
  ax: (page) => page.accessibilityTree(),
  hydration: (page) => page.hydrationState(),
};

const noop = () => {};

function resolveMode(mode) {
  const canon = MODE_ALIAS[mode ?? "no-js"];
  if (!canon) throw new Error(`turbo-crawl batch: unknown mode "${mode}" (no-js|fast|secure)`);
  return canon;
}

function resolveView(view) {
  const fn = VIEWS[view ?? "markdown"];
  if (!fn)
    throw new Error(`turbo-crawl batch: unknown view "${view}" (${Object.keys(VIEWS).join("|")})`);
  return fn;
}

// A fetchHtml + close() for the chosen mode. "no-js" is the raw Lane-A fetcher;
// `base` (injectable for tests) is the underlying network fetcher.
function makeFetcher(mode, base) {
  if (mode === "no-js") return { fetchHtml: base, close: noop };
  const r = jsRenderer({ mode, fetchHtml: base });
  return { fetchHtml: r.fetchHtml, close: () => r.close() };
}

function concurrencyFor(mode, opts) {
  return mode === "no-js" ? (opts.concurrency ?? 4) : 1;
}

async function runOne(fetcher, url, render) {
  try {
    const page = new Page({ fetchHtml: fetcher.fetchHtml });
    const nav = await page.goto(url);
    return {
      url,
      ok: true,
      status: nav.status,
      finalUrl: page.url,
      title: nav.title,
      data: render(page),
    };
  } catch (err) {
    return { url, ok: false, error: err.message };
  }
}

// Concurrency-bounded map preserving input order.
async function mapLimit(items, limit, fn) {
  const out = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * Crawl a list of URLs and return one result per URL (input order).
 * @param {string[]} urls
 * @param {object} [opts]
 * @param {"no-js"|"fast"|"secure"} [opts.mode="no-js"]
 * @param {keyof typeof VIEWS} [opts.view="markdown"]
 * @param {number} [opts.concurrency=4]  honored only for "no-js"
 * @param {typeof fetchHtml} [opts.fetchHtml]  underlying network fetcher (tests/Lane B)
 * @returns {Promise<Array<{url,ok,status?,finalUrl?,title?,data?,error?}>>}
 */
export async function batch(urls, opts = {}) {
  const mode = resolveMode(opts.mode);
  const render = resolveView(opts.view);
  const fetcher = makeFetcher(mode, opts.fetchHtml ?? fetchHtml);
  try {
    return await mapLimit(urls, concurrencyFor(mode, opts), (url) => runOne(fetcher, url, render));
  } finally {
    await fetcher.close();
  }
}
