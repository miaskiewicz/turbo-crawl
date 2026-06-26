# Changelog

All notable changes to turbo-surf are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]
**Look like a real Chrome on the wire.** The stock client sent a bare
`turbo-surf/0.1` UA + a thin `Accept` and a generic rustls TLS/HTTP-2
fingerprint — an instant tell for WAFs.

### Added
- **Chrome default headers** (default, rustls path, no new build deps) — every
  fetch now sends a current Chrome 149 (macOS) UA plus the full navigation header
  set (`accept`, `accept-language`, `sec-ch-ua`/`-mobile`/`-platform`,
  `sec-fetch-*`, `upgrade-insecure-requests`), values matched against a live
  real-Chrome capture. `accept-encoding` stays client-managed so auto-decompress
  still works; caller/crawl headers still override.
- **`impersonate` feature** (opt-in, BoringSSL) — swaps the reqwest+rustls client
  for `wreq`/`wreq-util`, presenting a real Chrome TLS/JA3/JA4 + HTTP-2 (Akamai)
  fingerprint. Off by default (needs a C toolchain — cmake/nasm — to build);
  forwarded by `turbo-surf-{page,napi,mcp}`. A single `http_backend` alias in
  `turbo-surf-core` swaps the backend in one place. New live e2e
  (`tests/impersonate.rs`) asserts a Chrome JA4 + HTTP-2 fingerprint against a
  public echo (auto-skips offline); a localhost e2e asserts the Chrome headers
  reach the wire on the default path.

## [0.2.4]
A **Linux SIGBUS** fix in the Playwright-shim test harness, plus a new **Python
(PyPI) binding**.

