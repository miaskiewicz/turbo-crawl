# Changelog

All notable changes to turbo-surf are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

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
