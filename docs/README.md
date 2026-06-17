# turbo-crawl docs

Start with [`../CLAUDE.md`](../CLAUDE.md) (working rules), [`../SPEC.md`](../SPEC.md)
(design), and [`../STATUS.md`](../STATUS.md) (current capabilities).

## Design & plans
- [`js-execution-tier.md`](./js-execution-tier.md) — the no-Chromium JS-render tier
  (fast `node:vm` + secure `isolated-vm`/WASM backends), and what's not handled.

## Per-module reference (`modules/`)

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

**JS-execution render tier (`src/render/`)**
- [`render-index`](./modules/render-index.md) ·
  [`render-backend-fast`](./modules/render-backend-fast.md) ·
  [`render-backend-secure`](./modules/render-backend-secure.md) ·
  [`render-scripts`](./modules/render-scripts.md) ·
  [`render-page-fetch`](./modules/render-page-fetch.md) ·
  [`render-bundle-modules`](./modules/render-bundle-modules.md) ·
  [`render-isolate-entry`](./modules/render-isolate-entry.md) ·
  [`render-isolate-polyfills`](./modules/render-isolate-polyfills.md)

**Agent surfaces**
- [`mcp`](./modules/mcp.md) — MCP server (60 tools, incl. `crawl`/`batch`,
  `render`/`set_mode`, `eval_js`/`inject_js` + `latest_dom`/`dom_history`,
  cookies/headers, `snapshot`)
- [`playwright-compat`](./modules/playwright-compat.md) — run Playwright scripts,
  no browser loaded (events / network / routes / persistent context state)

## Harness
- [`../harness/competitive/README.md`](../harness/competitive/README.md) —
  same-script parity + timing vs real browsers.
