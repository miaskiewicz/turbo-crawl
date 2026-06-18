# CLAUDE.md — working rules for turbo-crawl

turbo-crawl is a **browserless, native-speed crawler + MCP server for AI agents**,
a **Rust engine** built on the [turbo-dom](https://github.com/miaskiewicz/turbo-dom)
crate. It fetches + parses + acts on pages with **no Chromium**. For JS-gated pages
it runs the page's own scripts in a **true V8 isolate** (a `deno_core` runtime over
the native rtdom DOM), never a browser. The npm package is a **thin launcher**
(`cli.js`/`index.js`) that spawns the standalone Rust binary; Playwright/Chromium
appear **only as dev tooling** (benchmark oracle).

Read this before changing code. The current docs are [`README.md`](./README.md),
[`CHANGELOG.md`](./CHANGELOG.md), [`PUBLISHING.md`](./PUBLISHING.md), and the engine
docs [`rust/README.md`](./rust/README.md) + [`rust/HEADLESS-HYDRATION.md`](./rust/HEADLESS-HYDRATION.md).

## Stack & layout

- **Engine: Rust** (`rust/` — a 7-crate workspace on the `turbo-dom` crate, edition
  2021). Source is `.mjs`-free except a thin JS launcher + the dev harness.
- **Crates:** `turbo-crawl-core` (net/cookies/robots/url/frontier/crawl/cache),
  `turbo-crawl-page` (navigator), `turbo-crawl-view` (extract/visible/aria/locator/
  markdown/query/xpath/hydration/actions/…), `turbo-crawl-render` (deno_core V8 +
  the vendored `browser_env` rtdom↔V8 DOM binding), `turbo-crawl-transform` (swc),
  `turbo-crawl-napi` (dev/harness in-process addon), `turbo-crawl-mcp` (the stdio
  MCP **binary** the launcher spawns).
- **JS surface:** `cli.js` + `index.js` (the launcher), `harness/` (benchmarks).
- **Vendored, never hand-edit:** `rust/crates/turbo-crawl-render/src/browser_env{.rs,_upstream.rs,.js}`
  — re-vendor from turbo-test's committed HEAD via
  `rust/crates/turbo-crawl-render/scripts/vendor-browser-env.sh`.

## The gates

The engine gate is **Rust** (`cd rust`): `cargo test --workspace`, `cargo clippy
--workspace --all-targets` (0 warnings), `cargo fmt --check`. The pre-commit hook
(`.githooks/pre-commit`, wired by `npm run prepare`) lints/formats staged JS
(oxlint + biome over the launcher/harness; the vendored `browser_env.js` is
skipped). `npm run check` runs the JS lint/format + the Rust gate. Never bypass
with `--no-verify`.

## Testing rules

- Rust: `cargo test` — `node:test`-style unit tests live in each crate; deno_core
  render tests are in `rust/crates/turbo-crawl-render/tests/render.rs` (a separate
  binary, so they don't share a V8-platform init with the vendored binding's
  standalone-V8 unit test).
- **Deterministic + offline**: tests parse fixtures / hit a localhost server, never
  the live network. New code must be covered.
- Live-network checks (the competitive + crawler harnesses) live in `harness/` and
  auto-skip when their deps/browsers are absent.

## Code standards

- **Match the surrounding code**: comment density, naming, idiom. Comments explain
  *why*, not *what*.
- **Decompose** for readability — table-dispatch over long `match`/`if` ladders,
  small named helpers over nested branches.
- **turbo-dom is consumed via its public `rtdom` surface only** (`Tree`, `NodeRef`,
  `serialize`, `cascade`, the `DocumentExt` seam). Do not reach into internals. If a
  capability is missing, solve it here or request a small additive turbo-dom change.
- **Hot-path discipline** (extract/visible): a single index loop over
  `query_selector_all` results, no per-element allocation beyond the result record.
- **Honest behavior**: surface what can't be done (e.g. JS-only handlers are inert
  on the no-JS path; pixel/render-only APIs throw a clear "no-browser engine"
  error) rather than silently no-op.
- **The render isolate keeps the host heap unreachable from guest page JS** (a true
  V8 isolate, with a runaway-execution budget).

## Commits

- Conventional-commit style subject (`feat:`/`fix:`/`refactor:`/`docs:`/`chore:`).
- Work on a branch off `main` unless told otherwise; commit/push only when asked.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Releasing / publishing

**Pushing a `v*` tag IS the publish** — see [PUBLISHING.md](./PUBLISHING.md) for the
full checklist. In short: bump every version string to the SAME `X.Y.Z`
(`package.json`, `rust/Cargo.toml` workspace + each crate's path-dep `version`,
`core`/`mcp` `VERSION`, napi `version()` + its `package.json`, README status line),
green the gate (`cd rust && cargo test/clippy/fmt`), update `CHANGELOG.md`, commit
`chore(release): vX.Y.Z`, tag, push. On the tag, `release.yml` builds the
`turbo-crawl-mcp` binary per platform and publishes the launcher npm package, and
`rust-crates-publish.yml` publishes the crates. Irreversible — only tag when asked
to ship/publish/release.

## Adding a capability (checklist)

1. Implement in the right crate (`rust/crates/turbo-crawl-*`), functions small.
2. Expose over napi (`turbo-crawl-napi`) if Node/harness needs it, and/or as an MCP
   tool (`turbo-crawl-mcp` `tools()` + dispatch) if agent-facing.
3. Tests in the crate (offline; localhost server for net).
4. `cd rust && cargo test --workspace && cargo clippy --workspace --all-targets &&
   cargo fmt` green.

## Reference docs index

- **Engine:** [`rust/README.md`](./rust/README.md) (crates + tiers),
  [`rust/HEADLESS-HYDRATION.md`](./rust/HEADLESS-HYDRATION.md) (the JS render tier).
- **Product + status:** [`README.md`](./README.md), [`CHANGELOG.md`](./CHANGELOG.md),
  [`PUBLISHING.md`](./PUBLISHING.md).
- **Harness:** [`harness/competitive/README.md`](./harness/competitive/README.md),
  [`harness/crawlers/README.md`](./harness/crawlers/README.md).
