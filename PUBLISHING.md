# Publishing turbo-crawl

turbo-crawl ships from **one `v*` git tag**, which fires two GitHub Actions
workflows. The engine is a standalone Rust binary; the npm package is a thin
launcher that spawns it (no napi, no Node hosting Rust — same model as turbo-test).

| Workflow | Publishes | Where | Auth secret |
|---|---|---|---|
| `release.yml` | `@miaskiewicz/turbo-crawl` — builds the `turbo-crawl-mcp` binary for every platform, drops them in `bin/`, publishes the launcher (`cli.js`/`index.js` + `bin/`) | npm | `NPM_TOKEN` |
| `rust-crates-publish.yml` | the Rust crates, in dep order: `core → view → page → render → mcp` | crates.io | `CARGO_REGISTRY_TOKEN` |

Both trigger on `push: tags: ['v*']`. (The `turbo-crawl-napi` cdylib + `turbo-crawl-transform`
crate are not published — napi is dev/harness-only now.)

## The one rule: every version string must match the tag

No single source of truth, so the bump must be applied everywhere before tagging,
or a workflow ships a mismatched version. Bump to the SAME `X.Y.Z`:

- `package.json` → `"version"`
- `rust/Cargo.toml` → `[workspace.package] version` **and** every crate's path-dep
  `version = "X.Y.Z"` (core/view/page/render/mcp/napi Cargo.toml)
- `rust/crates/turbo-crawl-core/src/lib.rs` + `turbo-crawl-mcp/src/lib.rs` → `VERSION`
- `rust/crates/turbo-crawl-napi/src/lib.rs` → `version()` and its `package.json`
- `README.md` status line

Sanity check (should print nothing): `grep -rn "<old-version>" package.json rust/
README.md | grep -v /target/`.

## Cut a release

1. Bump all the version strings above to `X.Y.Z` (keep them identical).
2. Green gate locally: `cd rust && cargo test --workspace && cargo clippy --workspace
   --all-targets && cargo fmt --check`; from the root `npm run lint && npm run
   format:check` (the launcher JS).
3. Add the new version's entry to `CHANGELOG.md`.
4. Commit (`chore(release): vX.Y.Z`), tag (`git tag -a vX.Y.Z -m vX.Y.Z`), push the
   commit **and** the tag (`git push origin <branch> && git push origin vX.Y.Z`).
5. The workflows build + publish. Verify after CI:
   - `npm view @miaskiewicz/turbo-crawl version` (and that `bin/` shipped:
     `npm pack @miaskiewicz/turbo-crawl --dry-run`)
   - the crate pages on crates.io (`turbo-crawl-core`, …)

Publishing is **outward-facing + irreversible** (npm + crates.io versions can't be
reused) — only cut a tag when a release is intended.

## Notes

- The launcher's `files` allowlist ships `bin/` (the per-platform binaries CI
  builds), `cli.js`, `index.js`, `LICENSE`, `README.md`, `CHANGELOG.md`. `rust/`,
  `harness/`, `docs/` are excluded. Verify with `npm pack --dry-run`.
- `cli.js`/`index.js` resolve `bin/turbo-crawl-mcp-<platform>-<arch>` at runtime
  (musl-detected on Linux), with a dev fallback to a local
  `rust/target/release/turbo-crawl-mcp` build.
- crates publish in dependency order so each dependent resolves its just-published
  dep; path deps carry an explicit `version` so crates.io accepts them.
- Browser/crawler packages used only by the harness (`playwright`, `crawlee`, …) are
  not committed deps — install ad-hoc to run the benchmarks.
