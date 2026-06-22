# Changelog

All notable changes to turbo-surf are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

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
