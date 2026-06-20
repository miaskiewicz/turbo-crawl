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

4. **Residual turbo-surf gap — FIXED (commit `2a92f36`).** With env at parity,
   turbo-surf still committed an empty `<div>` because the page **never quiesced**
   within the render budget — two timer/host bugs let third-party scripts spin:
   - **No virtual clock in `__runTimers`.** `delay` was only a sort key, so a
     self-rescheduling `setTimeout` poll (analytics SDKs do this) fired until the
     raw count cap — spinning the whole budget so React never committed. Binding
     instrumentation (file-logged from Rust) showed `/people` doing 1150 creates /
     1319 appends and the hydrate running the FULL 30s budget with the body still
     empty. Fix: a virtual clock — `due = __now + delay`; the drain advances `__now`
     to each fired timer's due and stops delayed timers past a 15s virtual ceiling,
     so polls fire a browser-like ~tens of times and the page quiesces.
   - **`<iframe>` had no `contentWindow`.** PostHog reads a builtin's native
     prototype off a throwaway iframe's `contentWindow`; with none it bailed
     without caching and recreated an iframe on EVERY lookup — **776** iframe
     create/remove churn that also starved the budget. Fix: iframes get a
     lightweight stub whose `contentWindow` IS our realm (lookup resolves + caches
     → loop stops, 776→4) and which never enters the rtdom tree.

   Result: `/people/active` 2 tags → **485 tags in ~2.2s**; `/home` (459) and
   company-settings (557) also drop to ~1.4–2.2s (were near/over budget). Verified
   with real Chromium as oracle. Tests: `virtual_clock_bounds_self_rescheduling_timers`,
   `iframe_content_window_exposes_builtins`.

