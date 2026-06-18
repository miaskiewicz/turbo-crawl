# turbo-crawl

> Native-speed, **browserless** web crawler + **MCP server** for AI agents — built
> on [turbo-dom](https://github.com/miaskiewicz/turbo-dom). Fetch + parse + extract
> + run page JS with no headless browser; 100×+ faster on server-rendered pages.

turbo-crawl is a single native (Rust) engine — no Chromium, no pixels, no layout:

- **A crawler** — point it at a domain and stream page records: indexed interactive
  elements, a link/form graph, an accessibility tree, markdown and plain-text views,
  rendered-HTML capture, CSS/XPath node queries, and schema-driven structured
  extraction.
- **An agent tool** — a 60-tool **MCP** server agents drive directly over stdio
  (`crawl`, `batch`, navigate, click/fill/submit, query, extract, accessibility
  tree, markdown, `render`/`eval_js`/`inject_js`, cookies/headers, `snapshot`).

For pages that need JavaScript it runs their scripts — either by mining
server-embedded hydration state or by executing page JS inside a **true V8 isolate**
(no browser) and re-rendering the DOM. Its page API is Playwright-shaped: the
benchmark suite drives the engine with unmodified Playwright scripts.

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
2. **Crawler + agent surface on one native engine.** The same engine bulk-crawls a
   domain and serves the MCP tools — no browser anywhere in the stack. Its page API
   is Playwright-shaped (the benchmark harness runs unmodified Playwright routines
   on it).
3. **Its own DOM, not a browser's.** turbo-dom is a native + WASM HTML parser
   with a lazy copy-on-write DOM — native-speed parse, no pixels/layout/IPC.
4. **A V8 isolate to run page JS + re-render.** Page (or your own) JavaScript runs
   inside a real V8 isolate (a `deno_core` runtime — host heap unreachable from the
   guest, with a runaway-execution budget) against the native rtdom DOM, then
   re-renders. Most JS-capable crawlers instead drive a full headless browser, or
   run page scripts in-process with a fake DOM that offers **no real security
   isolation** (Node's `vm` is [explicitly not a security
   boundary](https://nodejs.org/api/vm.html); cf. happy-dom
   [CVE-2025-61927](https://github.com/capricorn86/happy-dom/wiki/JavaScript-Evaluation-Warning)).
   Running hostile page JS in a true isolate against a lightweight DOM is rare.

See [CHANGELOG.md](./CHANGELOG.md) for what shipped and
[rust/README.md](./rust/README.md) for the engine internals.

Status: **v0.2.0 — working** ([npm](https://www.npmjs.com/package/@miaskiewicz/turbo-crawl)).
A native Rust engine (7-crate workspace on the `turbo-dom` crate): hardened
networking (cookies / `document.cookie` bridge / robots + crawl-delay / charset /
size + redirect caps, HTTP/2 + a pooled client, 304 conditional cache), crawl
orchestration (global + per-host concurrency, token-bucket politeness, backoff/retry,
canonical dedupe, depth/page caps), structured extraction, CSS+XPath query, a
no-Chromium JS render tier (a true V8 isolate over the native DOM) with re-enterable
live-heap `eval_js`/`inject_js` + a DOM-history trail, and a 60-tool MCP server
(native binary). Benchmarked against real browsers + other crawlers (below).

## Install

The npm package is a thin launcher that spawns the native binary:

```sh
npm install -g @miaskiewicz/turbo-crawl   # provides the `turbo-crawl-mcp` command
# …or run without installing:
npx -y turbo-crawl-mcp
```

Node ≥ 20 to launch; the engine is a prebuilt per-platform native binary (no Node
runtime hosts it). The Rust crates are also published to crates.io for embedding.

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

`render`/`set_mode` switch the Page into the JS render tier (a true V8 isolate over
the native DOM); then `eval_js` and `inject_js` run against the **live render heap**
(page globals, handlers) and each mutation appends to a DOM-history trail readable
via `latest_dom`/`dom_history`.

### Set it up in Claude Code

Register the stdio server once and every Claude Code session gets the tools:

```sh
claude mcp add turbo-crawl -- npx -y turbo-crawl-mcp
```

`npx -y turbo-crawl-mcp` resolves + spawns the native binary — one process, no Node
hosting it, no Chromium. From a checkout, point at a local build instead:

```sh
cargo build --release -p turbo-crawl-mcp --manifest-path rust/Cargo.toml
claude mcp add turbo-crawl -- "$PWD/rust/target/release/turbo-crawl-mcp"
```

Verify with `claude mcp list`. Scope to one project with `--scope project` (writes
`.mcp.json`), or commit a `.mcp.json`:

```json
{
  "mcpServers": {
    "turbo-crawl": { "command": "rust/target/release/turbo-crawl-mcp", "args": [] }
  }
}
```

(For other MCP clients — Claude Desktop, Cursor — point their MCP config's `command`
at the same binary or `npx -y turbo-crawl-mcp`.)

## Competitive benchmark

`harness/competitive/` runs the **same Playwright script** on turbo-crawl and a
fleet of real browsers, scoring output **parity** against a Chromium oracle and
timing each. `npm run harness`. turbo-crawl drives every routine through its native
engine — turbo-dom + a `deno_core` V8 render tier for page JS — with **no Chromium**.
Median ms over 8 runs (live network), parity is each engine's observations vs the
Chromium oracle:

| engine | wikipedia | js-quotes | parity |
|---|---|---|---|
| **turbo-crawl (no-JS)** | **142** | — *(needs JS)* | ✓ |
| **turbo-crawl (JS)** | —‡ | **132** | ✓ |
| chromium *(oracle)* | 932 | 933 | — |
| firefox | 727 | 925 | ✓ |
| webkit | 1232 | 964 | ✓ |

Every engine produces the **same observations** as Chromium / Firefox / WebKit
(parity ✓) — and turbo-crawl is the **fastest in the table** on both axes. The
Wikipedia click-through runs in **142 ms** (**~6.6× faster than Chromium**, 932),
and the **real jQuery on `quotes.toscrape.com/js`** — the same 10 quotes Chromium
extracts — in **132 ms** (**~7× faster than Chromium**, 933), inside a true V8
isolate over a native rtdom DOM, **no Chromium process**. It stays network-bound
via a **pooled HTTP client** (connection/TLS reuse across pages), a **persistent V8
isolate** whose **DOM install is reused across same-page `page.evaluate`s** (parse
once per page, ~0.5 ms/call after), an **external-script cache** (jQuery fetched
once, not per page), a **per-page parse cache**, and a back-forward snapshot cache
so `goBack` restores instead of re-fetching. Profilers: `cargo bench -p
turbo-crawl-view` (Rust microbench) + `harness/hotpath/rust-hotpath.mjs`.

‡ JS mode runs the *page's own* scripts; on a server-rendered page like Wikipedia
that over-runs (use no-JS there — 142 ms, 4/4). The `form` routine is omitted this
run (httpbin.org was returning 503/timeouts for every engine).

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
| **turbo-crawl (no-js)** | **native Rust, browserless** | 339 | 3271 | **6.1** |
| spider-rs | Rust + N-API | 194 | 3486 | 5.7 |
| got + cheerio (hand-rolled) | Node | 339 | 5590 | 3.6 |
| node-crawler (`crawler`) | Node | 339 | 49624 | 0.4 |
| Scrapy | Python *(subprocess)* | 246 | 49270 | 0.4 |
| Colly | Go *(subprocess)* | 320 | 45664 | 0.4 |

**Head-to-head vs CheerioCrawler** (the closest competitor) — the **same** 20-page
crawl, `maxConcurrency = 2`, median of 5 warm runs
(`node harness/crawlers/head-to-head.mjs`). With throttling **off** (raw engine
speed — the truest apples-to-apples, since the two *throttle models* differ)
turbo-crawl is clearly ahead:

| engine | politeness | median ms | pages/s |
|---|---|---|---|
| **turbo-crawl (no-js)** | none (raw) | **1977** | **10.1** |
| crawlee CheerioCrawler | none (raw) | 2748 | 7.3 |
| crawlee CheerioCrawler | 150 ms rate | 2634 | 7.6 |
| **turbo-crawl (no-js)** | 150 ms (strict) | 3307 | 6.0 |

Raw, **turbo-crawl is ~1.4× faster**. Under the "150 ms politeness" rows it looks
slower only because turbo-crawl's per-host gate is a **strict** interval (it really
waits 150 ms between requests), whereas crawlee's `maxRequestsPerMinute` is a
lenient sliding window that lets a short 20-page burst through near-raw. Same
content (339 items), no browser.

At equal politeness the multi-engine wall-clock is **network-bound**, so the
in-process crawlers cluster together: turbo-crawl sits in the **top tier** alongside
the dedicated speed engines (crawlee, spider-rs) and ahead of a hand-rolled
got+cheerio loop — while extracting equivalent content and running **no
browser**. turbo-crawl runs the whole BFS — fetch, parse, same-host gate, per-page
item count — in its native Rust engine, and is **~13× ahead of Scrapy / Colly**.
The heavyweight
engines trail ~15×: Scrapy and Colly pay a fresh
process startup per crawl (the harness shells out to their CLIs), and
node-crawler's per-request overhead is high. turbo-dom's raw parse advantage
doesn't show here — at 20 live pages, network swamps a sub-millisecond parse;
it shows in-memory instead (links ~18k/s, crawl ~14k pages/s, below). And unlike
every engine in this table, the *same* turbo-crawl also runs Playwright scripts
(parity table above).

### JS-executing crawlers — turbo-crawl vs real browsers

The other set targets `quotes.toscrape.com/js`, where quotes are built
client-side (a non-JS crawler sees ~0). turbo-crawl runs the page's own scripts in
a true V8 isolate over its native DOM, while every competitor drives a **real
headless Chromium** (`npm run crawl-bench:js`, 10 pages, median of 3):

| crawler | JS engine | items | median ms | pages/s |
|---|---|---|---|---|
| **turbo-crawl (JS)** | **V8 isolate, no browser** | 100 | **2989** | **3.35** |
| crawlee `PuppeteerCrawler` | headless Chromium | 100 | 5074 | 2.0 |
| crawlee `PlaywrightCrawler` | headless Chromium | 100 | 6173 | 1.6 |
| puppeteer-cluster | headless Chromium | 100 | 17062 | 0.6 |

turbo-crawl runs each page's own scripts in a **true V8 isolate** over the native
rtdom DOM (the same path that renders `quotes.toscrape.com/js`, external scripts
cached across pages) — the **fastest engine here**, extracting the same 100 quotes
a real browser does **~2–6× faster than the browser-driving crawlers**, with no
Chromium process and honoring the 150 ms politeness delay. Running page JS in a
true isolate against a lightweight DOM is rare — most crawlers either drive a full
browser (this table) or use an in-process fake DOM with no real isolation. See
[harness/crawlers/README.md](./harness/crawlers/README.md) — competitors
auto-detect and missing ones are skipped; install them with
`npm i -D @spider-rs/spider-rs crawlee cheerio got crawler` (+ `brew install
pipx go && pipx install scrapy` for Scrapy/Colly). (Machine/run dependent.)

## Development

The engine is Rust (`rust/` workspace); the only JS is the launcher (`cli.js`/
`index.js`) + the dev harness.

```sh
cd rust
cargo test --workspace                      # the offline suite
cargo clippy --workspace --all-targets
cargo fmt
cargo build --release -p turbo-crawl-mcp    # the MCP binary the launcher spawns
cargo bench -p turbo-crawl-view             # Rust microbench (parse / views)
```

From the repo root: `npm run check` lints/formats the launcher JS + runs the Rust
gate; `npm run harness` / `crawl-bench` / `hotpath` run the benchmarks (install
`playwright` + `crawlee` ad-hoc for the competitor engines).

## License

MIT
