# Crawl benchmark

A **multi-page crawl** benchmark: turbo-surf's `Crawler` vs other open-source
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
**turbo-surf (no-js)**.

**Set B — JS** (`--set=js`): crawlers that execute page JS in a real engine.
Target: `https://quotes.toscrape.com/js/` (+ `/js/page/N/`) — quotes are built
client-side via `document.write` + jQuery, so a **non-JS crawler extracts ~0
quotes** while a JS crawler gets 10/page. Item metric: `.quote .text`. turbo-surf
runs the page JS in its V8 isolate.

## Engines (auto-detected)

turbo-surf runs whenever the native addon is built (`cargo build --release -p
turbo-surf-napi`). Every competitor is lazy-loaded; if its package isn't installed
the row reads `skipped (not installed)`.

| engine | set | needs |
|---|---|---|
| `turbo-surf (no-js)` | nojs | built addon |
| `spider-rs (Rust)` | nojs | `@spider-rs/spider-rs` + `cheerio` |
| `Scrapy (Python)` | nojs | `scrapy` on PATH (CLI subprocess) |
| `Colly (Go)` | nojs | `go` on PATH (CLI subprocess) |
| `crawlee CheerioCrawler` | nojs | `crawlee` |
| `got + cheerio` (hand-rolled BFS) | nojs | `got` + `cheerio` |
| `node-crawler (crawler)` | nojs | `crawler` |
| `x-ray` | nojs | `x-ray` |
| `turbo-surf (js)` | js | built addon |
| `crawlee PlaywrightCrawler` | js | `crawlee` + `playwright` + browser |
| `crawlee PuppeteerCrawler` | js | `crawlee` + `puppeteer` + browser |
| `puppeteer-cluster` | js | `puppeteer-cluster` + browser |

## Installing the optional competitors

We deliberately do **not** vendor these — install what you want to race against:

```sh
# non-JS Node crawlers (incl. spider-rs — the Rust "fastest crawler" claimant)
npm i -D @spider-rs/spider-rs crawlee cheerio got crawler x-ray

# JS crawlers (also need a browser binary)
npm i -D crawlee playwright puppeteer puppeteer-cluster
npx playwright install chromium
```

### Cross-language speed kings (CLI subprocess)

The two crawlers most often cited as the absolute fastest — **Scrapy** (Python)
and **Colly** (Go) — aren't `import`able into Node, so the harness shells out to
them via a thin CLI wrapper (`scrapy_spider.py`, `colly_crawler.go`). Each runs
the SAME same-host BFS, counts the SAME CSS selector, and prints `{pages,items}`
on stdout; the harness times the wall-clock and detects them by probing the tool
on `PATH` (skipped if absent).

```sh
# Scrapy — isolated CLI on PATH (pipx keeps it off the system Python)
brew install pipx && pipx install scrapy

# Colly — Go toolchain; first run downloads colly into the module cache
brew install go
( cd harness/crawlers && go mod tidy )   # one-time: fetch colly + write go.sum
```

> Subprocess engines pay a fixed per-invocation startup (Python import / Go
> link) that dominates at small page caps — read their **pages/s at higher
> `--pages`**, not the raw ms on a 4-page run.

## Output

A table per set: `crawler | pages | items | median ms | pages/s`, turbo-surf rows
flagged with `»`. Each engine is warmed once (untimed), then run `--iters` times;
the reported time is the median.

## How it's wired

- `targets.mjs` — the two targets + the shared `itemSelector`/`itemAttr` so every
  crawler counts items identically.
- `crawlers.mjs` — the registry. Each entry is
  `{ name, set, available(), crawl(target, opts) → { pages, items, ms } }`.
  turbo-surf entries run the whole crawl in Rust via the napi addon (`native.crawl`
  for no-js; a JS BFS over the render tier for the `js` set).
  before extraction.
- `run.mjs` — the CLI/runner: detect, warm, time, report.

Add a competitor: append an entry to `CRAWLERS` in `crawlers.mjs` with an
`available()` probe and a `crawl()` that returns `{ pages, items, ms }`.
