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
