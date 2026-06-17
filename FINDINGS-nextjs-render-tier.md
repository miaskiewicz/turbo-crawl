# Render-tier findings: running a Next.js 15 (App Router, Turbopack) app

Date: 2026-06-17
Engine: `@miaskiewicz/turbo-crawl@0.1.1`, `fast` backend (`node:vm` + turbo-dom)
Target: Flux payroll-app — Next.js 15 App Router, Turbopack dev server, React 19,
MUI, TanStack Query, PostHog. Goal: drive the Playwright e2e suite (selectors are
all `getByTestId` → `data-test-id`) through the `/playwright` façade.

**TL;DR.** The façade + JS-render tier wire up correctly. Chunk URLs resolve and
all chunks are fetched. But the app never hydrates, so **0 `data-test-id` nodes**
appear and every e2e spec fails at its first locator. Two distinct bugs, in order:

1. **CONFIRMED + FIX VERIFIED — `document.currentScript` is `undefined` in the
   sandbox.** The Turbopack runtime reads `document.currentScript.getAttribute('src')`
   on its first line. → `TypeError: Cannot read properties of undefined (reading
   'getAttribute')` → runtime dies → 14/53 scripts throw. Setting `currentScript`
   per script makes **all 53 run clean**.
2. **OPEN — entrypoint never evaluates / hydration never scheduled.** After fix #1
   the `TURBOPACK` registry array exists, but `requestAnimationFrame` is never
   called, no module entrypoint runs, React never mounts. Needs runtime tracing.

---

## What works (ruled out)

Probed against the live dev server (`http://localhost:3010/`):

| Stage | Result |
|---|---|
| `/playwright` façade import (`chromium`, `expect`) | OK |
| `/render` `jsRenderer({mode:'fast'})` import | OK |
| host `fetchHtml` | `status=200 finalUrl="http://localhost:3010/" bytes≈407000` |
| script extraction | `total=53 external=26 inline=27 modules=0` |
| **relative URL resolution** | **all 26 `<script src="/_next/...">` → absolute `http://localhost:3010/_next/...`** ✓ |
| chunk fetch during render | **26/26 `/_next/` chunks fetched** ✓ |
| sandbox globals | `self===globalThis===window` ✓, `MessageChannel`/`queueMicrotask`/`requestAnimationFrame`/`TextEncoder`/`fetch` all present ✓ |
| RSC flight inline scripts | `self.__next_f.push(...)` works → `__next_f.length=27` ✓ |

So the relative-URL hypothesis is **disproven** — resolution and fetching are fine.
`finalUrl` is correctly threaded as the base. The failure is in script *execution*.

---

## Bug #1 — `document.currentScript` is undefined (CONFIRMED, fix verified)

### Evidence
Running the 53 real scripts through the `fast` backend's `node:vm` sandbox and
capturing the exceptions the backend normally swallows:

```
scripts run: 53  ok: 39  threw: 14
first errors:
  turbopack-_3fb52da9._.js: TypeError: Cannot read properties of undefined (reading 'getAttribute')
  _ca792a60._.js:           TypeError: Cannot read properties of undefined (reading 'getAttribute')
  node_modules_next_1159a439._.js: TypeError: ... (reading 'getAttribute')
  ...@flux-payroll_flux-payroll-ui..., @mui/material..., @tanstack/query-core..., posthog-js..., src_*  (all same)
```

The **first** thrower is the Turbopack runtime chunk itself. Browsers set
`document.currentScript` to the executing `<script>` element during synchronous
execution; Turbopack/webpack/Vite runtimes read `currentScript.src` /
`currentScript.getAttribute('src')` to derive the chunk base URL ("public path").
turbo-dom leaves `document.currentScript` undefined (`'currentScript' in document`
=== `false`), so the runtime throws on line 1 and every downstream app chunk
throws the same because the registry was never installed.

### Fix (applies to `src/render/backend-fast.mjs`; mirror in `backend-secure.mjs`)

