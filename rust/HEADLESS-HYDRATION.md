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
- **Not suspense** either: a Suspense-boundary fiber probe (tag 13) shows the one
  boundary is NOT in fallback state at the final commit (`suspended=0`). So React
  commits a real tree; the people segment subtree just resolves to nothing.
- **Not a redirect**: the only `history.replaceState` is Next's canonical-URL
  sync to the *same* path (`admin/people/active`), not a navigation away.
**Localized via prod `console.log` markers down the render path (overturns the
"returns null" guess):** the ENTIRE people component tree executes — markers fire
for `AdminRouteLayout → EntityAdminGuard → PayrollAdminLayout → PeopleLayout →
PeopleProvider → PeopleLayoutInner → ActiveEmployeesPage → EmployeesListPage →
EmployeeTable`. So nothing returns null. Render-pass counts are **finite** (most
=1; `PeopleProvider`=3, `EmployeesListPage`=4, `EmployeeTable`=4 — normal
state-settle, NOT an infinite loop). Yet `BODYLEN=0`: React runs every render
function but **commits no non-empty DOM** (not even the shell that DID render its
functions). `/admin/home` cleanly stops at `PayrollAdminLayout` and commits.

The deepest app component that renders is `EmployeeTable` → which renders
`<DataTableProvider><DataTable/></DataTableProvider>` from
`@flux-payroll/flux-payroll-ui` (a custom grid; readable source under
`dist/components/data/DataTable/`). `DataTableCore` does
`useMediaQuery(theme.breakpoints.down('md'))` to pick table-vs-card layout. The
empty commit originates **at/below this design-system grid** — every higher
component (incl the shell) runs its render but the atomic commit is empty, which
means the failure is during React's render/commit of the grid subtree (a thrown
value or a render-phase update that prevents commit), not a null return upstream.
The grid's own code has no `extends`/`.prototype`; the `prototype` TypeError is
unrelated (fires identically on `/home`).

**Blocked on tooling for the last mile:** the prod build is minified and our V8
isolate captures **no stack frames** (even with `Error.stackTraceLimit` raised).
A `next dev` build would name the failing internal — and the render tier can now
hydrate dev builds (the `import.meta`/ESM + best-effort-on-budget work merged on
`main`) — but `next dev` login was flaky to drive headlessly. Last mile: drive a
dev session to a readable React error at the `DataTable` grid, or bisect the grid
internals (likely a `useMediaQuery`/layout path or a host API the grid needs).

**Root cause confirmed (dev-build probe):** running the route through a `next dev`
build (in a temp checkout with its own `.next`, so the prod `:3000` server is
untouched — the engine can now open dev sessions thanks to the `import.meta` +
best-effort-on-budget work on `main`) renders **"Application error: a client-side
exception has occurred"** — Next's **root error boundary** fallback. So
`/people/active` **throws a client-side exception during render**; with no
intermediate `error.tsx` boundary in the entity/admin/people segments, it unwinds
to the root boundary, which replaces the whole tree (empty on the minified prod
build, the generic "Application error" page on dev). That's why the shell blanks
too even though its render function ran.

So the chain is: every component renders → the `DataTable` grid subtree throws →
root error boundary → blank. NOT null-return / suspense / missing-module /
data-fetch / redirect (all ruled out). The throw is in `DataTable`'s render-phase
hooks (it pulls `useMediaQuery`, `useTableStickyPositions` (DOM measurement),
fullscreen APIs, analytics) — one needs a host API our env lacks or mis-stubs.

**Last-mile attempt (deep instrumentation) — refined, partly inconclusive:**
- **Dev throw is real but the error is unreadable headlessly.** Dev renders the
  root-boundary "Application error", but React **swallows the caught error** in our
  env (no DevTools overlay; `console.error` is re-patched by Next dev and even a
  `defineProperty`-locked hook captured nothing), and dev sessions open
  **best-effort** (dev React loops past budget → terminated isolate → `liveEval`
  returns `""` for everything, even `1+1`). So globals/console can't be read off a
  dev session.
