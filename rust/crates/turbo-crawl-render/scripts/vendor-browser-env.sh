#!/bin/sh
# Re-vendor the turbo-test DOM binding into turbo-crawl-render.
#
# turbo-crawl's JS-render tier reuses turbo-test's rtdom↔V8 browser binding
# (`browser_env.{rs,js}`). There is intentionally NO cross-repo crate dependency
# (turbo-test is a test runner, not a published lib), so the copy is kept in sync
# MANUALLY — by running this script whenever turbo-test's binding gains coverage.
#
# It is the entire sync story:
#   - browser_env.js          → copied byte-for-byte.
#   - browser_env_upstream.rs → copied with ONE mechanical transform: leading
#       inner-doc lines `//!` become `//`, because src/browser_env.rs `include!`s
#       this file and `include!` forbids a file beginning with inner attributes.
#       No code is changed. turbo-crawl's additions live in src/browser_env.rs
#       (install_html / document_html) and are never touched here.
#
# Usage (from this crate's dir, with the turbo-test checkout beside turbo-crawl):
#   sh scripts/vendor-browser-env.sh [path-to-turbo-test/src]
set -eu

src="${1:-../../../../../turbo-test/src}"
dest="$(CDPATH= cd -- "$(dirname -- "$0")/../src" && pwd)"

[ -f "$src/browser_env.rs" ] || { echo "turbo-test src not found at: $src" >&2; exit 1; }

cp "$src/browser_env.js" "$dest/browser_env.js"
sed 's#^//!#//#' "$src/browser_env.rs" > "$dest/browser_env_upstream.rs"

echo "vendored browser_env.{js,rs} ← $src (turbo-test). Review the diff + run: cargo test -p turbo-crawl-render"
