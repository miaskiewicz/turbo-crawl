# turbo-crawl — Status

Native-speed, **browserless** crawler for AI agents on turbo-dom. No Chromium at
runtime; no Playwright at runtime. See [SPEC.md](./SPEC.md) for the design and
[docs/js-execution-tier.md](./docs/js-execution-tier.md) for the JS-render plan.

## What works today

- **Page**: `goto`/`follow`, `interactiveElements` (indexed, `WeakRef`),
  `links`, `markdown`, `text`, `html`, `accessibilityTree`, `extract(schema)`,
  `query(css|xpath)`, `hydrationState`, cascade visibility.
- **Interaction (no JS)**: link/form graph — `click`/`fill`/`submit`, GET +
  POST (urlencoded **and** multipart) form synthesis; JS-only handlers surfaced
  honestly (inert, throw).
- **Networking**: `fetchHtml` over undici — redirects (auto + opt-in manual cap),
  gzip/br, charset sniff, max-size, content-type gate; `CookieJar` (RFC 6265
  subset incl. SameSite=None/Secure) bridged to `document.cookie`; robots.txt
  (+ Crawl-delay wired into politeness).
- **Crawl**: `Crawler` async iterator — global + per-host concurrency, politeness,
  backoff/retry, canonical dedupe, depth/page caps, warm Page pool, generic
  `{ fallback }` routing for JS-required pages.
- **Pseudo-browser config**: `userAgent` / `navigator` overrides (platform,
  language, …) reflected in both the DOM and the HTTP UA header.
- **Agent surface**: MCP server, 12 tools (goto, interactive_elements,
  accessibility_tree, markdown, html, text, links, click, fill, submit, extract,
  hydration_state, query).
- **No-browser SPA recovery**: `hydrationState()` mines `__NEXT_DATA__`, JSON-LD,
  `__APOLLO_STATE__`/`__INITIAL_STATE__`, typed JSON — zero JS.

## Quality gates

- **197 tests**, **100% line coverage** of `src/**` (`npm run test:cov`).
- `npm run check` = oxlint (0/0) + biome + cc-check (**cc < 6**) + tsgo + tests.
- Pre-commit hook runs the same. Benchmarks: full agent view ~2.5k pages/s,
  links ~18k/s, crawl ~14k pages/s, flat heap.

## Playwright: dev-only, never shipped

Nothing in the library loads Playwright or Chromium. Playwright is a
**devDependency** used solely by `test/differential.test.mjs` to sanity-check
output parity against a Chromium oracle (auto-skips if the browser isn't
installed). The Lane-B Chromium *adapter* has been **removed**.

## Open / planned

- **#7/#13 — No-Chromium JS-execution tier.** Run page scripts on turbo-dom in a
  killable worker (v1) or a true `isolated-vm` isolate running turbo-dom's **WASM**
  build (v2, best safety+perf). Spec: [docs/js-execution-tier.md](./docs/js-execution-tier.md).
- **#14 — Playwright-script API compatibility.** Run existing Playwright scripts
  on this no-JS engine (no playwright/chromium loaded):
  - *Layer 1 (pure DOM, cheap):* Locator + `getByRole/Text/Label/Placeholder/
    TestId/AltText/Title`, `locator(css)`, `first/last/nth/filter/count`,
    `selectOption`, `check/uncheck`, accessors
    (`getAttribute/textContent/innerText/innerHTML/inputValue/isVisible/
    isEnabled/isChecked`), history (`goBack/goForward/reload`).
  - *Layer 2 (façade `turbo-crawl/playwright`):* `chromium.launch()`→pseudo-browser,
    `newPage()`→Page, Locator actions, `expect(...)` web-first assertions subset,
    waiting methods resolve immediately (static DOM per navigation).
  - *Layer 3 (JS-only → clear "needs JS tier" error):* `evaluate`, `hover`-JS,
    `route/intercept`, `screenshot`/`pdf`, `boundingBox`. Unlocked by #13.
