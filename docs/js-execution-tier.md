# Design: No-Chromium JS-Execution Tier

> Status: **spec / not built**. Decision pending.
> Supersedes the §11 "Lane B" Chromium fallback. Chromium remains a **dev-only**
> differential oracle (`test/differential.test.mjs`), never a runtime dependency.

## Goal

Render pages that genuinely require JavaScript — SPA shells that ship an empty
`<div id="root">` and build the DOM at runtime — **without a browser**. Run the
page's own scripts against a DOM, let them settle, then snapshot the resulting
DOM and feed turbo-crawl's existing extraction (`interactiveElements`,
`markdown`, `hydrationState`, `extract`, …).

This is the second half of replacing Lane B. The first half — `extractHydration
State()` — already recovers most framework data with **zero** JS execution
(`__NEXT_DATA__`, JSON-LD, `__APOLLO_STATE__`, …). The JS tier is for the
residual: pages with no server-embedded state that only materialize via JS.

## Why this is hard

1. **Executing arbitrary remote JS is hostile-code execution.** A crawled page's
   script can attempt host escape, prototype pollution, resource exhaustion.
   Isolation level is the central decision.
2. **The DOM has to live somewhere the page JS can mutate cheaply.** turbo-dom's
   `window`/`document` are plain host-isolate JS objects. Whatever runs the page
   JS must reach those objects *without* a marshalling boundary on every DOM op,
   or rendering is unusably slow.
3. **Real framework bundles need a real DOM.** React/Vue/Next runtimes exercise a
   wide DOM/Web-API surface. A "minimal DOM shim" will not run them; turbo-dom
   (or jsdom) is the thing that does. So the DOM used must *be* turbo-dom.

(2) and (3) together are the crux: **the renderer must use turbo-dom, and the JS
must reach turbo-dom's objects directly.** That constraint is what rules options
in or out below.

## Execution model (common to all options)

```
fetch HTML (Lane A, with cookies/UA)
  → createEnvironment(html)                     # turbo-dom DOM
  → install window/document/timers/fetch as globals   # installGlobals()
  → override fetch/XHR → route via net.mjs (jar, UA, redirects)
  → run classic <script>s:                      # turbo-dom does NOT auto-run scripts
        inline  → run in context
        src=... → fetch then run, in document order
  → settle: drain microtasks + bounded setTimeout loop until quiescent
            or a wall-clock budget (e.g. 2s) elapses
  → snapshot document.documentElement.outerHTML
  → re-parse in host turbo-dom (clean) → existing extraction
```

turbo-dom facts that make this viable (verified):
- `installGlobals(target, { html, url })` installs window/document + **211**
  globals (incl. `setTimeout`, `queueMicrotask`, `fetch`) onto any target object.
- turbo-dom has **no** internal script runner (`grep runScripts` → none), so we
  fully control which scripts execute and when. No surprise execution.
- turbo-dom's test environments already render React/Vue into its DOM, so its DOM
  is known to survive real framework runtimes.

Known v1 limitations (independent of isolation choice):
- **ES module scripts** (`<script type="module">`, `import`) need
  `vm.SourceTextModule` + a loader; defer, mark unsupported in v1.
