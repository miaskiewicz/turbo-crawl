# `src/render/isolate-entry.mjs` — in-isolate render driver (runs INSIDE isolated-vm)

## Responsibility
Runs **inside** the isolated-vm isolate (bare V8 — no Node, no host objects).
esbuild bundles this file + turbo-dom's runtime + the WASM parser glue into one
IIFE that the host evaluates in the isolate. It exposes a few globals the host
calls over the ivm boundary to drive a render. The host only ever gets a **string**
back.

## Exports / API
This module exports nothing; it installs **globals** on the isolate's
`globalThis`, each invoked by the host (`backend-secure.mjs`) via `callGlobal`:
- `__tcInit(wasmBytes)` — `initSync` the WASM parser from injected bytes, then
  `setParser({ parse, parseBuffer, parseFragment })` to register it with
  turbo-dom. Called once at boot.
- `__tcSetup(html, url)` — `installGlobals(globalThis, { html, url })` to build the
  DOM + window/document, record `__tcBase`, and shim timers + fetch/XHR (see
  below). Called once per render.
- `__tcRun(src)` — execute one page-script source in global scope via indirect
  `eval` (`(0, eval)(src)`), so it sees the installed globals/document.
- `__tcDrainTimers()` — run all currently-queued timer callbacks (one round,
  sorted by delay) and return how many timers were queued *during* this round, so
  the host can decide whether to drain again.
- `__tcSnapshot()` — serialize the (mutated) DOM:
  `<!DOCTYPE html>\n${document.documentElement.outerHTML}` or `""`.

## Key internals
- **Timer queue** (`timers` array): a bare isolate has no `setTimeout`.
  `__tcSetup` installs `setTimeout(cb, delay)` → pushes `{ cb, delay }` and returns
  a fake id; `clearTimeout` no-op; `setInterval` → `0` (no-op, since intervals
  would never settle); `clearInterval` no-op. `__tcDrainTimers` splices the queue,
  sorts by delay (delay used **only for ordering**), runs each (throws swallowed),
  and returns the count newly queued.
- **fetch bridge** — when `__tcHostFetch` (an ivm Reference set by the host) is
  present, `__tcSetup` installs `fetch = isolateFetch` and `XMLHttpRequest =
  makeIsolateXHR()`.
  - `isolateFetch(input, init)` resolves the URL, then calls
    `__tcHostFetch.applySyncPromise(undefined, [url, method, body])` which
    **blocks the isolate thread** until the host request resolves, so `await
    fetch()` settles in-band. Returns a Response-like (`ok`, `status`, `url`,
    `text()`, `json()`) parsed from the host's JSON string.
  - `makeIsolateXHR()` is a synchronous-bridge XHR: `send` calls `applySyncPromise`
    inline, sets `status`/`responseText`/`response`, then fires completion
    callbacks on a microtask (`Promise.resolve().then(finishXhr)`).
- `resolveUrl(input)` resolves against `__tcBase` (the page URL), falling back to
  the raw string.

## Depends on / used by
- Depends on (bundled into the isolate): `@miaskiewicz/turbo-dom/install`
  (`installGlobals`), `@miaskiewicz/turbo-dom/parser-wasm` (`parse`,
  `parseBuffer`, `parseFragment`, `initSync`), `@miaskiewicz/turbo-dom/runtime`
  (`setParser`). Requires the `TextEncoder`/`TextDecoder` polyfills evaluated
  before the bundle (see `isolate-polyfills.mjs`).
- Used by: `src/render/backend-secure.mjs`, which esbuild-bundles this as the
  isolate entry and calls these globals.

## Invariants & gotchas
- **No host objects.** The only bridge to the host is the `__tcHostFetch`
  Reference, accessed via `applySyncPromise`; everything else is pure in-isolate
  state. The host gets only strings back.
- `applySyncPromise` **blocks the isolate thread** — page `fetch`/XHR appear
  synchronous to the timer/microtask machinery, which is why XHR completion
  callbacks fire on a microtask rather than a real loop turn.
- `setInterval` is intentionally a no-op (returns `0`) — an interval would never
  let the render settle.
- Timer `delay` is only a sort key; there is no real time, and rounds are bounded
  by the host (`drainTimers` in `backend-secure.mjs`, default 5).
- `__tcRun` swallows nothing itself; the host's `runScripts` swallows page-script
  throws. Timer-callback throws are swallowed here in `__tcDrainTimers`.

## Example (host-side calls, conceptually)
```js
// inside the isolate, the host invokes:
__tcInit(wasmBytes);          // once, at boot
__tcSetup(html, url);         // per render
__tcRun(scriptSource);        // per classic script
while (__tcDrainTimers()) {}  // until no timers remain (host bounds rounds)
const html = __tcSnapshot();  // rendered DOM string back to host
```