**Net: cause #2 fully resolved.** The dominant blocker was a stale local backend
(March code vs June DB → `auth/me` 500); recreating the dropped `entity_invitations`
table makes auth 200. The turbo-surf side was two budget-starving spin loops
(timer virtual clock + iframe contentWindow), now fixed — authed SPA pages render
headlessly. (The local backend still needs code↔DB sync for `/employments` etc.;
that's an env fix, not turbo-surf.)

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

## Driving the full Playwright suite through the shim (what we built + what stalls)

Running the payroll-app Playwright e2e suite through the `playwright-shim` (over the
napi addon, no Chromium) took it from **6/114 → ~75/102 passing, 0 skipped**. The
work split into render-tier capabilities and shim parity. This section is the field
record: what we implemented, and — equally important — what we *tried that did not
work* so the next person doesn't re-walk it.

### Implemented (render tier)

- **RSC soft-nav follow.** Next App Router client navigation (`router.push/replace`)
  fetches the target's RSC flight with an `RSC` header and never changes
  `location.href` headlessly. The fetch wrapper records the target on `__rscNav`; the
  live-session driver re-loads that route as a fresh page (browser hard-nav
  equivalent), following a redirect CHAIN hop-by-hop. This is what makes login
  (`/login → /post-login → /entity/…`) complete.
- **Fetch-aware drain.** `drain_to_quiescence`/`__pendingWork` tracked timers +
  un-run scripts but NOT in-flight fetches, so a save `POST` could resolve *after* the
  drain quiesced (the DOM looks "stable" while waiting) and its success re-render — a
  modal close, a redirect — was lost. A `__pendingFetches` counter now keeps the drain
  pumping until requests settle.
- **Network log → events.** Each live-app `fetch` is appended to `__netLog`; the shim
  drains it to emit `page.on('response')` and back a real `waitForResponse`. Tests use
  these to capture API payloads (payroll period, employments lists).
- **Globals:** `KeyboardEvent` dispatch path, `navigator.clipboard` (in-memory
  write/read), `structuredClone` (deep clone w/ Date/RegExp/Map/Set/cycles). Apps
  probe `globalThis.structuredClone.prototype`; absent it threw.

### Implemented (shim parity)

- **getBy\* live-drive.** `getByRole/getByLabel/getByText` have no CSS selector, so
  `fill`/`click`/`check` fell back to mutating the static HTML snapshot — never
  reaching the running React app (empty form fields → failed saves). napi `get_by`
  now returns the matched element's document-order `idx`; the shim dispatches into the
  live isolate via `querySelectorAll('*')[idx]`.
- **Deepest-descendant event dispatch.** A real click lands on the leaf under the
  cursor and bubbles up; dispatching on the matched wrapper missed handlers bound to
  inner nodes (a MUI `Select`'s inner `role="combobox"` opens on its own mousedown).
  Events now fire on the deepest child; focus + form-submit logic stay on the control.
- **preventDefault honoring.** A click reports `defaultPrevented`; the static-intent
  fallback (anchor navigate / form POST) is skipped when the app handled it — an
  `<a href="#">` whose React `onClick` toggles state no longer also navigates to `#`
  and wipes the new state (the company-settings edit toggles).
- **Web-first assertion retry.** `expect(locator|page)` re-evaluates (re-pumping the
  live app between tries) until it passes or times out — a UI change that lands just
  after an action (modal close, async row, redirect) is observed.
- **`addInitScript` actually runs** (prepended as the first `<head>` script of the
  live session) — `injectTestPartner`'s `window.__FLUX_DYNAMIC_PARTNERS__` etc.
- **`waitFor` polls real state** (visible/hidden/attached), `evaluate` awaits a
  returned Promise, `setInputFiles` (File objects in the isolate), `hover`,
  `dispatchEvent` (+checkbox toggle), `test.skip(cond, reason)` overloads (killed 12
  bogus skips), per-test fixture sharing (afterEach gets the live logged-in page),
  live-session close on teardown (isolate leak), RegExp locator names, `boundingBox`
  → null.

### The remaining wall: RSC-flight hydration of deferred Suspense boundaries

~7–8 failures (vacation, time-entry, parts of company-settings) all reduce to ONE
thing: a deep client subtree never hydrates. On the payroll wizard, React hydrated
**484 of 996** elements (stable — more pumping doesn't change it); the static
"Add Manually" button has **no React fiber**, so it has no `onClick` and clicks are
dead (native or synthetic), so the `dynamic()` modal it would open never mounts.

**Bisected with repros (each run through the real render tier):**

| Hypothesis | Verdict |
| --- | --- |
| Dynamic `<script>` inject → `onload` → promise → wire handler | **works** — `dynamically_injected_script_runs_and_fires_load` (committed) |
| Real React 18 `Suspense` + `lazy()`, client render | works (ad-hoc diag, React 18 UMD) |
| Real React 18 `hydrateRoot` of pre-rendered `Suspense`+`lazy` | works (ad-hoc diag) |

So **React core hydration + code-splitting work in the engine.** The failure is
specific to **Next App Router RSC**: the wizard page content is a Suspense boundary
that suspended during SSR; client hydration of it is deferred until its **RSC flight
chunk** (`self.__next_f` → `react-server-dom-webpack` reader) is consumed, and in the
isolate that deferred boundary's flight never reaches React's reader. Click-triggered
selective hydration can't rescue it either — it needs the same flight data.

### Things we TRIED that did NOT fix it (don't repeat)

- **More pumping / bigger budget.** Fiber count is stable at 484 regardless of extra
  drains — hydration isn't merely incomplete-by-budget, that boundary is never
  scheduled.
- **Non-zero layout measurement.** Forced `getBoundingClientRect`/`offsetWidth`/
  `clientWidth` to a real box (theory: libs gate render on measurement). No effect on
  the un-hydrated subtree. **Reverted** (risk to the passing set).
- **`structuredClone`.** Added it (was genuinely missing) — did not change hydration.
- **The `TypeError: …reading 'prototype'` (×5).** Red herring. It's **caught** (never
  reaches `window.onerror` nor the page `console.error`; the page's own override sees
  nothing) — a PostHog native-prototype probe. Not in React's hydration path.
- **Chunk-load / script-skip failures.** None: 251 chunks load with **0** failures,
  **no** `script skipped (ESM…)` and **no** `script error` during the wizard load.
- **DB flush + reseed.** Net wash for this (helped grant-leak/locale data pollution,
  but a fresh DB lacked KB seed data and exposed a flux-apis platform-role seed gap →
  KB `403`). NOT a turbo-surf issue. `migration:revert:all` is also blocked by an
  irreversible app migration — don't rely on it for a clean rebuild.

### Precise diagnosis (validated against real Chromium)

With the env finally correct — **real Chromium on `next dev` PASSES the vacation
spec** (prod CSP drops `http://localhost:*` from `connect-src`, so a real browser
on a prod build can't reach flux-apis `:3001` → "Failed to load organizations" →
empty entity-select; the shim isn't subject to CSP since it fetches via the host
net layer, so it uses the **prod** build for classic chunks). So the wizard failure
is **confirmed turbo-surf-specific**: same flow, real Chromium green, shim red.

Walking the dead "Add Manually" button's ancestors in the shim's hydrated DOM:

```
BUTTON#vacation-time-add-manually-button : none
DIV … (the whole page/wizard subtree)    : none
MAIN                                      : FIBER
DIV / DIV#payroll-admin-shell            : FIBER
```

React hydrates the **layout** (`payroll-admin-shell` → `MAIN`) but NOT the App
Router **page-segment** inside `MAIN` — that boundary stays **dehydrated**, so its
whole client subtree (incl. the button) has no fiber and no handlers.

Ruled out (each tested): deps mismatch, prod-vs-dev CSP (that's the *real-browser*
blocker, not the shim), failed/missing chunks (251 load, 0 fail), skipped ESM
scripts (none), React core (Suspense+lazy+hydrate all work via React-18-UMD diags),
the flight stream not closing (**328 ReadableStreams created, 328 closed**),
`useSearchParams` (page uses `useParams`, which doesn't suspend), the `prototype`
TypeError (caught PostHog probe, not in the hydration path), and "needs more pumping"
(fiber count is stable at 484/997 across redraws + clicks + load/DOMContentLoaded
events — React is waiting on a *signal*, not scheduler ticks).

So: the page-segment dehydrated Suspense boundary's flight arrives + the stream
closes, but the **flight-resolved → reconciler "retry the dehydrated boundary"
link never fires** in the isolate, and selective-hydration-on-click doesn't rescue
it (a synthetic click doesn't trigger React's continuous-event replay for the
dehydrated boundary). That link lives inside Next's bundled
`react-server-dom-webpack` + React reconciler.

### Where to start next (RSC flight)

The tractable next step is instrumenting how `self.__next_f` (the array Next replaces
with a stream-feeding `.push`) is consumed by Next's bundled `react-server-dom-webpack`
client reader in the isolate — specifically whether late `__next_f.push([1, …])`
chunks (the deferred boundary's flight) reach the reader, and whether the flight
`ReadableStream` is ever closed. That reader is bundled + minified inside the Next
chunks, so it can't be unit-tested in isolation here; a focused diagnostic that taps
`__next_f.push` and the flight stream controller is the way in. This is a render-engine
project, not a shim gap.

### Other non-turbo-surf blockers seen (env, not engine)

- **KB write `403`** — KB uses `@RequireAnyLocalRole('FLUX_ADMIN')` resolved from a
  *local* DB role mapping; after a postgres reset the PropelAuth user persists but the
  local role row isn't recreated → 403. flux-apis seed gap.
- **es-MX locale test** — the shim seeds `NEXT_LOCALE=en-US` (needed so English
  text/role-name assertions match everywhere else); the one settings test wants the
  es-MX default. Proper fix is per-user backend-pref locale, not a global cookie.
- **Grant order-dependency** — delegated-write grants are shared server state; the
  auth-guard grant tests pass in isolation but bounce in the full run. The
  `afterEach` revoke (now driven correctly via fixture sharing) mitigates but doesn't
  fully serialize it.
- **Run serial.** `node --test` defaults to parallel → concurrent PropelAuth logins
  trip rate-limiting; the real Playwright config is `workers: 1`. Use
  `--test-concurrency=1` (set in payroll-app's `test:e2e:turbo:run`).

## Hydration regression harness (standing rule)

**Every headless-hydration issue we fix gets a permanent, committable repro here.**
Don't rely on the live payroll app (it churns + needs the full env) — capture the
mechanism in a self-contained fixture driven through the render tier.

- **Render-tier fixtures:** `rust/crates/turbo-surf-render/tests/fixtures/*.html` —
  self-contained pages (React/ReactDOM UMD **inlined**, no npm dep at test time),
  loaded by a `#[tokio::test]` in `tests/render.rs` via `include_str!`, asserted by
  opening a `PageSession` and checking the hydrated behaviour (e.g. a button's
  `onClick` firing → `window.__clicked`).
- **Generators:** `rust/crates/turbo-surf-render/tests/fixture-gen/*.mjs` regenerate
  the fixtures from real React (run with the app's `node_modules` path). Committed so
  the fixtures are reproducible, not magic blobs.
- First guard: `react18_streaming_suspense_boundary_hydrates` (fixture
  `react-streaming-hydration.html`, generator `gen-react-streaming.mjs`). Real React 18
  streaming SSR: a `<Suspense>` that suspended on the server → streams its content late
  with a `$RC` completion script that walks the `<!--$?-->…<!--/$-->` comment markers
  and calls the boundary's `_reactRetry`. **It passes** — proving the generic
  dehydrated-boundary hydration path (comment markers + `_reactRetry`) works in the
  isolate, which is exactly why the Next App Router wizard failure is narrowed to the
  **RSC-flight (`react-server-dom-webpack`)** variant, not generic React.
- The RSC-flight variant can't be isolated cheaply: `react-server-dom-webpack/server`
  requires the bundler-only `react-server` export condition, and the client's flight
  references resolve through the real app's webpack runtime. Until that's stubbed, its
  repro is the full-app shim e2e (the payroll wizard vacation specs).
