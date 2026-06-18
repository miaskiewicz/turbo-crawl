# Differential parity (Rust ⇄ JS) — task #13

Proves the Rust ports produce **byte-identical** output to the JS implementation
(`turbo-crawl/src/*.mjs`) for the same inputs.

## How it works

1. `gen-golden.mjs` runs the **real JS modules** over a fixed input set and writes
   `golden.json`.
2. `crates/turbo-crawl-core/tests/parity.rs` runs the **Rust ports** over the same
   inputs and asserts equality against `golden.json`.

The committed `golden.json` lets the Rust test run in CI without Node; the test
skip-gates if it's absent.

```
node rust/parity/gen-golden.mjs          # regenerate golden after a JS change
cargo test -p turbo-crawl-core --test parity
```

## Covered now (pure-logic, no turbo-dom needed)

- **url** — `canonicalize` (tracking-strip, query-sort, default-port/path
  normalize), `resolve`, `is_http_url`
- **robots** — `allowed` (longest-match Allow/Disallow) + `crawl_delay`
- **cookies** — `cookie_header` scoping (path ordering, Secure over http/https)

These are the deterministic modules where a subtle Rust/JS divergence would be a
real correctness or security bug — so they get the live differential.

## DOM-module parity (text / markdown / links / detect / hydration / extract)

Implemented. `gen-golden.mjs` has a `dom` section that runs the JS view modules
over a fixture (via the turbo-dom JS runtime) and writes their output into
`golden.json`; `crates/turbo-crawl-view/tests/parity.rs` runs the Rust ports
over the same fixture and asserts equality.

### Important: the test needs NO Node / NO turbo-dom JS

- `golden.json` (including the `dom` block) is **committed**. The Rust parity
  test just **reads that file** and runs Rust — so `cargo test` and CI check
  parity with **zero JS setup**.
- The turbo-dom JS package is needed **only to (re)generate** the golden, not to
  run the test.

### Regenerating the golden (only after changing the JS `src/*.mjs`)

The JS view modules import `@miaskiewicz/turbo-dom/runtime`, which isn't on a
public registry — install it from the local turbo-dom checkout, then regenerate:

```
# from the repo root (turbo-crawl/)
npm install /path/to/turbo-dom --no-save   # local-only; NOT added to package.json
node rust/parity/gen-golden.mjs            # rewrites rust/parity/golden.json
cargo test -p turbo-crawl-view --test parity
```

`--no-save` keeps it a throwaway dev dependency (lands in `node_modules`, never
committed). If turbo-dom JS is absent, `gen-golden.mjs` simply emits `dom: null`
and the Rust parity test skip-gates — CI stays green either way.
