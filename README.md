# turbo-crawl

> Native-speed, **browserless** web crawler for AI agents — built on
> [turbo-dom](https://github.com/miaskiewicz/turbo-dom). Fetch + parse + extract
> with no headless browser; 100×+ faster on server-rendered pages.

turbo-crawl turns turbo-dom into a headless, agent-grade fetch/extract engine:
indexed interactive elements, a link/form graph, an accessibility tree, a
markdown view, and schema-driven structured extraction — plus an MCP interface
agents drive directly. It is **a crawler, not a browser**: no pixels, no page
JS, no layout. A Chromium fallback (Lane B) handles JS-gated pages behind the
same API.

See [SPEC.md](./SPEC.md) for the full design and phase plan.

Status: **alpha (v0)**. Phases 0–5 implemented: Page + interaction, networking
(cookies/robots/charset/limits), crawl orchestration, structured extraction, the
MCP server, and the optional Playwright (Lane B) adapter.

## Install

```sh
npm install @miaskiewicz/turbo-crawl
```

Pure ESM, Node ≥ 20.

## Drive a page (no browser)

```js
import { Page } from "@miaskiewicz/turbo-crawl";

const page = new Page();
await page.goto("https://example.com");

page.interactiveElements(); // [{ i, tag, role, name, href, visible, jsHandler, ... }]
page.links();               // absolute http(s) targets
page.markdown();            // readable Markdown of the main content
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
npx turbo-crawl-mcp          # stdio MCP server: goto, interactive_elements, click, extract, …
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
npm install        # also wires the pre-commit hook (oxlint + biome)
npm test           # node --test
npm run lint       # oxlint
npm run format     # biome format --write
npm run check      # lint + format:check + test (the CI gate)
```

## License

MIT
