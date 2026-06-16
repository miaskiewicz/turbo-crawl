// Lane B — Chromium fallback (SPEC §11). Optional peer dep on `playwright`. The
// trick: render the page in real Chromium, snapshot the *rendered* DOM, then run
// the SAME turbo-dom extraction passes over it. So Lane B is just a different
// `fetchHtml` — a renderer — behind the identical Page interface. Zero Chromium
// weight in the base library; this module is opt-in.

import { Page } from "../src/page.mjs";

/**
 * Build a fetchHtml backed by Playwright: navigate, let JS run to settle, return
 * the rendered outerHTML. Drop-in for `new Page({ fetchHtml })`.
 *
 * @param {object} [opts]
 * @param {object} [opts.launcher]   a playwright BrowserType (default: dynamic import of chromium)
 * @param {string} [opts.waitUntil]  'load' | 'domcontentloaded' | 'networkidle' (default 'networkidle')
 * @param {object} [opts.launchOptions]
 * @returns {{ fetchHtml: Function, close: () => Promise<void> }}
 */
export function playwrightFetcher(opts = {}) {
  const waitUntil = opts.waitUntil ?? "networkidle";
  let browserPromise = null;

  async function browser() {
    if (!browserPromise) {
      const launcher = opts.launcher ?? (await import("playwright")).chromium;
      browserPromise = launcher.launch(opts.launchOptions ?? {});
    }
    return browserPromise;
  }

  async function fetchHtml(url, fetchOpts = {}) {
    const b = await browser();
    const ctx = await b.newContext();
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { waitUntil, signal: fetchOpts.signal });
      const html = await page.content();
      return {
        html,
        finalUrl: page.url(),
        status: resp ? resp.status() : 200,
        headers: new Headers(resp ? resp.headers() : {}),
      };
    } finally {
      await ctx.close();
    }
  }

  return {
    fetchHtml,
    async close() {
      if (browserPromise) await (await browserPromise).close();
      browserPromise = null;
    },
  };
}

/**
 * A Lane-B Page: identical interface to the core Page, but every navigation is a
 * real Chromium render. Use directly, or as a Crawler `fallbackFetch`.
 * @returns {{ page: Page, close: () => Promise<void> }}
 */
export function createPlaywrightPage(opts = {}) {
  const { fetchHtml, close } = playwrightFetcher(opts);
  return { page: new Page({ fetchHtml }), close };
}
