# Crawl benchmark

A **multi-page crawl** benchmark: turbo-crawl's `Crawler` vs other open-source
crawlers on a real, paginated, live site. For each engine we measure **throughput**
(pages/s) and **correctness** (items extracted) on the *same* target, the *same*
page cap, and counted with the *same* selector — so a fast crawler that misses
content is exposed, not rewarded.

> Distinct from `harness/competitive/`, which runs one Playwright *routine* across
> engines and scores parity. This one is a bulk **crawl** race.

```sh
npm run crawl-bench                       # both sets, 20 pages, 3 iters
npm run crawl-bench:js                     # JS set only
node harness/crawlers/run.mjs --set=nojs   # non-JS set only
node harness/crawlers/run.mjs --pages=10 --iters=5
```

Needs **live network**. The page cap is hard-limited to ≤20 with a ~150ms
per-request delay so we don't hammer toscrape.com.

## Two sets

**Set A — non-JS** (`--set=nojs`): crawlers that fetch + parse HTML without running
page JS. Target: `https://books.toscrape.com/` — a server-rendered, paginated
catalog. Item metric: product titles (`.product_pod h3 a`). Compared against
**turbo-crawl (no-js)**.

**Set B — JS** (`--set=js`): crawlers that execute page JS in a real engine.
Target: `https://quotes.toscrape.com/js/` (+ `/js/page/N/`) — quotes are built
client-side via `document.write` + jQuery, so a **non-JS crawler extracts ~0
quotes** while a JS crawler gets 10/page. Item metric: `.quote .text`. Compared
against **turbo-crawl (js-fast)** and **turbo-crawl (js-secure)**.

## Engines (auto-detected)

turbo-crawl always runs (only the repo's existing deps + network). Every
competitor is lazy-loaded; if its package isn't installed the row reads
`skipped (not installed)`.

| engine | set | needs |
|---|---|---|
| `turbo-crawl (no-js)` | nojs | always |
| `spider-rs (Rust)` | nojs | `@spider-rs/spider-rs` + `cheerio` |
| `crawlee CheerioCrawler` | nojs | `crawlee` |
| `got + cheerio` (hand-rolled BFS) | nojs | `got` + `cheerio` |
| `node-crawler (crawler)` | nojs | `crawler` |
| `x-ray` | nojs | `x-ray` |
| `turbo-crawl (js-fast)` | js | `esbuild` (already a dep) |
| `turbo-crawl (js-secure)` | js | `isolated-vm` (optional dep) |
| `crawlee PlaywrightCrawler` | js | `crawlee` + `playwright` + browser |
| `crawlee PuppeteerCrawler` | js | `crawlee` + `puppeteer` + browser |
| `puppeteer-cluster` | js | `puppeteer-cluster` + browser |

## Installing the optional competitors

We deliberately do **not** vendor these — install what you want to race against:

```sh
# non-JS crawlers (incl. spider-rs — the Rust "fastest crawler" claimant)
npm i -D @spider-rs/spider-rs crawlee cheerio got crawler x-ray

# JS crawlers (also need a browser binary)
npm i -D crawlee playwright puppeteer puppeteer-cluster
npx playwright install chromium
```

The two other crawlers commonly cited as the absolute fastest — **Scrapy**
(Python) and **Colly** (Go) — are cross-language and can't be `import`ed into a
Node harness, so they're out of scope here. `spider-rs` (Rust core + N-API
bindings) represents that native-speed class while staying a `node` dependency.

turbo-crawl's `js-secure` row needs the optional `isolated-vm`; if it's absent
that one row is skipped and `js-fast` still runs.

## Output

A table per set: `crawler | pages | items | median ms | pages/s`, turbo-crawl rows
flagged with `»`. Each engine is warmed once (untimed), then run `--iters` times;
the reported time is the median.

## How it's wired

- `targets.mjs` — the two targets + the shared `itemSelector`/`itemAttr` so every
  crawler counts items identically.
- `crawlers.mjs` — the registry. Each entry is
  `{ name, set, available(), crawl(target, opts) → { pages, items, ms } }`.
  turbo-crawl entries use the real `Crawler` with an extract `schema`; JS entries
  set `fetchHtml: jsRenderer({ mode }).fetchHtml` so page JS actually executes
  before extraction.
- `run.mjs` — the CLI/runner: detect, warm, time, report.

Add a competitor: append an entry to `CRAWLERS` in `crawlers.mjs` with an
`available()` probe and a `crawl()` that returns `{ pages, items, ms }`.
