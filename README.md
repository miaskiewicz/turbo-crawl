# turbo-crawl

> Native-speed, **browserless** web crawler for AI agents — built on
> [turbo-dom](https://github.com/miaskiewicz/turbo-dom). Fetch + parse + extract
> with no headless browser; 100×+ faster on server-rendered pages.

turbo-crawl turns turbo-dom into a headless, agent-grade fetch/extract engine:
indexed interactive elements, a link/form graph, an accessibility tree, markdown
and plain-text views, rendered-HTML capture, CSS/XPath node queries, and
schema-driven structured extraction — plus an MCP interface agents drive
directly. It is **a crawler, not a browser**: no pixels, no page JS, no layout.
A Chromium fallback (Lane B) handles JS-gated pages behind the same API.

See [SPEC.md](./SPEC.md) for the full design and phase plan.

Status: **alpha (v0)**. Phases 0–5 implemented: Page + interaction, networking
(cookies incl. `document.cookie` bridge / robots + crawl-delay / charset /
size + redirect caps), crawl orchestration, structured extraction, CSS+XPath
query, the MCP server, and the optional Playwright (Lane B) adapter.
**100% line coverage** (`npm run test:cov`); a Playwright differential test
(SPEC §14) bounds representation drift when Chromium is installed.

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
page.html();                // serialized DOM (rendered DOM behind the Lane-B adapter)
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
  // rec.url, rec.status, rec.lane, rec.view.interactiveElements, rec.extracted
}
```

Concurrency + per-host politeness, backoff/retry, canonical-form dedupe, robots,
and depth/page caps are all built in.

## MCP server (agents)

```sh
npx turbo-crawl-mcp          # stdio MCP server: goto, interactive_elements, click, fill,
                             # submit, extract, query, markdown, text, html, links, …
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
press/type`), accessors, history (`goBack/goForward/reload`), and `expect(...)`
web-first assertions all work. JS-only APIs (`evaluate`, `screenshot`, `route`,
`hover`, …) throw a clear "needs the JS-execution tier" error.

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

`isolated-vm` + `esbuild` are **optional** deps — only needed for `mode:"secure"`
(the `fast` backend uses Node's built-in `vm`). ESM-module page scripts and
page-initiated `fetch` are not yet handled; embedded data is covered by
`hydrationState()`. See [docs/js-execution-tier.md](./docs/js-execution-tier.md).

`detectJsRequired(document)` flags shell-only pages, and `Crawler` accepts a
generic `{ fallback: fetchHtml }` to route them to whatever renderer you plug in.

> **Playwright is not a dependency.** It's a **dev-only** tool used solely by the
> differential test (`test/differential.test.mjs`) to sanity-check output parity
> against Chromium. Nothing in the shipped library loads Playwright or Chromium.
> (Goal: *API* compatibility so Playwright-style scripts can run on this engine —
> not running Playwright itself.)

## Development

```sh
npm install        # also wires the pre-commit hook (oxlint → biome → cc-check → tsgo)
npm test           # node --test
npm run test:cov   # coverage (src is 100% line-covered)
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
