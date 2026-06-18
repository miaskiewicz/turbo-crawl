# turbo-crawl docs

Start with [`../README.md`](../README.md) (overview + benchmarks),
[`../CHANGELOG.md`](../CHANGELOG.md) (what shipped), and [`../CLAUDE.md`](../CLAUDE.md)
(working rules). The **engine** (the Rust workspace + its V8 render tier) is
documented in [`../rust/README.md`](../rust/README.md) and
[`../rust/HEADLESS-HYDRATION.md`](../rust/HEADLESS-HYDRATION.md).

## Per-module reference (`modules/`)

API-level reference for the library modules.

**Networking**
- [`net`](./modules/net.md) · [`cookies`](./modules/cookies.md) ·
  [`robots`](./modules/robots.md) · [`url`](./modules/url.md)

**Crawl orchestration**
- [`page`](./modules/page.md) · [`crawl`](./modules/crawl.md) ·
  [`frontier`](./modules/frontier.md) · [`detect`](./modules/detect.md) ·
  [`batch`](./modules/batch.md) · [`eval-guard`](./modules/eval-guard.md)

**Extraction & interaction**
- [`extract`](./modules/extract.md) · [`visible`](./modules/visible.md) ·
  [`actions`](./modules/actions.md) · [`aria`](./modules/aria.md) ·
  [`dom-ops`](./modules/dom-ops.md) · [`locator`](./modules/locator.md)

**Views & structured data**
- [`markdown`](./modules/markdown.md) · [`ax`](./modules/ax.md) ·
  [`aria-snapshot`](./modules/aria-snapshot.md) · [`text`](./modules/text.md) ·
  [`schema`](./modules/schema.md) · [`query`](./modules/query.md) ·
  [`xpath`](./modules/xpath.md) · [`hydration`](./modules/hydration.md)

**Agent surfaces**
- [`mcp`](./modules/mcp.md) — MCP server (60 tools, incl. `crawl`/`batch`,
  `render`/`set_mode`, `eval_js`/`inject_js` + `latest_dom`/`dom_history`,
  cookies/headers, `snapshot`)
- [`playwright-compat`](./modules/playwright-compat.md) — run Playwright scripts,
  no browser loaded (events / network / routes / persistent context state)

## Harness
- [`../harness/competitive/README.md`](../harness/competitive/README.md) —
  same-script parity + timing vs real browsers.
- [`../harness/crawlers/README.md`](../harness/crawlers/README.md) —
  crawler-vs-crawler throughput.