### Fixed
- **SIGBUS on Linux running the shim suite** (#6) — root cause was a bug in the shim's
  fake `@playwright/test` harness: `test.describe(...)` was registered as a node:test
  *test* instead of a *suite*, so the nested `test(...)` calls in a describe body fired
  on the global runner while the parent test was still running. node:test cancelled them
  ("test did not finish before its parent and was cancelled"), and the dangling async
  test — still holding a live-session V8 isolate — was torn down at process exit, which
  faulted with SIGBUS on Linux (macOS tolerated it). Latent until v0.2.3 wired a real
  `npm test`, so the multi-file shim run never executed on CI before. `makeDescribe` now
  registers a real node:test suite, so nested tests are awaited and torn down cleanly.
- **V8 platform init hardening** (defense-in-depth) — `ensure_platform()` initializes the
  V8 platform once on a dedicated, parked keeper thread (deno_core otherwise inits it
  lazily on whichever thread builds the first runtime; a transient one that then exits
  orphans the platform). Called before any worker isolate is created from `evaluate`,
  `render`, `render_pooled`, `hydrate`, and `live_open`.

### Added
- **Python binding (`turbo-surf` on PyPI)** — a PyO3 abi3 wheel (CPython 3.8+) exposing
  the stateless parse → view/extract → JS-render surface (`markdown`, `text`, `links`,
  `query`, `extract`, `evaluate`, `render`, `transform`, …), mirroring the Node N-API
  functions. New crate `rust/crates/turbo-surf-py`; `release-py.yml` builds + publishes
  wheels on a `pyv*` tag (gated on a `PYPI_TOKEN` secret). A real `test` npm script + the
  stale shim-assertion fixes from v0.2.3's CI work are included.

## [0.2.3]
A **JS-render speed** pass on the crawl path: the render tier built a fresh V8 isolate
per page (boot + the ~90 KB env bootstrap + parse dominate), so a JS-mode crawl paid
the full isolate boot on every page. A pooled fast path reuses one isolate across pages
— boot is paid once per worker thread — with a cross-page global scrub so a reused
isolate still renders like a fresh navigation. **11.5 ms → 3.2 ms per page** on
`quotes.toscrape.com/js` (3.6×), output byte-identical to the fresh render.

### Added
- **Pooled render fast path** — `render_page_pooled` (Rust) / `renderPooled` (napi)
  reuses a thread-local V8 isolate across pages, on a persistent render worker (one
  long-lived thread + one reused tokio runtime). Per-page session repoint
  (base/cookies/UA) + a global scrub (`SCRUB_GLOBALS`) restore fresh-navigation
  semantics; a budget-terminated/errored runtime is dropped instead of repooled. The
  competitive JS adapter drives it; `render` (fully isolated, fresh-per-page) is
  unchanged for correctness-sensitive callers.
- **`harness/hotpath/render-bench.mjs`** — reusable offline profiler for `native.render`
  / `renderPooled` (faithful script extraction, cached sample, A/B + parity check).

### Notes
- Cross-page isolation is intentionally relaxed for crawl speed (matching the existing
  `EVAL_RT` stance): the scrub reverts page-ADDED globals, not builtins mutated in place.
- A V8 code cache for the bootstrap + page bundle was tried and reverted — with a fresh
  isolate per page, `ConsumeCodeCache` costs more than a re-parse. Isolate reuse is the
  real lever.

## [0.2.2]
The headless **Playwright-shim parity** push: the payroll-app Playwright e2e suite
now runs through the browserless shim (over the napi addon, **no Chromium**), driving
a real authenticated Next.js App Router SPA. Side-by-siding every failure against real
Chromium (reseeded per suite) drove the engine to parity — the suite's remaining reds
all reproduce in Chromium too (app/backend/test data, not the engine). See
`HEADLESS-HYDRATION.md` for the full record.

### Added
- **ES module support in the render tier** — `<script type=module>` + `import` graphs
  fetched/linked over the host net (shared cookie jar, same-origin), wired into the
  hydration pump. Turbopack-dev entry execution (`document.currentScript` in the module
  pump, `__name` helper); classic `<script src>` chunks with ESM bodies route to the
  module pump.
- **Live-isolate interaction drive** — `getByRole/getByText/getByLabel` resolve and
  dispatch IN the running isolate (live `querySelectorAll('*')` index), so fills/clicks
  reach the real app, not just the static snapshot. Web-first assertion retry
  (re-pumps the live app between tries); `page.on('response')` / `waitForResponse`
  backed by a real network log; fetch-aware drain (`__pendingFetches`) keeps pumping
  until a mutation's success re-render lands.
- **Nth-aware scope chain for nested locators** — `parent.nth(i).getBy*()` walks the
  chain via `__tcResolveScoped` (a CSS-concat selector can't express "the i-th match's
  subtree"); `getByRole/Text/Label`/`getByTestId` scope to the parent's subtree.
- **CSS `:hover` simulation** — hover-revealed menus (incl. emotion's nested `&:hover`)
  become visible by flattening the matched rules inline.
- **Download capture + `ElementHandle` + polling `waitForFunction`**; keyboard events +
  `navigator.clipboard`; `structuredClone`; `addInitScript`; `setInputFiles`;
  per-test fixture sharing; `test.extend` custom fixtures.

### Fixed
- **App Router RSC hydration unblocked** — defined `document.location` (a browser
  invariant the dev RSC flight client reads via `findSourceMapURL`); its absence threw
  inside the flight-stream parse and the React root suspended forever. 0 → 488 fibers on
  the live payroll route.
- **RSC soft-nav follow + query preservation** — Next client navigation
  (`router.push/replace`) fetches the target's RSC flight and never advances
  `location` headlessly; the target is recorded on `__rscNav` and re-loaded hop-by-hop
  (login redirect chain completes). It now records `pathname + search + hash` (was
  `pathname` only — dropped `?employeeIds=` etc.) and strips Next's `_rsc` cache-buster.
  Guard: `rsc_soft_nav_preserves_query_and_strips_rsc_param`.
- **`reload({waitUntil:'networkidle'})` re-hydrates the live SPA** — `reload` ignored its
  options (unlike `goto`), leaving the reloaded doc as the raw un-hydrated shell (a
  settings select read `""`). Guard: surface "reload re-hydrates the live SPA".
- **`Locator.filter()` scopes child locators** — `cards.filter({hasNotText: x}).first()
  .getByTestId('y')` resolved against the UNFILTERED set; a serializable
  `hasText`/`hasNotText` spec now rides the scope chain. Guard:
  `scoped_resolve_applies_filter_before_indexing`.
- **Browser-accurate click** — pointerdown→mousedown→focus(only if mousedown not
  preventDefault'd + focusable)→pointerup→mouseup→click, pointer events first (MUI
  v7/Radix gate on them); honors `preventDefault` so an `<a href="#">` whose onClick
  toggles state doesn't also navigate.
- **Playwright `isVisible` semantics** — `is_visible` ignores `aria-hidden` (pure
  CSS/layout, like Playwright) and treats effective `opacity:0` / `display:none` /
  `visibility:hidden` ancestors as hidden (closing MUI modals resolve
  `waitFor(state:'hidden')`).
- **Drain/timer correctness** — runtime-injected `<script>`s run during interaction
  drains (`next/dynamic` lazy modals); the virtual-timer budget is RELATIVE per drain so
  a closing MUI Fade's short exit timer isn't killed.
- **Shim parity** — `waitFor` polls the requested state (visible/hidden/attached);
  `page.evaluate` awaits a returned Promise; `waitForResponse` won't match a response
  from an earlier step; `about:blank` is a no-fetch blank doc; `waitForFunction` returns
  the function's value; RegExp locator names; `boundingBox` → null. Locale: the shim no
  longer force-seeds `NEXT_LOCALE=en-US` (matches Playwright's es-MX default).

## [0.2.1]

### Fixed

- **Authenticated SPA pages now render headlessly.** Heavy authed routes (e.g. a
  payroll people/grid page) previously committed an empty body in the render tier
  while rendering fine in a real browser. Two render-tier bugs let third-party
  scripts spin to the render budget so React never committed:
  - **Virtual-clock timers.** `__runTimers` used `delay` only as a sort key, so a
    self-rescheduling `setTimeout` poll (analytics SDKs do this) fired until the
    raw count cap, starving the budget. A virtual clock now gates delayed timers
    (`due = now + delay`, advance on fire, stop past a 15s virtual ceiling) so
    polls fire a browser-like number of times and the page quiesces.
  - **`<iframe>` `contentWindow`.** Analytics SDKs read a builtin's native
    prototype off a throwaway iframe's `contentWindow`; with none present they
    recreated an iframe on every lookup (hundreds of churned iframes). Iframes now
    get a lightweight stub whose `contentWindow` is the current realm (the lookup
    caches, the loop stops) and that never enters the rtdom tree.

  New tests: `virtual_clock_bounds_self_rescheduling_timers`,
  `iframe_content_window_exposes_builtins`.

### Added

- **Authenticated SPA journeys hydrate + drive headlessly.** Next.js App Router
  pages render through the render tier and the Playwright shim can log in and drive
  them end to end (no Chromium). Against clean staging: payroll-wizard 5/5, invites
  26/26, auth-guards 32/38. Key enabler: define `document.location` (mirrors
  `window.location`) so Next's DEV RSC-flight parse doesn't abort (0 → 488 fibers).
- **ES module support** in the render tier: `<script type=module>` + `import` graphs
  fetched over the net, classic `<script src>` chunks with ESM bodies routed to the
  module pump.
- **Shim parity surface:** `page.waitForEvent('download')` + a `Download`
  (`path()`/`saveAs()`/`suggestedFilename()`) backed by a real `URL.createObjectURL`
  registry + `<a download>` capture; `Locator.elementHandle()` + a polling
  `page.waitForFunction(fn, handle)`; CSS `:hover`-revealed menus become visible
  (`__tcApplyHover` flattens nested emotion `&:hover` rules and applies the reveal
  inline); locator subtree scoping for `getByTestId`/`getByRole`/`getByText`/
  `getByLabel`, including an nth-aware scope chain for `steps.nth(i).getBy*`.

### Fixed

- **`waitForResponse` no longer matches a response from an earlier step** — it tags
  each drained response with the interaction that produced it and only accepts one
  from the current action or later (Playwright "after the call" semantics), so a
  loose URL predicate can't grab a prior step's response.
- **Visibility matches Playwright `isVisible`:** effective `opacity:0` (self/ancestor)
  reads hidden so a faded-out MUI modal resolves `waitFor(state:'hidden')`; and
  `aria-hidden` is NOT treated as hidden (a decorative aria-hidden icon carrying a
  test-id is still visible — aria-hidden stays an accessibility-query concern).
- **Modals open/close reliably:** the virtual-timer budget is RELATIVE per drain (a
  closing Fade's late exit timer fires), and `drain_to_quiescence` runs runtime-
  injected `<script>`s so `next/dynamic` lazy modals load on click.
- **Interactions are browser-accurate:** click fires the full pointer→mouse→click
  sequence (focus only when mousedown isn't preventDefault'd), and
  getByRole/getByText/getByLabel resolve in the LIVE isolate so portal'd MUI options
  dispatch their onClick.
- **Locale parity:** the shim no longer force-seeds `NEXT_LOCALE=en-US`; with no
  cookie the app resolves its default locale (es-MX), matching real Playwright.

New tests (render + shim `surface.test.mjs`): `createobjecturl_anchor_download_is_
captured`, `hover_reveals_css_hover_menu`, `tcgetby_scopes_to_root`,
`tcresolvescoped_walks_nth_chain`, `aria_hidden_stays_visible`, waitForResponse
staleness guards, getByTestId/getByRole scoping guards.

Additional shim fixes:

- **`about:blank` navigation** is a no-fetch blank document (a `goto`/`reload` of
  about:blank used to hit the net layer → `builder error for url (about:blank)`).
- **`waitForFunction` resolves the function's return value** (not a boolean) and
  works against a static snapshot — `Number(await waitForFunction(() => 1 + 1))`
  is `2` again (regression from the polling-handle rewrite).
- **`test.extend` custom fixtures inject** — a test fn with its own extDefs (a
  custom fixture or a `page` override) opens its own fixture set instead of
  reusing the base-only shared one (they resolved to `undefined` before).
- **Test isolation:** the env-var-mapping test restored `TURBO_SHIM_*` with
  `delete` instead of `= undefined` (the latter coerces to the string
  `"undefined"`, leaking `testIdAttribute`/`baseURL` into every later context and
  cascading failures across the serial suite).

## [0.2.0]

**turbo-surf is a browserless, native-speed crawler _and_ Playwright-compatible
script runner for AI agents — one engine, no Chromium.** It fetches, parses, and
acts on pages on its own native DOM ([turbo-dom](https://github.com/miaskiewicz/turbo-dom),
the `turbo-dom` Rust crate), and for JS-gated pages it runs the page's own scripts
in a **true V8 isolate** (a `deno_core` runtime — host heap unreachable from the
guest, with a runaway-execution budget) and re-renders the DOM. No headless
browser, no pixels, no layout.

What it does:

- **Crawl** — point it at a domain and stream page records: indexed interactive
  elements, a link/form graph, an accessibility tree, markdown and plain-text
  views, rendered-HTML capture, CSS/XPath queries, schema-driven structured
  extraction. Concurrency + per-host politeness (token-bucket), backoff/retry,
  canonical-dedupe, robots + crawl-delay, depth/page caps.
- **Drive pages (Playwright-compatible)** — the same `chromium.launch()` →
  `page.goto()` → locators → actions → `expect` surface, plus a `@playwright/test`
  drop-in `test` runner, so existing Playwright scripts/tests run unchanged against
  the engine instead of a browser. Network events, request routing/mocking, and
  persistent context state (cookies + `localStorage` + `storageState`).
- **Run page JS, no browser** — recover SPA data either by mining server-embedded
  hydration state (`__NEXT_DATA__`, JSON-LD, `__APOLLO_STATE__`, …) or by executing
  the page's own scripts in the V8 isolate (real jQuery / React-style bundles
  render); `fetch`/`XMLHttpRequest` are bridged to the host net layer.
- **Agent surface** — a 60-tool **MCP** server (stdio JSON-RPC) agents drive
  directly: navigate, click/fill/submit, query, extract, accessibility tree,
  markdown, `crawl`, `batch`, `render`/`eval_js`/`inject_js`, cookies/headers,
  `snapshot`. Available as both a Node server and a native Rust binary.

Engine: a Rust workspace (core / page / view / render / transform / napi / mcp) on
the `turbo-dom` crate, exposed to Node through a napi addon and a Playwright shim.
Performance is network-bound — a pooled HTTP client, a persistent V8 isolate
reused across pages, an external-script cache, and a per-page parse cache. In
benchmarks it runs the same routines as Chromium at parity while being multiples
faster, and outpaces other crawlers (Cheerio/Scrapy/Colly and browser-driving
crawlers) — see the README.
