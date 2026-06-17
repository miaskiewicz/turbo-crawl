# turbo-crawl — Rust port

Native-speed core of turbo-crawl. Premise: turbo-dom ships as a pure Rust crate,
so the browserless crawler can be Rust too. The only piece that *must* stay JS is
the `@playwright/test` drop-in façade (agents `import` it inside their own Node
process) — everything else ports.

## Tiers

| Tier | Scope | Status |
|------|-------|--------|
| **1** | net / cookies / robots / url / frontier / crawl-scheduling — pure logic + HTTP | ✅ this branch |
| 2 | `Page` (fetch+parse over the turbo-dom crate) + views (extract/visible/aria/locator/markdown) | pending turbo-dom crate |
| **3** | JS-execution tier — `deno_core` isolate + ops binding the native DOM | 🟡 scaffold done; real DOM ops pending turbo-dom crate |
| glue | napi-rs `.node` addon + thin JS `@playwright/test` shim | later |

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

### Build / test

```
cd rust
cargo test          # 33 unit tests, fully offline
cargo clippy --all-targets
cargo fmt
```

## Tier 3 scaffold — `turbo-crawl-render`

Proves the JS-execution path end to end without turbo-dom yet:

- Boots a **`deno_core` V8 isolate** (true isolate by default — host heap
  unreachable from guest, the security property the old `node:vm` backend lacked).
- `DomBackend` trait = the native DOM seam. Page JS calls `document.querySelector`
  → V8 → `#[op2]` → `DomBackend` → back. No JS-DOM-in-JS-VM indirection; the DOM
  lives in Rust beside the parser.
- A stub backend (a fixed `<h1 id="title">Hello</h1>`) drives the tests offline,
  proving the op roundtrip for `querySelector` / `textContent` / `getAttribute`.

When the turbo-dom crate lands, implement `DomBackend` on it and the bootstrap
grows the rest of the global surface (window/navigator/timers/fetch/cookie jar).

```rust
pub trait DomBackend {
    fn query_selector(&self, selector: &str) -> Option<u32>;
    fn text_content(&self, node: u32) -> Option<String>;
    fn get_attribute(&self, node: u32, name: &str) -> Option<String>;
}
```

### Seam for tier 2

```rust
#[async_trait]
pub trait Navigator: Send + Sync {
    async fn goto(&self, url: &str) -> Result<Nav, String>;
}
```

Implement `Navigator` on the turbo-dom-backed `Page` and the existing
`crawl::crawl(opts, nav)` driver runs unchanged.
