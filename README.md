# turbo-crawl

> Native-speed, **browserless** web crawler **and Playwright-compatible script
> runner** for AI agents — built on
> [turbo-dom](https://github.com/miaskiewicz/turbo-dom). Fetch + parse + extract
> + drive pages with no headless browser; 100×+ faster on server-rendered pages.

turbo-crawl is two things in one engine, on its own native DOM:

- **A crawler** — point it at a domain and stream page records: indexed
  interactive elements, a link/form graph, an accessibility tree, markdown and
  plain-text views, rendered-HTML capture, CSS/XPath node queries, and
  schema-driven structured extraction. Plus a 60-tool **MCP** interface agents
  drive directly (incl. `crawl`, `batch`, `render`/`set_mode`, `eval_js`/
  `inject_js`, cookies/headers, `snapshot`).
- **A drop-in Playwright replacement** — the same `chromium.launch()` →
  `page.goto()` → locators → actions → `expect` API, so existing Playwright
  scripts and tests run **unchanged** — but against turbo-dom instead of a
  browser. No Chromium, no pixels, no layout. Now with **network events**
  (`page.on('response')`, `waitForResponse`), **request routing/mocking**
  (`page.route`), and **persistent context state** (cookies + `localStorage` +
  `storageState` across navigations).

For pages that need JavaScript it runs their scripts on turbo-dom (no browser),
either by mining server-embedded hydration state or by executing page JS inside
a **true V8 isolate** and re-rendering the DOM (see below).

## What makes it different

Most tools in this space pick one lane: a crawler **or** a browser-automation
library, and they get their DOM from a real browser (Playwright/Puppeteer/
Selenium) or an in-process fake DOM with no security isolation (jsdom,
happy-dom). turbo-crawl is unusual on four axes at once:

1. **AI-agent-ready out of the box.** It ships a full **MCP server** (60 tools:
   navigate, click/fill/submit, query, extract, accessibility tree, markdown,
   `crawl` a whole site, `batch` a URL list, `render`/`set_mode` to run page JS,
   `eval_js`/`inject_js` against the live render heap with a DOM-history trail,
   cookies/headers, `snapshot`, …) so an agent drives real pages over stdio with
   **no browser and no glue code** — `npx turbo-crawl-mcp`. Most crawlers are
   libraries you wrap yourself; this one is an agent tool on day one.
2. **Crawler _and_ Playwright-API script runner on one native DOM.** The same
   engine bulk-crawls a domain and runs Playwright-style scripts/tests — no
   browser anywhere in the stack.
3. **Its own DOM, not a browser's.** turbo-dom is a native + WASM HTML parser
   with a lazy copy-on-write DOM — native-speed parse, no pixels/layout/IPC.
4. **A V8 isolate to run page JS + re-render.** The `secure` JS tier executes
   page (or your own) JavaScript inside a real V8 isolate (`isolated-vm`) —
   capped heap, no ambient host access — against a WASM DOM, then re-renders.
   Most JS-capable crawlers instead drive a full headless browser, or run page
   scripts in-process with a fake DOM that offers **no real security isolation**
   (Node's `vm` is [explicitly not a security
   boundary](https://nodejs.org/api/vm.html); cf. happy-dom
   [CVE-2025-61927](https://github.com/capricorn86/happy-dom/wiki/JavaScript-Evaluation-Warning)).
   Running hostile page JS in a true isolate against a lightweight DOM is rare.

See [SPEC.md](./SPEC.md) for the design and [STATUS.md](./STATUS.md) for current
capabilities.

Status: **v0.1.11 — working** ([npm](https://www.npmjs.com/package/@miaskiewicz/turbo-crawl)).
Page + interaction, hardened networking (cookies / `document.cookie` bridge /
robots + crawl-delay / charset / size + redirect caps, HTTP/2 + DNS-cache
dispatcher, 304 conditional-request cache), crawl orchestration (`Crawler` +
one-shot `crawlSite`) and a `batch` URL-list runner, structured extraction,
CSS+XPath query, a Playwright compat façade with **events / network / routing /
persistent context state**, a no-Chromium JS-execution render tier with
**re-enterable live-heap `evalJs`/`injectJs` + a DOM-history trail**, and a
60-tool MCP server. ~100% line coverage (`npm run test:cov`); benchmarked against
other crawlers (above); a Playwright differential test (SPEC §14) bounds
representation drift when Chromium is installed (dev-only).

## Install

```sh
npm install @miaskiewicz/turbo-crawl
```

Pure ESM, Node ≥ 20.

## Drive a page (no browser)

```js
import { Page } from "@miaskiewicz/turbo-crawl";

// configure the pseudo-browser's navigator + HTTP User-Agent
const page = new Page({
  userAgent: "MyBot/2.0",                       // → navigator.userAgent + User-Agent header
  navigator: { platform: "Win32", language: "de-DE", languages: ["de-DE", "en"] },
});
page.setUserAgent("MyBot/3.0");                 // also changeable at runtime
await page.goto("https://example.com");

page.interactiveElements(); // [{ i, tag, role, name, href, visible, jsHandler, ref:WeakRef }]
page.links();               // absolute http(s) targets
page.markdown();            // readable Markdown of the main content
page.text();                // plain text, line-broken at block boundaries
page.html();                // serialized DOM (rendered DOM when using jsRenderer)
page.accessibilityTree();   // { role, name, value?, children }

// no-JS form flow: fill → submit → follow a result
const q = page.interactiveElements().find((e) => e.tag === "input");
page.fill(q.i, "widgets");
await page.submit();
await page.click(page.interactiveElements().find((e) => e.tag === "a").i);

// recover SPA data with NO browser: mine server-embedded hydration state
page.hydrationState(); // { next, jsonLd, json, states } from __NEXT_DATA__,
                       // JSON-LD, __APOLLO_STATE__/__INITIAL_STATE__, etc.

// query nodes by CSS or XPath → { node, html, text }
page.query(".product .price");                 // CSS
page.query("//a[@href]/@href");                // XPath (subset) → attribute values
page.query("//li[contains(text(),'sale')]", { first: true });

// structured extraction
const data = page.extract({
  name: { selector: "h1" },
  price: { selector: ".price", type: "number" },
  tags: { selector: ".tag", list: true },
});
```

## Crawl a site

```js
import { Crawler, crawlSite, batch } from "@miaskiewicz/turbo-crawl";

// streaming: backpressure-aware async iterator, one record at a time
for await (const rec of new Crawler({ start, maxPages: 500, concurrency: 8 })) {
  // rec.url, rec.status, rec.view.interactiveElements, rec.extracted
}

// one-shot: collect a whole crawl into an array (agent-friendly options)
const recs = await crawlSite({
  url: start,
  maxPages: 200,
  sameHost: true,
  allow: "/blog/",        // URL regex to keep
  deny: "\\?utm",         // URL regex to skip
  mode: "fast",           // "no-js" (default) | "fast" | "secure" — JS-gated pages render
});

// fan out over a known URL list with a chosen execution mode
const out = await batch([url1, url2, url3], { mode: "secure", view: "markdown" });
```

`Crawler` is the engine (streaming); `crawlSite` is a one-shot collect over it;
`batch` runs a fixed URL list. Concurrency + per-host politeness, backoff/retry,
canonical-form dedupe, robots + crawl-delay, and depth/page caps are all built in.

## MCP server (agents)

```sh
npx turbo-crawl-mcp          # stdio MCP server (60 tools), e.g.:
# navigation:  goto, go_back, go_forward, reload, set_user_agent
# content:     interactive_elements, accessibility_tree, aria_snapshot, markdown,
#              text, html, links, requests, snapshot, query, get_by,
#              hydration_state, extract
# interaction: click, fill, submit, click_selector, fill_selector, select_option,
#              check, uncheck, fill_many, find_text, forms, extract_links
# accessors:   get_attribute, text_content, inner_html, input_value, count,
#              is_visible, is_checked, is_enabled, is_editable, is_focused,
#              is_empty, aria_role, accessible_name, accessible_description
# bulk:        crawl, batch
# render/JS:   render, set_mode, eval_js, inject_js, latest_dom, dom_history,
#              evaluate, detect_js
# session:     get_cookies, set_cookie, set_extra_headers, robots_check
# direct:      fetch_json, fetch_raw
```

`render`/`set_mode` switch the Page to the `fast`/`secure` JS tier; then `eval_js`
and `inject_js` run against the **live render heap** (page globals, handlers) and
each mutation appends to a DOM-history trail readable via `latest_dom`/
`dom_history`. (`eval_js`/`inject_js` on the no-JS path run in a `node:vm` over the
parsed DOM behind a best-effort guard — **not** a security sandbox; use `mode:
secure` for untrusted JS.)

Or embed: `import { createServer } from "@miaskiewicz/turbo-crawl/mcp"`.

### Set it up in Claude Code

Register the stdio server once and every Claude Code session gets the tools:

```sh
# JS server (npm) — zero build, needs Node:
claude mcp add turbo-crawl -- npx -y turbo-crawl-mcp

# …or the native Rust binary (no Node at runtime — build it once):
cargo build --release -p turbo-crawl-mcp --manifest-path rust/Cargo.toml
claude mcp add turbo-crawl -- "$PWD/rust/target/release/turbo-crawl-mcp"
```

Both speak newline-delimited JSON-RPC 2.0 over stdio and expose the **same 60-tool
surface** (navigation, reads, interaction, accessors, render/JS, cookies/headers,
`crawl`/`batch`); the native Rust binary is one process — no Node, no Chromium.
Verify with `claude mcp list`. To scope it to one project instead of globally, add
`--scope project` (writes
`.mcp.json` in the repo) or commit a `.mcp.json`:

```json
{
  "mcpServers": {
    "turbo-crawl": { "command": "rust/target/release/turbo-crawl-mcp", "args": [] }
  }
}
```

(For other MCP clients — Claude Desktop, Cursor — point their MCP config's `command`
at the same binary or `npx -y turbo-crawl-mcp`.)

## Run Playwright scripts (no browser)

Drop-in compatibility layer so existing Playwright scripts run on the no-JS
engine — **nothing loads playwright or chromium**:

```js
import { chromium, expect } from "@miaskiewicz/turbo-crawl/playwright";

const browser = await chromium.launch({ mode: "fast" });   // run page JS
const ctx = await browser.newContext({ storageState });     // reuse auth
const page = await ctx.newPage();

page.on("console", (m) => console.log(m.type(), m.text()));
page.route("**/analytics/**", (route) => route.abort());    // block/mock requests

await page.goto("https://example.com");
const [resp] = await Promise.all([                          // assert on the network
  page.waitForResponse((r) => r.url().includes("/api") && r.request().method() === "PUT"),
  page.getByRole("button", { name: "Save" }).click(),
]);
await expect(page.getByText("Saved")).toBeVisible();
const state = await ctx.storageState();                     // cookies + localStorage
```

Locators (`getByRole/Text/Label/Placeholder/TestId/AltText/Title` — all accept a
**RegExp** name/text, `locator(css)`, `first/last/nth/filter/count`), actions
(`click/fill/check/uncheck/selectOption/press/type`), accessors, history
(`goBack/goForward/reload`), `evaluate`/`$eval`/`$$eval`, **events** (`on`/`once`/
`off` for `request`/`response`/`console`/`pageerror`/…, `waitForResponse`/
`waitForRequest`/`waitForEvent`), **routing** (`route`/`unroute` →
`fulfill`/`abort`/`continue`), **init scripts + headers** (`addInitScript`,
`setExtraHTTPHeaders`), and **persistent context state** (cookie jar +
`localStorage`/`sessionStorage` across navigations, `addCookies`/`cookies`/
`storageState`) all work — events/routes/storage require a JS mode (`launch({ mode:
"fast" | "secure" })`); without one the façade stays Lane A and still emits
navigation request/response events. Genuinely pixel-only APIs (`screenshot`,
`pdf`, `hover`) throw a clear "no-browser engine" error.

### `test` runner (`@playwright/test` drop-in, no browser)

The façade also ships a `test` — a `@playwright/test`-style runner with fixtures,
executed on **`node:test`** over the turbo engine. Import `test`/`expect` from here
instead of `@playwright/test` so **no spec ever pulls in `@playwright/test` or
launches Chromium** (the common leak: a shared `harness.ts` that does
`import { test } from '@playwright/test'` runs its specs on real Chromium
regardless of any page-fixture swap).

```js
import { test, expect } from "@miaskiewicz/turbo-crawl/playwright";

test.use({ mode: "fast", baseURL: "http://localhost:3000" }); // omit mode → Lane A

test.describe("auth", () => {
  test.beforeEach(async ({ page }) => page.goto("/login"));
  test("signs in", async ({ page }) => {
    await page.getByLabel("Email").fill("a@b.test");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Welcome")).toBeVisible();
  });
});

// shared base — every spec/harness extends this, never @playwright/test:
export const authedTest = test.extend({
  account: async ({ request, baseURL }, use) => use(await seed(request, baseURL)),
});
```

**Zero-edit mode** — to flip an *existing* suite onto turbo without touching any
`import` line (incl. a shared `harness.ts` that imports from `@playwright/test`),
pass the loader flag when running:

```sh
node --import @miaskiewicz/turbo-crawl/playwright/register --test 'e2e/**/*.spec.mjs'
```

It installs a resolution hook that rewrites `@playwright/test` (and
`playwright`/`playwright-core`) to the turbo façade — so every spec gets turbo's
`test`/`expect`/`chromium` and **no Chromium launches**. Toggle off without
dropping the flag: `TURBO_PLAYWRIGHT_SHIM=0 node --import … --test …`. ESM only.

Run specs with **`node --test`** (ESM), not the `playwright` CLI — the CLI only
discovers its own `test`. Built-in fixtures: `page`, `context`, `browser`,
`request` (a minimal real-HTTP `APIRequestContext`), plus the option fixtures
`baseURL` / `storageState` / `mode` / `browserName` / `launchOptions` (override via
`test.use({…})`). Supported: `test.describe` (+`.serial`/`.parallel`/`.only`/
`.skip`/`.configure`), `before/afterEach`, `before/afterAll`, `test.skip`/`only`/
`fixme` (static **and** runtime `test.skip(cond?, reason?)`), `test.fail`,
`test.use`, `test.step`, `test.extend`. Out of scope (node:test owns running):
worker-scoped fixtures, projects, and the reporter/CLI surface. For a CJS test
file, `require("@miaskiewicz/turbo-crawl/playwright/test")`'s engine graph can't be
`require`d (turbo-dom top-level `await`) — run under ESM/`node --test`.

### `expect(...)` web-first assertions

`expect` from `@miaskiewicz/turbo-crawl/playwright` is a drop-in for
`@playwright/test`'s `expect` (it must be — `@playwright/test`'s own `expect`
brand-rejects a non-Playwright `Locator`). `expect(x)` dispatches on its argument:
a **Locator**, a **Page**, an **APIResponse**, or any plain value. Every form
supports `.not`; matchers run once (no auto-retry — nothing changes without JS).
String/RegExp/array argument forms match Playwright.

**CJS test runners** (`@playwright/test` resolves spec files with `require`) can't
statically import the engine — turbo-dom's parser uses top-level `await`, so the
`./playwright` graph is ESM-only. Load `chromium` with a dynamic `import()` (the
page fixture already does), and `require` `expect` from the dedicated TLA-free
subpath: `const { expect } = require("@miaskiewicz/turbo-crawl/playwright/expect")`.

| Class | Supported matchers |
| --- | --- |
| **Locator** | `toBeAttached` · `toBeVisible` · `toBeHidden` · `toBeEnabled` · `toBeDisabled` · `toBeEditable` · `toBeChecked` · `toBeEmpty` · `toBeFocused` · `toBeInViewport` · `toHaveText` · `toContainText` · `toHaveValue` · `toHaveValues` · `toHaveCount` · `toHaveId` · `toHaveRole` · `toHaveClass` · `toContainClass` · `toHaveCSS` · `toHaveAttribute` · `toHaveAccessibleName` · `toHaveAccessibleDescription` · `toHaveAccessibleErrorMessage` · `toHaveJSProperty` · `toMatchAriaSnapshot` |
| **Page** | `toHaveTitle` · `toHaveURL` · `toMatchAriaSnapshot` |
| **APIResponse** | `toBeOK` |
| **Generic value** | `toBe` · `toEqual` · `toStrictEqual` · `toBeTruthy` · `toBeFalsy` · `toBeNull` · `toBeDefined` · `toBeUndefined` · `toBeNaN` · `toBeGreaterThan(OrEqual)` · `toBeLessThan(OrEqual)` · `toBeCloseTo` · `toContain` · `toContainEqual` · `toHaveLength` · `toHaveProperty` · `toMatch` · `toMatchObject` · `toBeInstanceOf` · `toThrow` / `toThrowError` · `.resolves` / `.rejects` |

`toHaveCSS` reads turbo-dom's **real computed-style cascade** (CSSOM);
`toBeInViewport` uses its **geometry** (approximate flow layout — no real paint,
enough for the in/out question). `toMatchAriaSnapshot` is built from the
accessibility tree as a structural role/name *subset* match — Playwright's YAML
extras (`[level=…]`, selected/checked properties, strict child nesting) are not
modeled.

Statics: `expect.extend({ … })` (custom matchers), `expect.poll(fn)`,
`expect.configure(opts)`, `expect.soft` (no deferred aggregation without a test
runner, so it throws like `expect`).

#### Unsupported Playwright assertions (and why)

Only the **pixel** matchers — they need a rasterizing renderer the no-Chromium
engine has no equivalent for (same reason `page.screenshot()`/`pdf()` throw). They
throw a clear error rather than silently passing:

| Matcher | Why it can't be supported |
| --- | --- |
| `toHaveScreenshot` / `toMatchSnapshot` (image) | No pixel renderer to rasterize the page. |

## JS-gated pages — no browser

turbo-crawl ships **no browser**. For pages that need JavaScript:

1. **Hydration state (now):** `page.hydrationState()` mines the data frameworks
   embed server-side (`__NEXT_DATA__`, JSON-LD, `__APOLLO_STATE__`, …) — zero JS,
   covers most "SPAs".
2. **JS-execution tier:** run the page's own scripts on turbo-dom — Chromium-free
   — and extract from the *rendered* DOM. Two backends:

```js
import { jsRenderer, Page, Crawler } from "@miaskiewicz/turbo-crawl";

// "secure" (default): true V8 isolate (isolated-vm) on turbo-dom's WASM parser.
// Safe for open-web/hostile pages. "fast": in-process vm + native parser, for
// local/trusted targets only.
const { fetchHtml, close } = jsRenderer({ mode: "secure" });
const page = new Page({ fetchHtml });
await page.goto("https://some-spa.example");   // scripts run; DOM is populated
page.links(); page.markdown(); page.query("h1");

// or auto-escalate only shell-only pages during a crawl:
new Crawler({ start, fallback: jsRenderer({ mode: "secure" }).fetchHtml });
```

The render tier is **re-enterable**: bind it to a Page and `evalJs`/`injectJs` run
against the **live render heap** (page globals, event handlers, React state) — not
a re-parsed snapshot — while each mutation appends to a DOM-history trail:

```js
const renderer = jsRenderer({ mode: "secure" });
const page = new Page({ fetchHtml: renderer.fetchHtml }).setRenderer(renderer);
await page.goto("https://some-spa.example");

await page.evalJs("return window.__APP_STATE.user.id");   // reads the live heap
await page.injectJs("document.querySelector('button').click()");
await page.latestDom();    // serialized DOM after the click
await page.domHistory();   // [render, …, post-click] snapshots, in order
```

On the no-JS path, `evalJs`/`injectJs` run in a `node:vm` over the parsed DOM
behind a best-effort token guard — **not a security boundary** (Node's `vm` isn't
one). Run untrusted JS with `mode: "secure"`, where the V8 isolate contains it.

Classic + **ESM-module** scripts run (modules bundled via esbuild, honoring
`<script type="importmap">`), and page-initiated **`fetch`** *and*
**`XMLHttpRequest`** are bridged to the host net layer (cookies/UA), so
client-only data loads render. URLs the page fetches are recorded — `page.requests()`,
and `new Crawler({ fallback, followRequests: true })` feeds them into the frontier.
`esbuild` ships as a dependency (pure-Go prebuilt, no native build). The `secure`
backend additionally needs the **optional** native `isolated-vm` — `npm i
isolated-vm`; without it `mode:"secure"` throws an actionable error (it never
silently downgrades to the unsandboxed `fast` backend). See
[docs/js-execution-tier.md](./docs/js-execution-tier.md).

`detectJsRequired(document)` flags shell-only pages, and `Crawler` accepts a
generic `{ fallback: fetchHtml }` to route them to whatever renderer you plug in.

> **Playwright is not a dependency.** It's a **dev-only** tool used solely by the
> differential test (`test/differential.test.mjs`) to sanity-check output parity
> against Chromium. Nothing in the shipped library loads Playwright or Chromium.
> (Goal: *API* compatibility so Playwright-style scripts can run on this engine —
> not running Playwright itself.)

## Competitive benchmark

`harness/competitive/` runs the **same Playwright script** on turbo-crawl and a
fleet of real browsers, scoring output **parity** against a Chromium oracle and
timing each. `npm run harness`. The **Rust** port runs here too — `turbo-rust
(no-js)` and `turbo-rust (js)` drive the same routines through the napi addon
(turbo-dom + the `deno_core` render tier), **no Chromium**. Median ms over 8 runs
(live network), parity is each engine's observations vs the Chromium oracle:

| engine | wikipedia | js-quotes | parity |
|---|---|---|---|
| turbo-crawl (no-JS) *(JS impl)* | **153** | — *(needs JS)* | ✓ |
| turbo-crawl (js-fast) *(JS impl)* | 343 | **248** | ✓ |
| turbo-crawl (js-secure) *(JS impl)* | 291 | 287 | ✓ |
| **turbo-rust (no-JS)** *(Rust)* | **163** | — *(needs JS)* | ✓ |
| **turbo-rust (js)** *(Rust)* | —‡ | 524 | ✓ |
| chromium *(oracle)* | 919 | 1170 | — |
| firefox | 726 | 1237 | ✓ |
| webkit | 1196 | 1271 | ✓ |

Every engine produces the **same observations** as Chromium / Firefox / WebKit
(parity ✓). The **pure-Rust** crawler matches the mature JS impl and crushes every
browser: `turbo-rust (no-js)` runs the Wikipedia click-through in **163 ms** —
**~5.6× faster than Chromium** (919), faster than Firefox (726) / WebKit (1196) —
and `turbo-rust (js)` **runs the real jQuery on `quotes.toscrape.com/js`** (the
same 10 quotes Chromium extracts) in **524 ms, ~2.2× faster than Chromium** (1170),
via a true V8 isolate over a native rtdom DOM, no Chromium process. It's
network-bound now, after closing the per-call overhead the napi engine carried:
a **process-shared pooled HTTP client** (connection/TLS reuse across pages), a
**thread-persistent V8 isolate** whose **DOM install is reused across same-page
`page.evaluate`s** (parse once per page, ~0.5 ms/call after), a **per-thread parse
cache** so multiple views of one page (links + markdown + extract — the real crawl
shape) parse it once (~4 ms → ~1 ms per extra view), and a back-forward snapshot
cache so `goBack` restores instead of re-fetching. A Rust criterion microbench
(`cargo bench -p turbo-crawl-view`) + a napi hotspot profiler
(`harness/hotpath/rust-hotpath.mjs`) track these.

‡ js-mode executes the *page's own* scripts; on a server-rendered page like
Wikipedia that over-runs (use `no-js` there — 192 ms, 4/4). The `form` routine is
omitted this run (httpbin.org was returning 503/timeouts for every engine).

The harness auto-detects installed engines (`firefox`/`webkit`, and anti-detect
browsers like `playwright-extra`/`patchright`/`rebrowser-playwright`); see
[harness/competitive/README.md](./harness/competitive/README.md). (Numbers are
network-bound and machine/run dependent.)

## Crawler-vs-crawler benchmark

`harness/crawlers/` races turbo-crawl against other open-source crawlers on a
real, paginated site — **same** 20-page same-host crawl of `books.toscrape.com`,
**same** ~150 ms per-request politeness on every engine, items counted with the
**same** CSS selector. Median of 3 timed runs, live network (`npm run
crawl-bench`):

| crawler | runtime model | items | median ms | pages/s |
|---|---|---|---|---|
| crawlee `CheerioCrawler` | Node | 339 | 2767 | 7.2 |
| **turbo-crawl (no-js)** | **Node, browserless** | 316 | 3261 | **6.1** |
| **turbo-rust (no-js)** | **Rust napi, browserless** | 339 | 3375 | **5.9** |
| spider-rs | Rust + N-API | 194 | 3486 | 5.7 |
| got + cheerio (hand-rolled) | Node | 339 | 5590 | 3.6 |
| node-crawler (`crawler`) | Node | 339 | 49624 | 0.4 |
| Scrapy | Python *(subprocess)* | 246 | 49270 | 0.4 |
| Colly | Go *(subprocess)* | 320 | 45664 | 0.4 |

At equal politeness the wall-clock is **network-bound**, so the in-process
crawlers cluster together: turbo-crawl sits in the **top tier** alongside the
dedicated speed engines (crawlee, spider-rs) and ahead of a hand-rolled
got+cheerio loop — while extracting equivalent content and running **no
browser**. The **pure-Rust** `turbo-rust (no-js)` (the whole BFS — fetch, parse,
same-host gate, per-page item count — runs in Rust via the napi addon) lands right
alongside the JS engine, and **~13× ahead of Scrapy / Colly**. The heavyweight
engines trail ~15×: Scrapy and Colly pay a fresh
process startup per crawl (the harness shells out to their CLIs), and
node-crawler's per-request overhead is high. turbo-dom's raw parse advantage
doesn't show here — at 20 live pages, network swamps a sub-millisecond parse;
it shows in-memory instead (links ~18k/s, crawl ~14k pages/s, below). And unlike
every engine in this table, the *same* turbo-crawl also runs Playwright scripts
(parity table above).

### JS-executing crawlers — turbo-crawl vs real browsers

The other set targets `quotes.toscrape.com/js`, where quotes are built
client-side (a non-JS crawler sees ~0). Here turbo-crawl's JS tiers run the
page's own scripts — `js-fast` in an in-process `vm`, `js-secure` in a true V8
isolate — against turbo-dom, while every competitor drives a **real headless
Chromium** (`npm run crawl-bench:js`, 10 pages, median of 3):

| crawler | JS engine | items | median ms | pages/s |
|---|---|---|---|---|
| **turbo-crawl (js-secure)** | **V8 isolate, no browser** | 120 | 4096 | **2.4** |
| **turbo-crawl (js-fast)** | **in-proc vm, no browser** | 100 | 4184 | **2.4** |
| crawlee `PuppeteerCrawler` | headless Chromium | 100 | 5074 | 2.0 |
| crawlee `PlaywrightCrawler` | headless Chromium | 100 | 6173 | 1.6 |
| puppeteer-cluster | headless Chromium | 100 | 17062 | 0.6 |

turbo-crawl executes the **same page JavaScript** and extracts the **same
quotes** as a real browser — yet runs faster than every browser-driving crawler
(and ~4× faster than puppeteer-cluster), with no Chromium process, even though
turbo-crawl is the only engine here also honoring the 150 ms politeness delay.
The `js-secure` row does this inside a **hardened V8 isolate** — most crawlers
that run page JS either drive a full browser (this table) or use an in-process
fake DOM with no real isolation. See
[harness/crawlers/README.md](./harness/crawlers/README.md) — competitors
auto-detect and missing ones are skipped; install them with
`npm i -D @spider-rs/spider-rs crawlee cheerio got crawler` (+ `brew install
pipx go && pipx install scrapy` for Scrapy/Colly). (Machine/run dependent.)

## Development

```sh
npm install        # also wires the pre-commit hook (oxlint → biome → cc-check → tsgo)
npm test           # node --test
npm run test:cov   # coverage (src ~100% line-covered)
npm run lint       # oxlint
npm run format     # biome format --write
npm run cc         # cyclomatic-complexity gate (cc < 6)
npm run typecheck  # tsgo typecheck of the public types
npm run check      # lint + format:check + cc + typecheck + test (the CI gate)
npm run bench      # extract + crawl throughput
```

The differential test (`test/differential.test.mjs`, SPEC §14) compares output
against a Chromium oracle; it auto-skips unless `playwright` and its browser are
installed (`npm i -D playwright && npx playwright install chromium`).

Benchmarks (Node 24, in-memory): full agent view ~2.5k pages/s, links ~18k/s,
crawl ~14k pages/s with a flat heap.

## License

MIT
