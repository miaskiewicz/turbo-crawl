# turbo-crawl — Status

Native-speed, **browserless** crawler for AI agents on turbo-dom. No Chromium at
runtime; no Playwright at runtime. See [SPEC.md](./SPEC.md) for the design and
[docs/js-execution-tier.md](./docs/js-execution-tier.md) for the JS-render tier.

## What works today

- **Page**: `goto`/`follow`/`reload`/`goBack`/`goForward`, `interactiveElements`
  (indexed, `WeakRef`), `links`, `markdown`, `text`, `html`, `accessibilityTree`,
  `extract(schema)`, `query(css|xpath)`, `hydrationState`, cascade visibility,
  `evaluate`/`$eval`/`$$eval`.
- **Locators (Playwright-style)**: `locator(css)`, `getByRole/Text/Label/
  Placeholder/TestId/AltText/Title`, `first/last/nth/filter/count`, accessors,
  and actions (`click/fill/check/uncheck/selectOption/press/type`).
- **Interaction (no JS)**: link/form graph — GET + POST (urlencoded **and**
  multipart) form synthesis; JS-only handlers surfaced honestly (inert, throw).
- **Networking**: `fetchHtml` over undici — redirects (auto + opt-in manual cap),
  gzip/br, charset sniff, max-size, content-type gate; `CookieJar` (RFC 6265
  subset incl. SameSite=None/Secure) bridged to `document.cookie`; robots.txt
  (+ Crawl-delay wired into politeness).
- **Crawl**: `Crawler` async iterator — global + per-host concurrency, politeness,
  backoff/retry, canonical dedupe, depth/page caps, warm Page pool, generic
  `{ fallback }` routing for JS-required pages.
- **Pseudo-browser config**: `userAgent` / `navigator` overrides (DOM + HTTP UA).
- **No-browser SPA handling**:
  - `hydrationState()` mines `__NEXT_DATA__`/JSON-LD/`__APOLLO_STATE__`/… (zero JS).
  - **JS-execution render tier** `jsRenderer({ mode })`: runs the page's own
    scripts on turbo-dom and extracts from the rendered DOM. `secure` =
    isolated-vm + turbo-dom **WASM** (true V8 isolate; open-web/hostile-safe);
    `fast` = in-process `node:vm` + native parser (local/trusted).
- **Agent surface**: MCP server, **32 tools** (navigation, views, locators by
  selector/role/text, actions, accessors, `evaluate`, history, UA).

## Playwright

- **Runtime: not a dependency.** Compatibility façade
  (`@miaskiewicz/turbo-crawl/playwright`) runs existing Playwright scripts on the
  no-JS engine — `chromium.launch()`→pseudo-browser, locators, actions, `expect`,
  `evaluate`/`$eval`/`$$eval`. Pixel/render-only APIs (`screenshot/pdf/route/
  hover`) throw a clear "no-JS engine" error.
- **Dev only**: real Playwright is a devDependency used solely by the differential
  test (`test/differential.test.mjs`, auto-skips without the browser).

## Quality gates

- **~240 tests**, ~100% line coverage of `src/**` (the optional secure render
  backend has one unreachable isolate-boot guard line). `npm run check` =
  oxlint (0/0) + biome + cc-check (**cc < 6**) + tsgo + tests; same in pre-commit.
- Benchmarks: full agent view ~2.5k pages/s, links ~18k/s, crawl ~14k pages/s.

## Optional dependencies

- `isolated-vm` + `esbuild` — only for `jsRenderer({ mode: "secure" })`. The
  `fast` backend uses Node's built-in `vm`; the rest of the library needs neither.

## Render tier — coverage

- Classic inline + external scripts ✓
- **ESM-module scripts** (`<script type="module">`) ✓ — import graph bundled via
  esbuild (host-fetched deps), honoring `<script type="importmap">`, run as
  classic in both backends.
- **Page-initiated `fetch` and `XMLHttpRequest`** ✓ — bridged to the host net
  layer (cookies/UA); secure backend bridges via an ivm `Reference`
  (`applySyncPromise`); settling waits on in-flight requests.
- **Page-discovered URLs** ✓ — `page.requests()` lists what the page fetched;
  `new Crawler({ fallback, followRequests: true })` feeds them into the frontier.
- Not yet: streaming response bodies, `fetch` `Request`/`Headers` fidelity.