- **On PROD the grid does NOT throw.** Wrapping `DataTableCore`'s body in
  try/catch (catches its hooks incl `useTableStickyPositions`) → `data-griderr`
  empty. Adding a real **error boundary around the grid's children** → still
  empty. So neither the grid's hooks nor its descendants throw on the prod build,
  yet `BODYLEN=0`. **The prod-empty and the dev-"Application error" look like
  different failure modes** — the earlier "grid subtree throws" was over-attributed
  to the grid.
- The `Unexpected token '.'` dev chunk turned out to be **CSS inside a `<script>`**
  (Next devtools styles). Running it + logging a SyntaxError + continuing is
  exactly what a real browser does — **browser-accurate, not a bug**. So (a) needs
  no further fix; dev-build support is complete via the merged #2.

**RESOLVED via a real-Chromium oracle (the decisive tool).** Driving the route in
actual Playwright/Chromium against the SAME servers showed the dominant cause was
**the environment, not turbo-surf**:

1. **Prod CSP blocked the backend.** `next build` emits a strict CSP whose
   `connect-src` omits `http://localhost:*` (only dev allows it), so the browser
   blocks `GET http://localhost:3001/auth/me`. Real Chromium hit this too → blank.
   (e2e normally runs the dev CSP.)
2. **Backend is 3 months out of sync (the dominant cause) → `500`s.** flux-apis
   HEAD is *Release 11 March 2026* but its DB has *June* migrations applied. The
   March code queries schema the June DB changed: the June migration **dropped
   `entity_invitations`** (yet March `auth/me` still `SELECT`s it → 500), and
   `employments` **lost `job_id`** (March `Employment` model still selects it →
   `column Employment.job_id does not exist` → `GET /employments` 500), etc.
   Recreating `entity_invitations` makes `auth/me` 200; with that + the CSP fix,
   **real Chromium renders `/people/active` fully** (5 tabs + add-employee button;
   the grid is empty only because `/employments` still 500s). The *real* fix is to
   sync flux-apis code↔DB (check out a June commit, or reset the DB to March).

3. **turbo-surf has full auth + data parity.** Its cookie jar carries the
   cross-domain `refresh_token` cookie (`*.propelauthtest.com`); it performs
   `GET …/api/v1/refresh_token` (×2) → `GET …/auth/me` — **all `200`**, and
   `auth/me` returns the **complete** user + organizations payload (len 2040),
   identical to Chromium.

4. **Residual turbo-surf gap (exhaustively isolated).** With everything at parity,
   Chromium renders `/people/active` (459 DOM tags) but turbo-surf commits a bare
   empty `<div>` (2 tags). Ruled out by direct probes, every one: not auth, not
   data (stubbing `/employments` to a clean 200 didn't help — and Chromium renders
   even WITH its 500), not CSP, not maps, not a loop (`onCommitFiberRoot` fires a
   finite 12×), not a throw / error (locked-console + Error-patch + grid error
   boundary all caught nothing), not suspense. **Every component renders** — app
   markers + grid markers fire all the way down (`DataTableCore`/`Header`/`Body`
   all execute) — yet React's commit materializes **no host DOM**. React's DOM
   mutations go through the **native rtdom binding** (JS-level `appendChild`
   overrides see 0 calls on both routes), so this is a **native rtdom↔React
   commit-binding gap** specific to this component tree, not anything observable
   from page JS.

   **Next step (Rust-side):** instrument `turbo-surf-render`'s rtdom binding /
   vendored `browser_env` DOM-mutation ops (createElement / appendChild /
   insertBefore / setAttribute) during a `/people/active` commit and diff against
   `/home` (which commits 459 tags fine) — find the op/element that silently no-ops
   or fails in the commit path. Or diff React's committed fiber `current` vs
   `alternate` trees (the commit may be swapping in an empty tree).

**Net:** the headline blocker (stale backend env) is identified + partially fixed —
`/people/active` now renders in a real browser. turbo-surf is reduced to ONE
precise residual: a native commit-binding gap, with a concrete Rust-side repro
path. The full login→dashboard flow + many surfaces work.

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
