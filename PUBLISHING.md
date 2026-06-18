# Publishing turbo-crawl

turbo-crawl ships from **one `v*` git tag**, which fires three GitHub Actions
workflows in parallel — there are now native artifacts, not just JS:

| Workflow | Publishes | Where | Auth secret |
|---|---|---|---|
| `release.yml` | `@miaskiewicz/turbo-crawl` (the JS package — `src`/`mcp`/`playwright` `.mjs` + `index.d.ts`) | npm | `NPM_TOKEN` |
| `rust-napi-prebuild.yml` | `@miaskiewicz/turbo-crawl-native` (the napi addon — prebuilt `.node` per platform) | npm | `NPM_TOKEN` |
| `rust-crates-publish.yml` | the Rust crates, in dep order: `core → view → page → render → mcp` | crates.io | `CARGO_REGISTRY_TOKEN` |

All three trigger on `push: tags: ['v*']`, so a single tag publishes everything.
(The `turbo-crawl-napi` cdylib and `turbo-crawl-transform` crate are not published
to crates.io — they're built into the native npm package.)

## The one rule: every version string must match the tag

There is no single source of truth, so the bump must be applied everywhere before
tagging, or a workflow ships a mismatched version. Bump to the SAME `X.Y.Z`:

- `package.json` → `"version"`
- `src/index.mjs` → `export const version`
- `mcp/server.mjs` → `new Server({ … version: "X.Y.Z" })`
- `rust/Cargo.toml` → `[workspace.package] version` **and** every crate's path-dep
  `version = "X.Y.Z"` (core/view/page/render/mcp/napi Cargo.toml)
- `rust/crates/turbo-crawl-core/src/lib.rs` + `turbo-crawl-mcp/src/lib.rs` → `VERSION`
- `rust/crates/turbo-crawl-napi/src/lib.rs` → `version()` and its `package.json`
- `README.md` status line

Sanity check (should print nothing): `grep -rn "<old-version>" package.json
src/index.mjs mcp/server.mjs rust/ README.md | grep -v /target/`.

## Cut a release

1. Bump all the version strings above to `X.Y.Z` (keep them identical).
2. Green gate locally: `npm run check` (JS) and `cd rust && cargo test --workspace
   && cargo clippy --workspace --all-targets && cargo fmt --check`.
3. Add the new version's entry to `CHANGELOG.md`.
4. Commit (`chore(release): vX.Y.Z`), tag (`git tag -a vX.Y.Z -m vX.Y.Z`), push the
   commit **and** the tag (`git push origin <branch> && git push origin vX.Y.Z`).
5. The three workflows run their gates and publish. Verify after CI:
   - `npm view @miaskiewicz/turbo-crawl version`
   - `npm view @miaskiewicz/turbo-crawl-native version`
   - the crate pages on crates.io (`turbo-crawl-core`, …)

Publishing is **outward-facing + irreversible** (npm + crates.io versions can't be
reused) — only cut a tag when a release is intended. CI re-runs the gate before
publishing, so a red tree can't ship. Rust crate publishing is new as of v0.2.0.

## Notes

- The JS package's `files` allowlist ships only `src`/`mcp`/`playwright` `.mjs` +
  `index.d.ts` + `LICENSE` + `README.md` + `CHANGELOG.md`. Verify with `npm pack
  --dry-run`. `test/`, `harness/`, `bench/`, `docs/`, `rust/` are excluded.
- The native npm package's per-platform binaries are built by the prebuild matrix
  (native `aarch64` runner); the loader in `rust/crates/turbo-crawl-napi/index.js`
  resolves the right `.node` at require time.
- crates publish in dependency order so each dependent resolves its just-published
  dep; path deps carry an explicit `version` so crates.io accepts them.
- Browser packages used only by the competitive harness (`playwright`, `crawlee`,
  …) are not committed deps — install ad-hoc to run the harness.
