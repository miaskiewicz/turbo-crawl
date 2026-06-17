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

import { fetchHtml as defaultFetchHtml } from "../net.mjs";
import { bundleModule } from "./bundle-modules.mjs";
import { extractScriptsFromHtml, readImportMapFromHtml } from "./scripts.mjs";

async function makeBackend(mode) {
  if (mode === "fast") return (await import("./backend-fast.mjs")).createFastBackend();
  return (await import("./backend-secure.mjs")).createSecureBackend();
}

// Resolve each script to runnable classic code: external src is fetched, and
// module scripts are bundled (import graph → classic IIFE) via the host fetcher.
// Scripts are listed by a string scan (no DOM parse) — the backend parses for real.
async function loadScripts(fetchHtml, html, baseUrl) {
  const items = extractScriptsFromHtml(html, baseUrl);
  const importMap = readImportMapFromHtml(html);
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
  // Keep url + rawSrc + async/defer: runtimes read currentScript.getAttribute('src')
  // (raw attr) for chunk paths, and async/defer drives execution order (the backend
  // runs sync → defer → DOMContentLoaded → async → load, mirroring the browser).
  return code == null
    ? null
    : { code, module: false, url: it.url, rawSrc: it.rawSrc, async: it.async, defer: it.defer };
}

// Bundle a module script's import graph to classic code; skip if esbuild absent.
// Module scripts are deferred by spec — run after parse, before DOMContentLoaded.
async function resolveModule(fetchHtml, it, baseUrl, importMap) {
  const entry = it.code != null ? it.code : `import ${JSON.stringify(it.url)};`;
  try {
    const code = await bundleModule(entry, baseUrl, fetchHtml, importMap);
    return { code, module: false, url: it.url, rawSrc: it.rawSrc, defer: true };
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
// The Playwright-shaped request record for a top-level navigation.
function navRequest(url, fetchOpts) {
  return {
    url,
    method: (fetchOpts.method ?? "GET").toUpperCase(),
    headers: fetchOpts.headers ?? {},
    postData: fetchOpts.body ?? null,
    resourceType: "document",
  };
}

// Emit the navigation's `response`/`requestfinished` to the façade hooks.
function emitNav(netHooks, req, res) {
  if (!netHooks) return;
  netHooks.onResponse?.({
    url: res.finalUrl,
    status: res.status,
    headers: res.headers,
    body: res.html ?? "",
    request: req,
  });
  netHooks.onRequestFinished?.(req);
}

export function jsRenderer(opts = {}) {
  const fetchHtml = opts.fetchHtml ?? defaultFetchHtml;
  const backendPromise = makeBackend(opts.mode ?? "secure");

  async function renderFetch(url, fetchOpts = {}) {
    const navReq = navRequest(url, fetchOpts);
    opts.netHooks?.onRequest?.(navReq);
    const res = await fetchHtml(url, fetchOpts);
    emitNav(opts.netHooks, navReq, res);
    // Record every URL the page pulls during render (scripts, module deps, fetch,
    // XHR) so a crawl can follow them. Crawler filters by host/allow. Thread the
    // session jar so in-render requests send Cookie + ingest Set-Cookie.
    const discovered = [];
    const recording = (u, o = {}) => {
      discovered.push(u);
      return fetchHtml(u, { ...o, jar: fetchOpts.jar, cache: fetchOpts.cache });
    };
    const scripts = await loadScripts(recording, res.html, res.finalUrl);
    const backend = await backendPromise;
    const html = await backend.render(res.html, scripts, {
      ...opts,
      url: res.finalUrl,
      hostFetch: recording,
      storage: opts.storageFor ? opts.storageFor(res.finalUrl) : opts.storage,
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