```js
function runScripts(sandbox, scripts, timeoutMs) {
  const doc = sandbox.document;
  for (const s of scripts) {
    if (s.module || s.code == null) continue;
    setCurrentScript(doc, s.url);                       // NEW — before run
    try {
      vm.runInContext(s.code, sandbox, { timeout: timeoutMs });
    } catch {
      // a page script throwing must not abort the render
    } finally {
      setCurrentScript(doc, null);                      // NEW — clear after
    }
  }
}

// Browsers set document.currentScript during sync execution of an external
// <script>; bundler runtimes (Turbopack/webpack/Vite) read currentScript.src /
// .getAttribute('src') to compute the chunk base URL. Without it the runtime
// chunk throws "Cannot read properties of undefined (reading 'getAttribute')".
function setCurrentScript(doc, url) {
  const el = url
    ? { nodeName: 'SCRIPT', tagName: 'SCRIPT', src: url,
        getAttribute: (name) => (name === 'src' ? url : null) }
    : null;
  try {
    Object.defineProperty(doc, 'currentScript', { value: el, configurable: true });
  } catch { /* read-only DOM impl — best effort */ }
}
```

Better still: have turbo-dom expose a real `HTMLScriptElement` for `currentScript`
(some runtimes also read `.dataset`, `.nonce`, `.type`, parentNode). The shim
above covers the `.src`/`.getAttribute('src')` case that Turbopack hits.

### Result after fix #1
`scripts run: 53  ok: 53  threw: 0` — no more crashes. But still `data-test-id: 0`,
no mount → see bug #2.

---

## Bug #2 — entrypoint never evaluates / hydration never scheduled (OPEN)

With fix #1 applied and a generous 1s async drain:

```
lazy <script> injections attempted: 0
requestAnimationFrame calls:        0
state.pending (in-flight at end):   0
turbopack registry global present:  TURBOPACK, __next_f
data-test-id in final DOM:          0
```

Follow-up diagnostic (`probe5.mjs`) — the runtime installer DID run:

```
TURBOPACK typeof        : object        (was a plain Array before chunks ran)
push === Array.push     : false         → runtime replaced .push with the real
                                          module-registration function
globalThis turbo keys   : TURBOPACK, TURBOPACK_CHUNK_LISTS,
                          TURBOPACK_CHUNK_UPDATE_LISTENERS, __next_f
__turbopack_require__    : undefined     (closure-scoped in this version; not a
                                          reliable global signal)
document.currentScript   : object        (fix #1 holding)
```

