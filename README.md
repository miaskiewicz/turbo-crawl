# turbo-crawl

> Native-speed, **browserless** web crawler **and Playwright-compatible script
> runner** for AI agents — built on
> [turbo-dom](https://github.com/miaskiewicz/turbo-dom). Fetch + parse + extract
> + drive pages with no headless browser; 100×+ faster on server-rendered pages.

turbo-crawl is two things in one engine, on its own native DOM:

- **A crawler** — point it at a domain and stream page records: indexed
  interactive elements, a link/form graph, an accessibility tree, markdown and
  plain-text views, rendered-HTML capture, CSS/XPath node queries, and
  schema-driven structured extraction. Plus a 33-tool **MCP** interface agents
  drive directly.
- **A drop-in Playwright replacement** — the same `chromium.launch()` →
  `page.goto()` → locators → actions → `expect` API, so existing Playwright
  scripts and tests run **unchanged** — but against turbo-dom instead of a
  browser. No Chromium, no pixels, no layout.

For pages that need JavaScript it runs their scripts on turbo-dom (no browser),
either by mining server-embedded hydration state or by executing page JS inside
a **true V8 isolate** and re-rendering the DOM (see below).

## What makes it different

Most tools in this space pick one lane: a crawler **or** a browser-automation
library, and they get their DOM from a real browser (Playwright/Puppeteer/
Selenium) or an in-process fake DOM with no security isolation (jsdom,
happy-dom). turbo-crawl is unusual on four axes at once:

1. **AI-agent-ready out of the box.** It ships a full **MCP server** (33 tools:
   navigate, click/fill/submit, query, extract, accessibility tree, markdown,
   `evaluate`, …) so an agent drives real pages over stdio with **no browser and
   no glue code** — `npx turbo-crawl-mcp`. Most crawlers are libraries you wrap
   yourself; this one is an agent tool on day one.
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

Status: **v0.1.1 — published and working** ([npm](https://www.npmjs.com/package/@miaskiewicz/turbo-crawl)).
Page + interaction, hardened networking (cookies / `document.cookie` bridge /
robots + crawl-delay / charset / size + redirect caps, HTTP/2 + DNS-cache
dispatcher, 304 conditional-request cache), crawl orchestration, structured
extraction, CSS+XPath query, Playwright locators + compat façade, a no-Chromium
JS-execution render tier, and a 33-tool MCP server. ~100% line coverage
(`npm run test:cov`); benchmarked against other crawlers (above); a Playwright
differential test (SPEC §14) bounds representation drift when Chromium is
installed (dev-only).

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
import { Crawler } from "@miaskiewicz/turbo-crawl";

for await (const rec of new Crawler({ start, maxPages: 500, concurrency: 8 })) {
  // rec.url, rec.status, rec.view.interactiveElements, rec.extracted
}
```

Concurrency + per-host politeness, backoff/retry, canonical-form dedupe, robots,
and depth/page caps are all built in.

## MCP server (agents)

```sh
npx turbo-crawl-mcp          # stdio MCP server (33 tools), e.g.:
# goto, interactive_elements, accessibility_tree, markdown, text, html, links,
# requests, query, get_by, hydration_state, extract, click, fill, submit,
# click_selector, fill_selector, select_option, check, uncheck, get_attribute,
# text_content, inner_html, input_value, is_visible, is_checked, is_enabled,
# count, evaluate, set_user_agent, go_back, go_forward, reload
```

Or embed: `import { createServer } from "@miaskiewicz/turbo-crawl/mcp"`.

## Run Playwright scripts (no browser)

Drop-in compatibility layer so existing Playwright scripts run on the no-JS
engine — **nothing loads playwright or chromium**:

```js
import { chromium, expect } from "@miaskiewicz/turbo-crawl/playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("https://example.com");
await page.getByLabel("Search").fill("widgets");
await page.getByRole("button", { name: "Go" }).click();
await expect(page.getByText("Results")).toBeVisible();
```

Locators (`getByRole/Text/Label/Placeholder/TestId/AltText/Title`, `locator(css)`,
`first/last/nth/filter/count`), actions (`click/fill/check/uncheck/selectOption/
press/type`), accessors, history (`goBack/goForward/reload`), `expect(...)`
web-first assertions, and `evaluate`/`$eval`/`$$eval` (against the rendered DOM)
all work. Pixel/render-only APIs (`screenshot`, `pdf`, `route`, `hover`, …) throw
a clear "no-JS engine" error.

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
timing each. `npm run harness`. Median ms over 5 runs (live network), parity is
each engine's observations vs the Chromium oracle:

| engine | wikipedia | form | js-quotes | parity |
|---|---|---|---|---|
| **turbo-crawl (no-JS)** | **153** | 236 | — *(needs JS)* | ✓ |
| **turbo-crawl (js-fast)** | 355 | **241** | **241** | ✓ |
| **turbo-crawl (js-secure)** | 318 | 235 | 237 | ✓ |
| chromium *(oracle)* | 947 | 652 | 895 | — |
| firefox | 802 | 880 | 895 | ✓ |
| webkit | 1295 | 851 | 847 | ✓ |
| stealth (playwright-extra) | 1020 | 528 | 903 | ✓ |
| patchright | 1029 | 538 | 894 | ✓ |

Every turbo-crawl mode produces the **same observations** as Chromium / Firefox /
WebKit / the stealth browsers — while running 2–6× faster. The harness
auto-detects installed engines (`firefox`/`webkit`, and anti-detect browsers like
`playwright-extra`/`patchright`/`rebrowser-playwright`); see
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
| spider-rs | Rust + N-API | 194 | 3486 | 5.7 |
| got + cheerio (hand-rolled) | Node | 339 | 5590 | 3.6 |
| node-crawler (`crawler`) | Node | 339 | 49624 | 0.4 |
| Scrapy | Python *(subprocess)* | 246 | 49270 | 0.4 |
| Colly | Go *(subprocess)* | 320 | 45664 | 0.4 |

At equal politeness the wall-clock is **network-bound**, so the in-process
crawlers cluster together: turbo-crawl sits in the **top tier** alongside the
dedicated speed engines (crawlee, spider-rs) and ahead of a hand-rolled
got+cheerio loop — while extracting equivalent content and running **no
browser**. The heavyweight engines trail ~15×: Scrapy and Colly pay a fresh
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
