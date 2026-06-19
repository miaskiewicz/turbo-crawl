#!/bin/sh
# Re-vendor the turbo-test DOM binding into turbo-surf-render.
#
# turbo-surf's JS-render tier reuses turbo-test's rtdom↔V8 browser binding
# (`browser_env.{rs,js}`). There is intentionally NO cross-repo crate dependency
# (turbo-test is a test runner, not a published lib), so the copy is kept in sync
# MANUALLY — by running this script whenever turbo-test's binding gains coverage.
#
# It is the entire sync story:
#   - browser_env.js          → copied byte-for-byte.
#   - browser_env_upstream.rs → copied with ONE mechanical transform: leading
#       inner-doc lines `//!` become `//`, because src/browser_env.rs `include!`s
#       this file and `include!` forbids a file beginning with inner attributes.
#       No code is changed. turbo-surf's additions live in src/browser_env.rs
#       (install_html / document_html) and are never touched here.
#
# Usage (from this crate's dir, with the turbo-test checkout beside turbo-surf):
#   sh scripts/vendor-browser-env.sh [path-to-turbo-test/src]
set -eu

# Vendor from the turbo-test repo's LAST COMMIT (HEAD), never the dirty working
# tree — so a half-finished local edit in turbo-test can't leak into our vendored
# copy. Pass the turbo-test repo root (default: sibling of turbo-surf).
repo="${1:-../../../../../turbo-test}"
dest="$(CDPATH= cd -- "$(dirname -- "$0")/../src" && pwd)"

git -C "$repo" rev-parse --short HEAD >/dev/null 2>&1 || {
  echo "not a git repo (need turbo-test's HEAD): $repo" >&2
  exit 1
}
rev="$(git -C "$repo" rev-parse --short HEAD)"

git -C "$repo" show HEAD:src/browser_env.js > "$dest/browser_env.js"
git -C "$repo" show HEAD:src/browser_env.rs | sed 's#^//!#//#' > "$dest/browser_env_upstream.rs"

echo "vendored browser_env.{js,rs} ← $repo @ $rev (committed HEAD)."
echo "Update the '// turbo-test @ <rev>' line in src/browser_env.rs to $rev, then: cargo test -p turbo-surf-render"
