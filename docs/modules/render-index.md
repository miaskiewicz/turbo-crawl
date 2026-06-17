# `src/render/index.mjs` — JS-execution render tier entry point (`jsRenderer`)

## Responsibility
Turns a no-JS fetch into a *rendered* fetch: it fetches the raw HTML, runs the
page's scripts against turbo-dom (no browser), and returns the populated DOM as
HTML so all existing extraction runs over a rendered page. It owns:
- backend selection by `mode` (`"secure"` default vs `"fast"`),
- collecting and resolving the page's executable scripts (classic + module
  bundling + import maps),
- a `recording` fetch wrapper that records every URL the page pulls during render
  so a crawl can follow them.

## Exports / API
- `jsRenderer(opts = {}) → { fetchHtml, close }`
  - `opts.mode` — `"secure"` (default) or `"fast"`.
  - `opts.fetchHtml` — underlying Lane-A host fetcher; defaults to
    `fetchHtml` from `../net.mjs`.
  - `opts.timeoutMs` — per-script execution cap (passed through to backends).
  - `opts.settleMs` — settle tick between timer-drain rounds (fast backend).
  - `opts.onRequest` — optional callback invoked once per discovered URL after a
    render.
  - `opts.netHooks` — Playwright-façade request/response hooks; the nav fetch and
    page-initiated fetch/XHR (via `page-fetch`) emit through them.
  - `opts.storage` / `opts.storageFor(url)` — persistent Web Storage handed to the
    fast backend (`storageFor` resolves it per final URL / origin).
  - `opts.initScripts` — code strings run before any page script (addInitScript).
  - `opts.hooks` — `{ onConsole, onPageError }` console/error capture (fast backend).
  - **Cookie threading**: `renderFetch` passes `fetchOpts.jar`/`cache` into the
    `recording` fetcher, so in-render script/fetch/XHR requests send `Cookie` and
    ingest `Set-Cookie` (session persists across navigations), not just the nav.
  - Returned `fetchHtml(url, fetchOpts)` is drop-in for `new Page({ fetchHtml })`
    and for a Crawler `{ fallback }`. Returns `{ ...res, html, discovered }` where
    `html` is the rendered HTML and `discovered` is the list of URLs the page
    pulled during render.
  - Returned `close()` disposes the backend.

## Key internals
- `makeBackend(mode)` — dynamically imports `./backend-fast.mjs`
  (`createFastBackend()`) for `"fast"`, otherwise `./backend-secure.mjs`
  (`createSecureBackend()`). Secure is the default for any non-`"fast"` mode. The
  backend is created once (`backendPromise`) and reused across renders.
- `loadScripts(fetchHtml, document, baseUrl)` — `extractScripts` (from
  `scripts.mjs`) pulls executable `<script>`s in source order, then each is
  resolved to runnable classic code via `resolveScript`.
- `resolveScript` — inline classic scripts pass through; external classic scripts
  are fetched (`fetchScript`); module scripts go to `resolveModule`.
- `resolveModule` — builds an entry (inline code, or `import "<url>";` for
  external module scripts) and bundles its import graph to a classic IIFE via
  `bundleModule` (esbuild). On any failure (esbuild missing or bundle error) the
  module is **skipped** (returns `null`), never aborting the render.
- `readImportMap(document)` — reads the `<script type="importmap">` JSON blob (or
  `{}`); passed into module bundling.
- `recording(u, o)` wrapper inside `renderFetch` — pushes every requested URL
  into `discovered` and delegates to the host fetcher. It is the fetcher passed to
  both `loadScripts` (script + module-dep fetches) and the backend as `hostFetch`
  (page-initiated `fetch`/XHR), so every render-time request is recorded.
- `createEnvironment(res.html)` (turbo-dom runtime) builds a host-side document
  used only to extract scripts/import map; scripts are run by the backend.

## Depends on / used by
- Depends on: `@miaskiewicz/turbo-dom/runtime` (`createEnvironment`), `../net.mjs`
  (`defaultFetchHtml`), `./bundle-modules.mjs` (`bundleModule`), `./scripts.mjs`
  (`extractScripts`), and lazily `./backend-fast.mjs` / `./backend-secure.mjs`.
- Used by: anything wanting a rendering fetcher — `Page`, the Crawler fallback.

## Invariants & gotchas
- **Secure is the default.** Only `mode === "fast"` selects the in-process
  backend; everything else (including `undefined`) is secure.
- Module scripts are only run if esbuild is available; otherwise they are silently
  skipped — a no-esbuild install still renders classic scripts.
- A missing/broken external script is swallowed (`fetchScript` returns `null`) and
  must not abort the render.
- `onRequest` fires after the render completes, once per discovered URL (not
  streamed during fetch). The crawler is responsible for host/allow filtering.

## Example
```js
import { jsRenderer } from "turbo-crawl/render";

const r = jsRenderer({ mode: "secure" });
const res = await r.fetchHtml("https://example.com/app");
// res.html  -> rendered DOM
// res.discovered -> URLs the page fetched while rendering
await r.close();
```
