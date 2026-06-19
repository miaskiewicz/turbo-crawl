# Headless hydration — requirements & status (Rust port)

"Headless hydration" in turbo-surf means two distinct things. Both are tracked
here so the requirements are explicit.

## 1. No-JS hydration-state mining (`hydration.mjs`)

Recover SPA data **without executing any JS** by mining the server-shipped state
that frameworks inline:

- `<script id="__NEXT_DATA__">` (Next.js, pure JSON)
- `<script type="application/ld+json">` (JSON-LD, object or array per block)
- `<script type="application/json" id="...">` (Remix / SvelteKit / typed islands)
- `window.__INITIAL_STATE__ / __APOLLO_STATE__ / __PRELOADED_STATE__ / __NUXT__ /
  __remixContext` — `window.X = <json>` assignments parsed **without eval**

**Requirements for the Rust port:** a `hydration` module in `turbo-surf-view`
over `rtdom::Tree` — `query_selector(_all)` for the script tags, `text_content`
for the JSON, plus a tiny tolerant scanner for the `window.X = {...};` globals
(balanced-brace slice → `serde_json`). No turbo-dom additions needed.

**Status:** ✅ ported — `hydration` in `turbo-surf-view` over `rtdom::Tree`
(exposed via napi `hydrationState`). Offline-tested.

## 2. JS-execution hydration (the render tier)

Run the page's **own** scripts so a client-rendered SPA hydrates, then read the
resulting DOM. This is `turbo-surf-render` (deno_core isolate over the turbo-dom
`Tree`).

Requirements and where each stands:

| Requirement | Status |
|---|---|
| Real V8 isolate, host heap unreachable from guest (+ runaway budget) | ✅ deno_core + watchdog |
| **Full** DOM bound to native `rtdom::Tree` (real `document`/Element — jQuery/React run) | ✅ `browser_env` (vendored from turbo-test) |
| `window`/`navigator`/`location`/`localStorage`/`console` + Event classes | ✅ binding + env bootstrap |
| Timers (`setTimeout`/`rAF`/`queueMicrotask`) | ✅ virtual (drained by delay) |
| Promise / `async`-`await` / microtask resolution (event loop) | ✅ `render_html_async` |
| `fetch` + `XMLHttpRequest` over the real net stack (relative-URL aware) | ✅ `op_fetch` → `turbo_surf_core::net` |
| `document.cookie` ↔ `CookieJar` bridge | ✅ `op_cookie_get/set` |
| `MutationObserver`/`IntersectionObserver`/`ResizeObserver`, history API | ✅ (observers are no-op stubs; history updates `location.href`) |
| TS/JSX bundle support | ✅ `turbo-surf-transform` (swc) |
| Entry point | ✅ `render_page(html, base_url, script)` → hydrated HTML |

Validated end to end: a mock SPA hydrates into `#root`, an XHR/`fetch`-driven page
fills from a localhost server, and **real jQuery** (`quotes.toscrape.com/js`) renders
its 10 quotes — see `crates/turbo-surf-render/tests/render.rs`.

**Known gaps / not-yet-required:**

- Bundle/module loading: scripts run as classic scripts; ESM `import` graphs aren't
  fetched/linked (the harness adapter concatenates a page's classic `<script>`s).
- Observers are inert stubs (no live mutation callbacks over the static tree).

## 3. Driving an authenticated SPA (live sessions)

Beyond one-shot render, `PageSession` (render tier) keeps a hydrated app **alive
across calls** — the V8 isolate, React fibers, closures, and delegated listeners
persist, so dispatched events re-enter the running app and the re-render is
observable (the one-shot `render_*` paths serialize + reset after each call,
killing the app). Thread-per-session (the isolate is `!Send`); `eval` drains to a
stable-DOM signal and returns best-effort on the budget. napi:
`liveOpen`/`liveEval`/`liveSerialize`/`liveCookies`/`liveClose`; the Playwright
shim opens a live session on a `networkidle` `goto` and dispatches real
click/fill events (fill bypasses React's `_valueTracker` via the native value
setter; click fires mousedown→focus→mouseup→click + the form submit default).

**Validated end to end (no browser):** a real PropelAuth login —
`fill email/password → click submit → onSubmit → POST login (200) → session
cookie → client redirect chain (login → /post-login → /auth/me →
/entity/{id}/admin/home)` — renders the authed dashboard fully. In-app redirects
(a path change in the live session) re-load the new route as a fresh page
carrying cookies, so the redirect chain completes hop-by-hop. Test:
`live_session_dispatches_events_into_running_app`.

**Open limitation — cold deep-route loads render empty.** A *cold*
`goto('/entity/{id}/admin/people/active', {networkidle})` (cookie carried, no
prior in-app nav) commits an **empty app-root `div`** while `/admin/home` (same
shell + providers) renders fully. It's why many authed-page e2e specs still fail
"locator matched no elements". A few specs (`boundingBox`) need a real browser by
design.

Diagnosis so far (via a React-DevTools-hook probe over the live isolate):
- **React is NOT parked/suspended** — it fires `onCommitFiberRoot` 12× for the
  empty route (19× for the rendering one). It commits; the people segment just
  reconciles to **empty host DOM**.
- **Not a missing module/chunk** — all client-reference modules register and all
  chunks load `200`. **Not data-suspense** — the app has no `useSuspenseQuery`
  and no data fetch fires. **Not an error** — the only console error is a benign
  `Cannot read properties of undefined (reading 'prototype')` that appears
  *identically* on the route that DOES render (red herring).
- Both routes render `Providers` + `Theme` identically; divergence is deeper, in
  the segment subtree, and **silent**. Other deep authed routes (e.g.
  company-settings) render fine — so it's specific to certain segments.
- Pinpointing the exact null-returning component is blocked on the prod build:
  minified component names + our V8 isolate captures **no stack frames** (even
  with `Error.stackTraceLimit` raised), and fiber-tree dumps overflow a probe
  attribute before reaching the divergence.

**Decisive next step:** probe a **`next dev` build** (run it on a spare port
against the same backend) — dev React emits readable component names, full error
+ component stacks, and hydration-mismatch warnings, which should name the
null-returning component immediately. Then map it to source and fix the engine
gap it depends on.

### Probing gotchas (reusable)

- **`fetchHtml`/`fetchWithCookies` (napi) return a JSON string**
  (`{"html":...,"status":...}`), not raw HTML — `JSON.parse(...).html` before
  `hydrate`. Passing the raw JSON in JSON-escapes every `"`, so the inline
  `__next_f.push` flight scripts fail to eval.
- **`next build --turbopack` + `next start` is unreliable for prod probes** here
  (`routesManifest.dataRoutes is not iterable`; a stale `.next` serves a 404ing
  runtime chunk → false "empty render"). Use a standard webpack `rm -rf .next &&
  npm run build && npx next start`, and verify the referenced runtime chunk
  returns 200 first. The dev server is the reliable target.
- Cap probes at the Node level and `pkill -f turbo-surf` after.

## Lane routing (when to hydrate)

`detect` (Lane B heuristic, ported to `turbo-surf-view`) decides whether a page is
JS-gated and worth the isolate: near-empty rendered text + heavy external scripts, or
an empty known SPA mount (`#root`/`#app`/`#__next`/`[data-reactroot]`). A caller picks
Lane A (no-JS parse) vs Lane B (`render_page`) from its verdict.