- Web APIs turbo-dom doesn't stub → partial render for pages that depend on them.
- Non-deterministic time/random → snapshot is best-effort, not pixel-faithful
  (we don't do pixels anyway).

## Options

### A. `isolated-vm` (true V8 isolate)

Genuine memory/host isolation: guest code runs in a separate isolate and can only
touch host objects through explicit `Reference`/`ExternalCopy` marshalling.

- **Safety:** strongest. Hostile code cannot reach the host heap.
- **Blocker:** turbo-dom's DOM lives in the **host** isolate. Page JS in the guest
  cannot touch it except via ivm marshalling — thousands of boundary crossings
  per render. `installGlobals` (host objects on the global) **does not apply**.
- **To make it work**, one of:
  - **A1 — DOM inside the isolate.** Ship a DOM implementation *into* the isolate
    so page JS mutates an in-isolate DOM; only the result **HTML string** crosses
    back; host turbo-dom re-parses it. Clean and safe, but the in-isolate DOM must
    be real enough to run framework bundles — i.e. turbo-dom's runtime must load
    inside a bare isolate (no Node `require`, native parser unavailable).
    → **turbo-dom seam needed:** a build of the turbo-dom runtime that initializes
    inside a bare isolate, fed a pre-parsed SoA buffer from the host (host parses
    with the native/wasm parser, passes the typed-array buffer across as an
    `ExternalCopy`; the in-isolate runtime builds the lazy DOM over it). This is a
    real turbo-dom feature.
  - **A2 — bridge host DOM via ivm.** Reject: per-op marshalling, too slow.
- **Cost:** native dependency (compiles per platform — contradicts turbo-crawl's
  "zero native artifacts of our own"); multi-week; needs the A1 turbo-dom seam.
- **Verdict:** the eventually-correct hardened path, but a project, not a step.

#### A3 — turbo-dom (WASM) **inside** the isolate ← the clean true-isolate path

turbo-dom already ships a **WASM** parser build (`pkg-web/`, the `./parser-wasm`
export, `npm run build:wasm:web`) — its runtime is pure JS and the only native
piece (the html5ever parser) also exists as WebAssembly. `isolated-vm` isolates
can compile/instantiate WebAssembly. So the whole turbo-dom runtime can run
**inside the isolate**:

```
host: fetch HTML (Lane A)                       # cookies/UA/redirects
  → spawn/borrow an ivm Isolate + Context
  → into the isolate, once per worker/isolate:
        - the turbo-dom runtime JS (bundled for a bare isolate)
        - the turbo-dom parser .wasm bytes (ExternalCopy → WebAssembly.instantiate)
  → into the isolate, per page: the HTML string + page <script> sources
  → in-isolate: createEnvironment(html); installGlobals(globalThis);
        run scripts; drain microtasks + bounded timers
  → return ONLY document.documentElement.outerHTML (a string) across the boundary
host: re-parse the returned HTML with turbo-dom → existing extraction
```

Why this is the best of A and B:
- **Safety of A:** page JS runs in a real V8 isolate; the host heap is unreachable;
  only an HTML **string** ever crosses out.
- **DOM perf of B:** page JS mutates a real in-isolate turbo-dom DOM **directly** —
  no per-op marshalling (the thing that killed A2).
- No need to host-parse-then-ship-a-SoA-buffer (the earlier A1 seam); the isolate
  parses its own HTML via the WASM parser.

Costs / unknowns:
- `isolated-vm` is still a **native dependency** (compiles per platform) — but it's
  the *only* native artifact, and it isolates hostile code; weigh against the
  "zero native artifacts of our own" rule.
- **turbo-dom seam (smaller than A1):** a runtime bundle that initializes in a
  bare isolate — no Node `require`/`process`, WASM instantiated from injected
  bytes rather than `fs`/`fetch`, and any Node-isms in the runtime shimmed. The
  owner offered turbo-dom changes; "an isolate-target build that takes the parser
  wasm bytes as input" is the ask.
- `fetch`/XHR for page-initiated data must be bridged out of the isolate to the
  host net layer via an ivm callback (async `Reference.apply`) — bounded surface,
  returns strings/JSON.

This likely **leapfrogs B**: same Chromium-free goal, but a genuine isolate. The
tradeoff is the native `isolated-vm` dep + the turbo-dom isolate-bundle seam vs.
B's pure-Node-but-weaker worker isolation.

### B. `worker_thread` + `node:vm`  ← pragmatic v1 (no native dep, no turbo-dom change)

Run turbo-dom + a `node:vm` context **inside a `worker_thread`**. turbo-dom works
normally (full Node available in the worker); the page JS runs in a `vm` context
within that worker; a hard timeout **terminates the worker** on runaway/hostile
JS.

- **Safety:** process/thread-level. The worker has its own heap; the host posts in
  an HTML string and gets back an HTML string (or a structured snapshot). `node:vm`
  is not a true sandbox, but the worker is **killable** and carries no host
  references; cap CPU time (terminate after budget), memory (`resourceLimits`),
  and disallow `require`/`process` reach inside the vm context.
- **DOM:** turbo-dom runs in the worker; page JS reaches its objects directly via
  `installGlobals` on the vm context — **no marshalling**, full speed.
- **Cost:** pure Node, **no native dep**. Plumbing = worker bootstrap + message
  protocol (html+url+cookies in → snapshot+discovered-requests out) + lifecycle
  (pool or per-render worker, kill on timeout).
- **turbo-dom seam needed:** none. Uses `installGlobals` as-is.
- **Verdict:** ships real SPA rendering in days, pure Node, killable isolation.
  Weaker than a true isolate, but the right pragmatic v1; A is the v2 hardening.

### C. `node:vm` in-process

Same as B without the worker. Fastest, simplest, **no isolation** — hostile JS
shares the host heap. Rejected for a crawler that runs untrusted code.

## Comparison

| | Safety | DOM perf | New dep | turbo-dom change | Time |
|---|---|---|---|---|---|
| A isolated-vm (A1) | true isolate | needs in-isolate DOM | native (ivm) | **yes** (runtime-in-isolate) | weeks |
| **B worker+vm** | killable thread | native (direct) | none | none | days |
| C vm in-process | none | native (direct) | none | none | hours |

## Recommendation

Ship **B** as the JS-execution tier v1 (killable worker, pure Node, turbo-dom
direct). Treat **A1** as v2 hardening for running fully-hostile targets, gated on
a turbo-dom "runtime-in-isolate over a host-parsed buffer" seam. Keep **C**
available only behind an explicit `unsafe: true` for trusted-target speed.

API sketch (unchanged surface — it's just another `fetchHtml`):

```js
import { jsFetcher } from "turbo-crawl/render";       // worker-backed
const { fetchHtml, close } = jsFetcher({ timeoutMs: 2000, poolSize: 4 });
const page = new Page({ fetchHtml });                  // same Page API
// Crawler routing: { fallback: jsFetcher().fetchHtml } when detectJsRequired() trips
```

## Open questions

1. Worker lifecycle: pool of N warm workers vs per-render spawn (warm pool reuses
   turbo-dom env; per-render is simpler + more isolated). Lean pool.
2. Quiescence heuristic: fixed budget vs "no pending timers/microtasks/in-flight
   fetch for K ms". Start with budget + network-idle.
3. `fetch` routing: page-initiated requests through `net.mjs` (cookies/robots/UA)
   — and whether those discovered URLs feed the crawl frontier.
4. Module scripts: when to invest in `vm.SourceTextModule` (many modern SPAs are
   ESM).
5. The turbo-dom A1 seam: is "build runtime over a host-supplied SoA buffer inside
   a bare isolate" something turbo-dom wants to expose? (Owner offered turbo-dom
   changes.)
