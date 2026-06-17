// JS-execution render tier — turns a no-JS fetch into a *rendered* fetch by
// running the page's scripts against turbo-dom, no browser. Two backends behind
// one interface, selected by `mode`:
//   - "secure" (default): isolated-vm + turbo-dom WASM — true V8 isolate, safe for
//     hostile/open-web pages.
//   - "fast": in-process node:vm + native turbo-dom — fastest, NO isolation; for
//     local testing / trusted targets only.
//
// `jsRenderer(opts).fetchHtml` is drop-in for `new Page({ fetchHtml })` and for a
// Crawler `{ fallback }`. It renders, then returns the rendered HTML so all the
// existing extraction runs over a populated DOM.

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { fetchHtml as defaultFetchHtml } from "../net.mjs";
import { extractScripts } from "./scripts.mjs";

async function makeBackend(mode) {
  if (mode === "fast") return (await import("./backend-fast.mjs")).createFastBackend();
  return (await import("./backend-secure.mjs")).createSecureBackend();
}

// Resolve each script to inline code (external src fetched via the host net layer).
async function loadScripts(fetchHtml, document, baseUrl) {
  const items = extractScripts(document, baseUrl);
  const out = [];
  for (const it of items) {
    if (it.code != null) {
      out.push(it);
      continue;
    }
    const code = await fetchScript(fetchHtml, it.url);
    if (code != null) out.push({ code, module: it.module });
  }
  return out;
}

async function fetchScript(fetchHtml, url) {
  try {
    const res = await fetchHtml(url, { allowNonHtml: true });
    return res.html;
  } catch {
    return null; // a missing/broken script must not abort the render
  }
}

/**
 * @param {object} [opts]
 * @param {"secure"|"fast"} [opts.mode="secure"]
 * @param {typeof defaultFetchHtml} [opts.fetchHtml]  underlying Lane-A fetcher
 * @param {number} [opts.timeoutMs]   per-script execution cap
 * @param {number} [opts.settleMs]    settle tick between timer-drain rounds
 * @returns {{ fetchHtml: Function, close: () => Promise<void> }}
 */
export function jsRenderer(opts = {}) {
  const fetchHtml = opts.fetchHtml ?? defaultFetchHtml;
  const backendPromise = makeBackend(opts.mode ?? "secure");

  async function renderFetch(url, fetchOpts = {}) {
    const res = await fetchHtml(url, fetchOpts);
    const env = createEnvironment(res.html);
    const scripts = await loadScripts(fetchHtml, env.document, res.finalUrl);
    const backend = await backendPromise;
    const html = await backend.render(res.html, scripts, {
      ...opts,
      url: res.finalUrl,
      hostFetch: fetchHtml,
    });
    return { ...res, html };
  }

  return {
    fetchHtml: renderFetch,
    async close() {
      await (await backendPromise).close();
    },
  };
}
