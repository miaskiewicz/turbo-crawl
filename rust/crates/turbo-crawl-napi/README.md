# @miaskiewicz/turbo-crawl-native

The native (Rust) engine for turbo-crawl, exposed to Node as a napi-rs addon —
the in-process bridge from the Rust core to JavaScript. The thin
`@playwright/test` shim and the npm package consume this.

## Surface

`require('@miaskiewicz/turbo-crawl-native')` → (see `index.d.ts`):

- `fetchHtml(url)` / `crawl(optsJson)` — async (net + crawl scheduler)
- `markdown` · `text` · `html` · `links` · `interactiveElements` ·
  `accessibilityTree` · `ariaSnapshot` · `hydrationState` · `detect` ·
  `query` · `extract` — synchronous view/extract passes over an HTML string

Stateless by design: Node passes the HTML, each call parses with turbo-dom and
runs the Rust pass. The shim caches the fetched HTML so `goto` + many reads stay
cheap, and nothing holds a (non-`Send`) DOM tree across the FFI boundary.

## Build

```
# dev (one cdylib for the host; index.js copies it to a .node and loads it)
cargo build -p turbo-crawl-napi
node __test__/smoke.cjs        # loads the addon in Node and exercises it

# packaged prebuilt (.node per platform, via napi-rs)
npm install && npx napi build --platform --release
```

## Distribution

`.github/workflows/rust-napi-prebuild.yml` builds `turbo-crawl.<triple>.node`
for macOS (arm64/x64), Linux (x64 + **native** arm64), and Windows (x64), then
on a `v*` tag publishes this package with all prebuilt binaries. `index.js`
resolves the right binary at load (with a local-cargo-build fallback for dev).

aarch64-linux builds on `ubuntu-24.04-arm` (native), not an x86 cross-compile.
