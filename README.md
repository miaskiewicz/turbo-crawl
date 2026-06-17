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

## Lane B — Chromium fallback (optional)

JS-gated pages render through Playwright behind the *same* Page interface; the
base library carries zero Chromium weight.

```js
import { createPlaywrightPage } from "@miaskiewicz/turbo-crawl/adapters/playwright";
const { page, close } = createPlaywrightPage();
```

A `Crawler` can auto-escalate shell-only pages via `{ fallback: playwrightFetcher().fetchHtml }`.

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
