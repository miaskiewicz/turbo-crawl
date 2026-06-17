# `src/render/backend-fast.mjs` — fast in-process render backend (node:vm + native turbo-dom)

## Responsibility
Runs page scripts in an in-process `node:vm` context backed by the **native**
turbo-dom parser. It is the fastest render path but provides **NO hostile-code
isolation** — the vm shares the host heap. Intended for local testing / trusted
targets only; open-web crawling should use the secure (isolated-vm) backend.

## Exports / API
- `createFastBackend() → { render, close }`
  - `render(html, scripts, opts = {}) → Promise<string>` — returns rendered
    `outerHTML` (with a `<!DOCTYPE html>` prefix), or `""` if no document root.
    - `opts.url` — page URL (passed to `installGlobals` and the host fetch).
    - `opts.hostFetch` — host net fetcher; when present, `fetch` +
      `XMLHttpRequest` are injected into the sandbox.
    - `opts.timeoutMs` — per-script execution cap (default `2000`).
    - `opts.settleMs` — sleep per settle round (default `1`).
    - `opts.settleRounds` — minimum settle rounds (default `5`).
    - `opts.maxRounds` — max settle rounds (default `50`).
  - `close()` — no-op (no resources to release).

## Key internals
- `installGlobals(sandbox, { html, url })` (from `@miaskiewicz/turbo-dom/install`)
  populates the sandbox object with `window`/`document`/etc backed by the native
  parser; `vm.createContext(sandbox)` turns it into a vm context.
- Host-backed I/O: when `opts.hostFetch` is set, `sandbox.fetch =
  makePageFetch(...)` and `sandbox.XMLHttpRequest = makeXHR(...)` (from
  `page-fetch.mjs`), both wired to a shared `state = { pending: 0 }` counter.
- `runScripts(sandbox, scripts, timeoutMs)` — runs each classic script via
  `vm.runInContext` with the timeout. **ESM module scripts are skipped**
  (`s.module || s.code == null`). A script throwing is swallowed so it never
  aborts the render (browser semantics).
- `settle(state, opts)` — loops letting microtasks + host-backed timers run; it
  runs at least `min` (settleRounds) rounds and keeps going while `state.pending >
  0`, bounded by `max` (maxRounds) so a hung request can't stall the render. Each
  round sleeps `ms` (settleMs) via a real `setTimeout`.
- Snapshot: `sandbox.document?.documentElement.outerHTML` prefixed with the
  doctype.

## Depends on / used by
- Depends on: `node:vm`, `@miaskiewicz/turbo-dom/install` (`installGlobals`),
  `./page-fetch.mjs` (`makePageFetch`, `makeXHR`).
- Used by: `src/render/index.mjs` `jsRenderer({ mode: "fast" })`.

## Invariants & gotchas
- **No isolation.** The vm context shares the host heap; never run untrusted /
  open-web pages here. Use `backend-secure.mjs` for that.
- Module scripts (`type=module`) are never executed by this backend — `index.mjs`
  bundles them to classic IIFEs before they reach here, but a residual
  `s.module` item is skipped.
- The settle loop relies on **real host timers**; this backend uses the host
  event loop directly (unlike the isolate backend, which queues timers and drains
  them in rounds).
- `state.pending` is the only settle signal for I/O — code that fetches without
  going through the injected `fetch`/`XHR` won't be waited on.

## Example
```js
import { createFastBackend } from "turbo-crawl/render/backend-fast";

const backend = createFastBackend();
const html = await backend.render(rawHtml, scripts, {
  url: "https://localhost/app",
  hostFetch,
});
await backend.close();
```
