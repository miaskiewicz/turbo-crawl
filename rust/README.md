# turbo-crawl — Rust port

Native-speed core of turbo-crawl. Premise: turbo-dom ships as a pure Rust crate,
so the browserless crawler can be Rust too. The only piece that *must* stay JS is
the `@playwright/test` drop-in façade (agents `import` it inside their own Node
process) — everything else ports.

turbo-dom is consumed as the **`turbo-dom-parser` crate** with
`default-features = false, features = ["rust-runtime"]` — its pure-Rust
`rtdom::Tree` (no napi/wasm boundary). The crate is currently wired via a path
dep (`/Users/.../turbo-dom`); swap to a git/version dep once published.

## Tiers

| Tier | Scope | Status |
|------|-------|--------|
| **1** | net / cookies / robots / url / frontier / crawl-scheduling — pure logic + HTTP | ✅ |
| **2** | `Page`/`Navigator` over turbo-dom (fetch+parse, link/title extraction) | ✅ navigator; views (extract/visible/aria/locator/markdown) pending |
| **3** | JS-execution tier — `deno_core` isolate + ops binding the native DOM | ✅ real `DomBackend` over `rtdom::Tree`; global bootstrap pending |
| glue | napi-rs `.node` addon + thin JS `@playwright/test` shim | later |

43 offline tests across the workspace (`cargo test`).

## Tier 1 — `turbo-crawl-core`

Direct ports of the JS modules, same behavior, same edge cases:

- `url` — `resolve` / `canonicalize` (tracking-param strip, query sort, frag drop)
  / `is_http_url`. Frontier dedupe basis.
- `frontier` — canonical-dedup URL queue with depth + ring cursor.
- `robots` — robots.txt parse, per-agent grouping, longest-match Allow/Disallow
  with `*`/`$` wildcards (hand-rolled glob, no regex dep), TTL cache. Fetch is an
  injected `RobotsFetcher` trait → offline-testable.
- `cookies` — RFC 6265 subset `CookieJar` (domain/path scope, Secure, HttpOnly,
  Expires/Max-Age, SameSite). Times are `f64` ms so a session cookie is
  `f64::INFINITY`, matching the JS `Infinity` sentinel. Self-contained HTTP-date
  parser (no chrono).
- `net` — `fetch_html` over reqwest (gzip/br/deflate, rustls). Charset sniff,
  8 MiB streamed byte cap, content-type gate, CookieJar round-trip, and manual
  per-hop redirect follow (cookie re-derive + fetch-spec method rewrite) when
  `max_redirects` is set. Pure helpers unit-tested offline; `fetch_html` is the
  live-IO seam.
- `crawl` — frontier-driven scheduling: global + per-host concurrency, per-host
  politeness, retry with exponential backoff, depth/page caps. The fetch+parse
  seam is the `Navigator` trait — the tier-2 `Page` implements it. robots
  integration lands with that wiring.

## Tier 2 — `turbo-crawl-page`

The real fetch+parse seam, over turbo-dom's pure-Rust `rtdom::Tree`:

- `TurboNavigator` implements `crawl::Navigator` — fetches via
  `turbo_crawl_core::net::fetch_html`, parses with `Tree::parse`, projects a
  `Nav`. The tier-1 `crawl::crawl(opts, nav)` driver runs unchanged over it.
- `parse_nav(html, final_url, status)` is **pure** (no network): extracts the
  `<title>` and every `<a href>` resolved to an absolute URL against the final
  URL. Unit-tested offline, plus an end-to-end test that drives the crawl
  scheduler over a fixture navigator (real parse, no sockets).

```rust
#[async_trait]
pub trait Navigator: Send + Sync {
    async fn goto(&self, url: &str) -> Result<Nav, String>;
}
```

Still pending (task #4): the view/extraction modules (extract / visible / aria /
locator / markdown / …) over the same `Tree` API.

## Tier 3 — `turbo-crawl-render`

The JS-execution path, end to end over the real DOM:

- Boots a **`deno_core` V8 isolate** (true isolate by default — host heap
  unreachable from guest, the security property the old `node:vm` backend lacked).
- `DomBackend` trait = the native DOM seam. Page JS calls `document.querySelector`
  → V8 → `#[op2]` → `DomBackend` → back. No JS-DOM-in-JS-VM indirection; the DOM
  lives in Rust beside the parser.
- `TreeDom` implements `DomBackend` over `rtdom::Tree` — node ids ARE turbo-dom
  handles (`u32`), so the bridge is zero-translation. Tested by parsing real HTML
  and reading it back through page JS.

```rust
pub trait DomBackend {
    fn query_selector(&self, selector: &str) -> Option<u32>;
    fn text_content(&self, node: u32) -> Option<String>;
    fn get_attribute(&self, node: u32, name: &str) -> Option<String>;
}
```

Still pending (task #7): grow the bootstrap into the full global surface
(window / navigator / timers / fetch / cookie jar) so the page's own scripts run.

## Build / test

```
cd rust
cargo test               # 43 offline tests across the workspace
cargo clippy --all-targets
cargo fmt
```
