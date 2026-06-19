# TODO: WASM browser build of turbo-surf

**Status:** investigated, not started. **Verdict: feasible as an in-browser
extraction/analysis engine — NOT a general crawler** (CORS wall). The repo is
unusually well-positioned: the lower half (rtdom + view + pure core) is pure
compute with no OS deps, and the V8 render tier — the one thing that can't go to
wasm — is cleanly isolated and genuinely unneeded in a browser.

## The idea

Compile turbo-surf's "pseudo-browser" (the rtdom DOM + crawl/extract logic) to
WASM and run it **inside a real browser tab** — analyze/extract from HTML the
page already has, at near-native speed, with no headless browser. In a browser we
already have a real JS engine + real `fetch`, so the deno_core render tier is
redundant there.

## Per-crate feasibility

| Crate / dep | In-browser wasm? | Effort | Notes |
|---|---|---|---|
| `turbo-dom` (rtdom Tree) | ✅ as-is | **S** | pure-Rust (html5ever/markup5ever/rustc-hash); no `std::net/fs/thread/time` |
| `turbo-surf-view` (extract/visible/aria/markdown/query/xpath/hydration/locator/actions) | ✅ | **S** | ~3.7k LOC pure compute; touches core only via the pure `url` module; no time/rand/fs/net |
| core pure modules (`url`/`cookies`/`robots`/`frontier`/`cache`) | ✅ | **S** | only OS-clock use is `now_ms()` (`crawl.rs`) → gate `cfg(wasm)` to `Date.now()` |
| wasm-bindgen façade crate (`parse/extract/markdown/query/aria`) | ➕ new | **S–M** | small glue |
| core net → browser `fetch` | ⚠️ new cfg path | **M** | reqwest has a wasm fetch backend, but native redirect-hop / `Set-Cookie` / streamed byte-cap logic in `net.rs` drops (browser owns those) |
| crawl scheduler → `wasm-bindgen-futures` | ⚠️ rewrite | **M–L** | `crawl.rs` multi-worker `tokio::spawn`/`time` doesn't exist on wasm32 |
| `turbo-surf-transform` (swc) | ⚠️ possible | **M** | swc has official wasm builds but dominates `.wasm` size; **omit from MVP** |
| `turbo-surf-render` (deno_core/V8) | ❌ impossible | ∞ | V8 is native C++; can't compile to wasm. **Unneeded in-browser** (host has a JS engine). Imported only by mcp/napi — cleanly separable |
| `turbo-surf-napi` / `turbo-surf-mcp` | ➖ N/A | — | Node addon / stdio binary; not browser artifacts |

## Hard constraints

- **CORS.** A tab can only `fetch()` cross-origin with permissive
  `Access-Control-Allow-Origin`. Most sites don't send it → **arbitrary
  cross-origin crawling from a browser tab is impossible**. Browser build is
  realistically: (a) HTML the host page already has, (b) same-origin /
  CORS-permitted URLs, or (c) via a cooperating proxy (defeats the premise).
- **No render tier.** Don't port deno_core. In-browser, let the host page run its
  own scripts in the host engine; hand the resulting HTML/DOM to the wasm view
  layer. (If rtdom-as-DOM parity is wanted, re-create the `browser_env` binding
  against the host JS engine via Worker/iframe — large, optional.)

## Recommended MVP (first step)

Add a `turbo-surf-wasm` crate (or a `wasm` feature) depending on `turbo-dom` +
`turbo-surf-view`, with `turbo-surf-core` reduced to its pure `url` module behind
a feature flag so **reqwest/tokio never enter the wasm dep graph**. Expose
`wasm-bindgen` fns: `parse_html(&str) -> Handle`, then `extract`, `markdown`,
`query`, `aria_snapshot` over the handle. Proves rtdom+view runs in-browser at
near-native speed against HTML the page already has — no CORS exposure, no render
tier. Almost pure packaging over already-pure code.

Defer net/crawl (CORS-limited). Never port render (impossible + unnecessary).

## Pointers

- No crate declares any `wasm32` target / `cfg(target_arch="wasm32")` today —
  greenfield.
- Seam: `turbo-surf-view` → core only via `turbo_surf_core::url::{resolve,is_http_url}`
  (`extract.rs`, `markdown.rs`, `actions.rs`, `schema.rs`).
- `turbo-surf-render` consumers: only `turbo-surf-mcp` + `turbo-surf-napi`.
