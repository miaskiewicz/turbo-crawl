# turbo-crawl — Rust port

Native-speed core of turbo-crawl. Premise: turbo-dom ships as a pure Rust crate,
so the browserless crawler is Rust too. The only piece that *must* stay JS is the
`@playwright/test` drop-in façade (agents `import` it inside their own Node
process); it's a thin shim over the napi addon — all the muscle is Rust.

turbo-dom is consumed from **crates.io** as the `turbo-dom-parser` crate
(`{ package = "turbo-dom", version = "0.3.1" }`) — its pure-Rust `rtdom::Tree`
(handle-based `u32` DOM, no napi/wasm boundary).

## Crates

| Crate | Scope |
|-------|-------|
| `turbo-crawl-core` | Tier 1 — net / cookies / robots / url / frontier / crawl scheduling / cache / measure |
| `turbo-crawl-page` | Tier 2 — `TurboNavigator` (fetch+parse over `rtdom::Tree`) |
| `turbo-crawl-view` | extraction & views — extract / visible / aria / ax / locator / markdown / text / schema / query / xpath / hydration / dom-ops / actions |
| `turbo-crawl-render` | Tier 3 — `deno_core` isolate + the rtdom↔V8 DOM binding (JS execution / hydration) |
| `turbo-crawl-transform` | swc TS/JSX → classic JS for the render tier |
| `turbo-crawl-napi` | the `.node` addon — in-process bridge from the core to Node (+ stateful `Session`) |
| `turbo-crawl-mcp` | stdio JSON-RPC MCP server — native binary, full 60-tool surface (parity with the JS server) over a stateful session |

`cargo test` runs the full offline suite across the workspace (200+ tests);
`cargo clippy --workspace --all-targets` and `cargo fmt` are clean.

## Tier 1 — `turbo-crawl-core`

Direct ports of the JS modules, same behavior and edge cases:

- `url` — `resolve` / `canonicalize` (tracking-param strip, query sort, frag drop) /
  `is_http_url`. Frontier dedupe basis.
- `frontier` — canonical-dedup URL queue with depth + ring cursor.
- `robots` — robots.txt parse, per-agent grouping, longest-match Allow/Disallow with
  `*`/`$` wildcards (hand-rolled glob, no regex dep), TTL cache; injected
  `RobotsFetcher` → offline-testable.
- `cookies` — RFC 6265 subset `CookieJar` (domain/path scope, Secure, HttpOnly,
  Expires/Max-Age, SameSite; `storageState` round-trip). Times are `f64` ms (session
  cookie = `f64::INFINITY`). Self-contained HTTP-date parser (no chrono).
- `net` — `fetch_html` over reqwest (gzip/br, rustls, HTTP/2). Charset sniff, byte
  cap, content-type gate, CookieJar round-trip, manual per-hop redirect follow, and a
  **shared pooled `build_client()`** passed via `FetchOptions::client` so connections
  + TLS sessions are reused across pages.
- `crawl` — frontier-driven scheduling: global + per-host concurrency, per-host
  politeness, retry/backoff, depth/page caps, robots gate. Fetch+parse seam is the
  `Navigator` trait (tier-2 `Page` implements it).
- `cache` / `measure` — `ResponseCache` (304/storageState) and crawl summaries.

## Tier 2 — `turbo-crawl-page`

`TurboNavigator` implements `crawl::Navigator` — fetches via `net::fetch_html`,
parses with `Tree::parse`, projects a `Nav` (title + absolute-resolved `<a href>`s).
The tier-1 `crawl::crawl(opts, nav)` driver runs unchanged over it. `parse_nav` is
pure (no network) and offline-tested end to end against the scheduler.

## views — `turbo-crawl-view`

The extraction/interaction surface over the same `rtdom::Tree`: `extract`, `visible`
(cascade), `aria`/`ax`/`aria_snapshot`, `locator` (by_role/text/label), `markdown`,
`text`, `schema`, `query`, `xpath`, `hydration`, `dom_ops` (checked/editable/css/
select), `actions` (fill/submit/click-intent). All pure + offline-tested; a
differential `tests/parity.rs` checks them against a committed JS golden.

## Tier 3 — `turbo-crawl-render`

The JS-execution path, end to end over a **real DOM**. The page's own scripts run on
a `deno_core` V8 isolate against a genuine `document`, mutate the turbo-dom tree in
place, and the render returns the hydrated HTML (the Lane B contract).

- Boots a **`deno_core` V8 isolate** (true isolate — host heap unreachable from
  guest; a runaway-execution **budget** watchdog terminates a wedged script).
- **The DOM is a native `rtdom`↔V8 binding** — `browser_env`, vendored from
  [turbo-test](../../turbo-test) (its battle-tested binding that runs React +
  Testing Library). A JS DOM node is a V8 object holding a turbo-dom handle in an
  internal field; methods/accessors are native callbacks straight onto `Tree`. No
  JS-DOM-in-JS-VM indirection. See [`src/browser_env.rs`](crates/turbo-crawl-render/src/browser_env.rs)
  for the vendor/sync story (verbatim copy + a one-command re-vendor script; the
  turbo-crawl-specific deltas — `install_html`/`document_html` and the env bootstrap
  — live separately and are never patched into the upstream file).
- The runtime in [`src/runtime.rs`](crates/turbo-crawl-render/src/runtime.rs) grafts
  that binding onto deno_core's context, then layers the non-DOM `window` env a real
  page needs (`navigator`, `location`, virtual timers + real microtasks, `fetch`/XHR
  **over the tier-1 net stack**, `URL`, `crypto`(+`subtle`), `MessageChannel`,
  `ReadableStream`, `AbortController`, `BroadcastChannel`, `WebSocket`,
  `document.cookie` bridged to the shared `CookieJar`, observers, history) + the
  hydration pump (executes injected `<script>` chunks, drains to quiescence).
- **`fetch` is real** (async, event-loop-driven; relative URLs resolve against the
  page base) — promise/`await`/timer-driven hydration settles before serialization.
- `run_with_dom` (the sync `page.evaluate` path) reuses a **thread-persistent
  isolate across pages** — the ~20 ms boot is paid once, then ~5 ms/call. Page-JS
  isolation across pages is intentionally relaxed (a crawl doesn't need it).
- `transform` (`turbo-crawl-transform`, swc) turns a TS/JSX bundle into classic JS
  so it runs under the tier.

## glue — `turbo-crawl-napi` + the Playwright shim

`turbo-crawl-napi` is the `.node` addon: a stateless functional surface (markdown /
text / links / extract / getBy / accessors / actions / evaluate / render / transform)
plus async `fetchHtml` / `request` / `crawl` and a stateful `Session` (retained tree,
worker thread), plus `nodeSnapshot` (a one-crossing batch of a node's state reads).
The `rust/playwright-shim/` package is the `@playwright/test` drop-in backed by it
(Page / Locator / expect's five assertion classes / BrowserContext / fixtures /
`chromium`, plus a `--import register` resolve redirect so vanilla specs run on the
no-browser Rust engine, unedited). Coverage map:
[`playwright-shim/LIMITATIONS.md`](./playwright-shim/LIMITATIONS.md).

## Build / test

```
cd rust
cargo test --workspace        # full offline suite
cargo clippy --workspace --all-targets
cargo fmt
cargo build --release -p turbo-crawl-napi   # build the .node addon (then node addon tests / harness)
```
