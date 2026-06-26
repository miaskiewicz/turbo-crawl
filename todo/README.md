# todo/

Scoped, investigated-but-not-started work items. Each file is one idea with a
feasibility verdict + a concrete first step.

- [wasm-browser-build.md](./wasm-browser-build.md) — compile rtdom + view to WASM
  to run an in-browser extraction engine (feasible as analysis-only; render tier
  + open-web crawl are out by design).
- [probe-driven-auto-shim.md](./probe-driven-auto-shim.md) — close the `probe`
  loop: auto-fill `shim_needed` gaps from the active fingerprint profile until
  fixpoint (clears consistency checks; canvas/PoW left as machine-generated
  `unfilled` — the rent-vs-build spec).
