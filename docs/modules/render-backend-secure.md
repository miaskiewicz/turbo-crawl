# `src/render/backend-secure.mjs` — secure render backend (isolated-vm + turbo-dom WASM)

## Responsibility
Runs page scripts inside a **true V8 isolate** (`isolated-vm`) where turbo-dom
runs on its **WASM** parser. Hostile-code safe: the guest isolate cannot reach the
host heap; only HTML/JSON strings cross the boundary. This is the default backend,
for open-web crawling. `isolated-vm` + `esbuild` are optional (native-build) deps.

## Exports / API
- `createSecureBackend(opts = {}) → { render, close }`
  - `opts.memoryLimit` — isolate memory cap in MB (default `256`).
  - `render(html, scripts, renderOpts = {}) → Promise<string>` — returns rendered
    HTML string (`__tcSnapshot` output).
    - `renderOpts.url` — page URL (passed to the isolate as the document base).
    - `renderOpts.hostFetch` — host net fetcher; when present, a `fetchBridge`
      Reference is installed as `__tcHostFetch` so guest `fetch`/XHR work.
    - `renderOpts.settleRounds` — max timer-drain rounds (default `5`).
  - `close()` — disposes the isolate and resets readiness.

## Key internals
- **Boot is lazy and cached** via `ensure()` (`ready` promise). It dynamically
  imports `isolated-vm`, builds the isolate bundle, reads the WASM bytes, then
  `bootIsolate`.
- `isolateBundle()` — esbuild bundles `./isolate-entry.mjs` (+ turbo-dom runtime +
  WASM glue) into a single ESM string the isolate can compile. `format: "esm"`,
  `platform: "neutral"`, `external: ["node:module"]` (a guarded dynamic import
  that no-ops in a bare isolate). Built once, cached in `bundlePromise`.
- `wasmBytes()` — resolves `@miaskiewicz/turbo-dom`'s
  `pkg-web/turbo_dom_parser_bg.wasm` (the isolate-loadable web build) and reads
  the raw bytes.
- `bootIsolate(ivm, bundle, wasm, memoryLimit)`:
  1. `new ivm.Isolate({ memoryLimit })` + `createContext()`.
  2. sets `globalThis` to the context global (`derefInto`).
  3. evals `POLYFILLS` (from `isolate-polyfills.mjs` — TextEncoder/Decoder the
     wasm-bindgen glue needs).
  4. compiles + instantiates the bundle. The instantiate resolver **throws** on
     any import (`"turbo-crawl: unexpected import in isolate bundle"`) — the
     bundle is self-contained, so this line should be unreachable; it is a guard.
  5. evaluates the module, then calls `__tcInit(wasm)` (copy-args) to init the
     WASM parser from the injected bytes and register it with turbo-dom.
- `fetchBridge(ivm, hostFetch)` — wraps the host fetcher in an `ivm.Reference`.
  The guest invokes it via `applySyncPromise`; the host runs the request and
  returns `JSON.stringify({ status, body })` (or `{ status: 0, body: "" }` on
  error). **No host objects cross — only a JSON string.**
- `callGlobal(context, name, args)` — gets the named global as a Reference and
  applies it with `arguments: { copy: true }, result: { copy: true }`.
- Per-render flow in `render`:
  1. install `__tcHostFetch` (fetchBridge) if `hostFetch` given,
  2. `__tcSetup(html, url)` — build DOM + install globals + shim timers/fetch,
  3. `runScripts` → `__tcRun(code)` per classic script (modules skipped; a throw
     is swallowed),
  4. `drainTimers` → `__tcDrainTimers()` up to `settleRounds` times, stopping
     early when no timers remain,
  5. `__tcSnapshot()` → returns rendered HTML.

## Depends on / used by
- Depends on (optional): `isolated-vm`, `esbuild`. Always: `node:fs`,
  `node:module`, `node:url`, `./isolate-polyfills.mjs`, and the bundled
  `./isolate-entry.mjs` + `@miaskiewicz/turbo-dom` web build / WASM.
- Used by: `src/render/index.mjs` (default backend).

## Invariants & gotchas
- **Host heap is unreachable from the guest.** Only HTML/JSON strings cross the
  ivm boundary; the only host capability exposed is the `__tcHostFetch`
  Reference, and even that returns a JSON string.
- The instantiate import resolver throwing is a **boot guard** — it should never
  fire because esbuild produces a self-contained bundle.
- `bundlePromise` caches the esbuild output process-wide; the isolate itself is
  cached in `ready` and reused across renders until `close()`.
- ESM module scripts are not run here either (`s.module` skipped) — `index.mjs`
  pre-bundles modules to classic code.
- Timers don't run on a real loop: the isolate **queues** `setTimeout` callbacks
  and the host drains them in bounded rounds; `setInterval` is a no-op (would
  never settle).

## Example
```js
import { createSecureBackend } from "turbo-crawl/render/backend-secure";

const backend = createSecureBackend({ memoryLimit: 256 });
const html = await backend.render(rawHtml, scripts, {
  url: "https://example.com/app",
  hostFetch,
});
await backend.close(); // disposes the isolate
```
