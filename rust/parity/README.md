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

## DOM-module parity (extension point)

The DOM views (text / markdown / ax / aria-snapshot / extract / hydration /
query / detect / locator) sit on turbo-dom. Differential parity for them needs
the **turbo-dom JS package** installed (`npm i turbo-dom` in the repo root), so
`gen-golden.mjs` can parse fixtures the JS way and run the JS view modules. Until
then they are covered by each module's own unit tests against expected output.

When turbo-dom JS is available: extend `gen-golden.mjs` with a `dom` section
(parse `fixtures/*.html` via turbo-dom, run the `src/*.mjs` view fns) and add a
`crates/turbo-crawl-view/tests/parity.rs` gated on `golden.dom`.
