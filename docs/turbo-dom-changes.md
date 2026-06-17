# turbo-dom changes required by turbo-crawl

> Short answer: **none are required today.** Everything turbo-crawl ships uses
> turbo-dom's public API as-is. The only potential turbo-dom change is for the
> *true-isolate (v2)* variant of the JS-execution tier, which we have not built.

## Status by capability

### Current library (Lane A: fetch + parse + extract + interact)
**No turbo-dom changes.** Consumes `createEnvironment`, `env.reset`,
`querySelectorAll`/`querySelector`, `getAttribute`, `getComputedStyle`,
`textContent`/`outerHTML`/`innerHTML`, and `document.__cookieJar` (documented
seam) / `window.navigator` (writable) — all public/seam surface.

### JS-execution tier — v1 (worker_thread + node:vm)
**No turbo-dom changes needed.** Verified by direct probe against the installed
turbo-dom: page scripts can build the DOM the way a framework bundle does, and
turbo-dom reflects it. Evidence (all ✓):

| Needed by page scripts | turbo-dom | Note |
|---|---|---|
| `document.createElement` / `createTextNode` | ✓ | |
| `el.appendChild` / `setAttribute` / `classList` | ✓ | |
| `el.addEventListener` + `dispatchEvent` | ✓ | listener fires |
| `document.getElementById` / `querySelector` | ✓ | finds script-created nodes |
| `el.innerHTML =` (parse + insert) | ✓ | |
| mutation reflected in `documentElement.outerHTML` | ✓ | snapshot sees it |
| `window.setTimeout` / `queueMicrotask` | ✓ | timers fire on the worker loop |
| `window` globals (matchMedia, localStorage, IntersectionObserver, rAF, …) | ✓ | turbo-dom ships ~211 globals + `installGlobals(target, {html,url})` |
| `window.fetch` / `XMLHttpRequest` | stub | we **override** these to route via turbo-crawl's net layer (cookies/UA/robots) — a turbo-crawl concern, **not** a turbo-dom change |

So v1 is buildable purely on the existing turbo-dom. turbo-dom also has **no
internal script runner** (no auto-execution), which is exactly what we want — we
control which scripts run and when.

Caveat (coverage, not a turbo-dom *change*): some pages exercise Web APIs
turbo-dom stubs shallowly (e.g. layout-dependent reads, `MutationObserver`
timing). Those render partially. If a specific high-value API proves missing in
practice, that becomes a concrete, additive turbo-dom request — but none is known
to be required up front.

### JS-execution tier — v2 (isolated-vm, true V8 isolate)
Running hostile page JS in a genuine V8 isolate means turbo-dom's runtime must run
**inside** the isolate (a bare V8 — no Node, no filesystem, no native addon).
Investigated against the installed turbo-dom; the result is **smaller than first
assumed**. Almost everything v2 needs already exists:

| v2 requirement | turbo-dom today | change? |
|---|---|---|
| WASM parser usable in-isolate | `pkg-web/` (`--target web`); `initSync(module)` / `__wbg_init(bytes)` accept a `BufferSource`/`WebAssembly.Module` and only `fetch` when handed a URL/undefined | **none** — instantiate from injected bytes |
| Inject the in-isolate parser binding | `setParser(binding)` / `globalThis.__TURBO_DOM_PARSER__` (`src/runtime/parser.mjs`) | **none** — seam exists |
| `process` reads | already `typeof process !== 'undefined'` guarded | **none** |
| **Runtime loads in a bare isolate** | **BLOCKER:** `src/runtime/window.mjs:204` has a *static* `import { performance } from 'node:perf_hooks'` — a `node:` import throws at module load in an isolate | **required, 1 line** |
| `btoa`/`atob` (if a page calls them) | `window.mjs:347` uses Node global `Buffer.from` (function body, not import) | optional guard |

**Required change (one line).** Replace the static node import:

```js
// src/runtime/window.mjs:204  (current — breaks isolate load)
import { performance as nodePerformance } from 'node:perf_hooks';
function performanceNow() { return nodePerformance.now(); }

// proposed — no Node-ism, identical behavior in Node/browser
const performanceNow = () => globalThis.performance?.now?.() ?? Date.now();
```

Note the comment two lines below the offending import already states the runtime
is meant to "load & run in a bare V8 lacking web-platform globals" — so this
static `node:` import reads as an oversight, not a design choice.

**Optional change.** Make the `btoa`/`atob` stubs not depend on the Node `Buffer`
global (pure-JS base64, or `typeof Buffer !== 'undefined'` guard) so isolate-run
pages that call `btoa` don't throw.

Everything else for v2 (script execution, settling, fetch bridging across the
isolate boundary, snapshotting) is turbo-crawl-side.

## Summary

| Path | turbo-dom change |
|---|---|
| Current library | none |
| JS tier v1 (worker + vm) | none |
| JS tier v2 (isolated-vm) | **one line** (drop the static `node:perf_hooks` import in `window.mjs:204`) + optional `btoa`/`Buffer` guard |

v2 does **not** need a new build target — the existing `pkg-web` WASM build and
the `setParser` injection seam already cover it. The only hard requirement is
removing the single static `node:` import so the runtime can load in a bare
isolate; that change is additive and behavior-neutral in Node and the browser.
