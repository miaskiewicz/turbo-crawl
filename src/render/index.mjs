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
import { bundleModule } from "./bundle-modules.mjs";
import { extractScripts } from "./scripts.mjs";

async function makeBackend(mode) {
  if (mode === "fast") return (await import("./backend-fast.mjs")).createFastBackend();
  return (await import("./backend-secure.mjs")).createSecureBackend();
}

// Read a <script type="importmap"> JSON blob from the document, or {} if absent.
function readImportMap(document) {
  const el = document.querySelector('script[type="importmap"]');
  if (!el) return {};
  try {
    return JSON.parse(el.textContent ?? "{}");
  } catch {
    return {};
  }
}

// Resolve each script to runnable classic code: external src is fetched, and
// module scripts are bundled (import graph → classic IIFE) via the host fetcher.
async function loadScripts(fetchHtml, document, baseUrl) {
  const items = extractScripts(document, baseUrl);
  const importMap = readImportMap(document);
  const out = [];
  for (const it of items) {
    const resolved = await resolveScript(fetchHtml, it, baseUrl, importMap);
    if (resolved) out.push(resolved);
  }
  return out;
}

async function resolveScript(fetchHtml, it, baseUrl, importMap) {
  if (it.module) return resolveModule(fetchHtml, it, baseUrl, importMap);
  if (it.code != null) return it;
  const code = await fetchScript(fetchHtml, it.url);
  return code == null ? null : { code, module: false };
}

// Bundle a module script's import graph to classic code; skip if esbuild absent.
async function resolveModule(fetchHtml, it, baseUrl, importMap) {
  const entry = it.code != null ? it.code : `import ${JSON.stringify(it.url)};`;
  try {
    return { code: await bundleModule(entry, baseUrl, fetchHtml, importMap), module: false };
  } catch {
    return null; // esbuild missing or bundle failed → module skipped
  }
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
    // Record every URL the page pulls during render (scripts, module deps, fetch,
    // XHR) so a crawl can follow them. Crawler filters by host/allow.
    const discovered = [];
    const recording = (u, o) => {
      discovered.push(u);
      return fetchHtml(u, o);
    };
    const env = createEnvironment(res.html);
    const scripts = await loadScripts(recording, env.document, res.finalUrl);
    const backend = await backendPromise;
    const html = await backend.render(res.html, scripts, {
      ...opts,
      url: res.finalUrl,
      hostFetch: recording,
    });
    if (opts.onRequest) for (const u of discovered) opts.onRequest(u);
    return { ...res, html, discovered };
  }

  return {
    fetchHtml: renderFetch,
    async close() {
      await (await backendPromise).close();
    },
  };
}