Interpretation: the runtime **installs and registers chunks correctly**, but the
**entrypoint module is never evaluated** → React never mounts (`requestAnimationFrame`
never called, 0 lazy injections, 0 `data-test-id`). (Note: App Router has **no
`#__next`** wrapper — it mounts into `<body>`; don't use `#__next` as a mount probe.)

Root cause direction: the **Turbopack _dev_ runtime gates entrypoint execution on a
chunk-load-completion signal**. `TURBOPACK_CHUNK_LISTS` +
`TURBOPACK_CHUNK_UPDATE_LISTENERS` are the dev/HMR bookkeeping; the runtime waits
until every chunk in the list has signalled "loaded" before running runtime
entries. In a browser that signal is each external `<script>`'s **`onload`** event.
turbo-crawl executes chunks straight through `vm.runInContext` with **no `<script>`
element and no `onload`**, so the "all chunks loaded" gate never closes → the entry
never runs → no hydration.

Three fix directions (in order of effort/payoff):
1. **Run external scripts as real turbo-dom `<script>` nodes** (create element, set
   `src`, append to `<head>`, run code, then fire its `onload`/`load` event). This
   both fixes `document.currentScript` *and* closes the chunk-load gate the dev
   runtime waits on. Likely fixes #1 and #2 together.
2. **Drive the entry manually** after registration: synthesize the chunk-list
   completion (invoke whatever `TURBOPACK_CHUNK_LISTS`/update-listeners expect) so
   the runtime evaluates entrypoints.
3. **Add a production-build target** (`next build && next start`): the prod runtime
   has no HMR/chunk-list gate and evaluates entries eagerly on registration — the
   likeliest config to hydrate headless and the best first regression fixture.
   Recommend landing fix #1 (currentScript), then validating #2 against a prod build.

Also verify (secondary): turbo-dom's `MessageChannel` truly posts cross-tick
(`port1.onmessage` fires after `port2.postMessage`) — React 19's scheduler depends
on it once the entry does run.

### Structural ceiling beyond bug #2 (for the e2e use-case specifically)
Even once `/` hydrates, the Playwright suite needs more than first-paint:
- **Dynamic/route chunk loading.** Deeper pages code-split; the runtime injects
  `<script>`/uses `import()` to pull route chunks. The sandbox saw **0**
  injections on `/`, but navigations will trigger them — turbo-crawl must
  intercept injected `<script src>` (and dynamic `import()`) and fetch+run them,
  else the route module never loads. A hook on `document.createElement('script')`
  + `appendChild` that routes through the render tier would close this.
- **Backend data.** `data-test-id` nodes are data-driven (TanStack Query → flux-apis
  XHR). The `makeXHR`/`makePageFetch` shims exist; confirm they drive React Query's
  `fetchStatus` to settled and that `settle()` waits long enough (currently
  min 5 rounds × 1ms, max 50 — likely too short for a data-fetch + re-render cycle).
- **Client routing.** Multi-step journeys use `history.pushState` + the App Router;
  no real navigation occurs in the sandbox. Per-spec this likely needs a fresh
  `goto` per URL rather than in-app navigation.

---

## Reproduction

Probes live in the consuming repo at `payroll-app/e2e/turbo/` (dev branch
`experiment/turbo-crawl-e2e2`), runnable against any local Next dev server:

- `smoke.mjs`   — no-JS fetch vs JS-render tier, byte/test-id/timing diff
- `probe.mjs`   — URL resolution + per-stage fetch capture (`onRequest`)
- `probe2.mjs`  — sandbox global inventory
- `probe3.mjs`  — per-script exception capture (`POLY=1` applies the currentScript fix)
- `probe4.mjs`  — wall-#2 characterization (script injection, rAF, registry)

Minimal standalone repro of bug #1 (no consuming repo needed):

```js
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dir = require.resolve('@miaskiewicz/turbo-crawl/package.json').replace(/package\.json$/, '');
const { fetchHtml } = await import(`${dir}src/net.mjs`);
const { extractScriptsFromHtml } = await import(`${dir}src/render/scripts.mjs`);
const { installGlobals } = await import('@miaskiewicz/turbo-dom/install');

const res = await fetchHtml('http://localhost:3010/', {});
const items = extractScriptsFromHtml(res.html, res.finalUrl);
const sandbox = {}; installGlobals(sandbox, { html: res.html, url: res.finalUrl }); vm.createContext(sandbox);
for (const it of items) {
  if (it.module || it.code != null) continue;
  const { html: code } = await fetchHtml(it.url, { allowNonHtml: true });
  try { vm.runInContext(code, sandbox, { timeout: 1500 }); }
  catch (e) { console.log(it.url.split('/').pop(), '->', e.message); } // getAttribute of undefined
}
```

## Recommended order of work
1. Land fix #1 (`document.currentScript`) — clear, general, unblocks all bundler
   runtimes (Turbopack/webpack/Vite), not just this app.
2. Diagnose bug #2 with the `TURBOPACK.push`/`__turbopack_require__` check above.
3. Add a `production`-build test target (`next build && next start`) alongside dev —
   stable hashed chunks, no HMR/devtools, far simpler runtime; likely the first
   config to render green and a good regression fixture.
4. Add injected-`<script>`/`import()` interception for route chunks.
5. Tune `settle()` to wait on a React-Query-style data settle, not just `pending`.
