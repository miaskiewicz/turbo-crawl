# TODO: probe-driven auto-shim loop

**Status:** scoped, not started. **Verdict: worth building, bounded — it
automates the consistency-only layer and turns `probe` from a manual recon tool
into a closing loop.** It does NOT cross the active-raster / PoW wall (canvas /
WebGL draw-and-hash, VM-bound proof-of-work); that still needs a real browser or
a rented solver. Build it as the cheap, in-house complement to the
`ChallengeSolver` adapters, not a replacement.

## The idea

Today `turbo-surf-render::probe_globals` (and the MCP `probe` tool) report what a
page's JS read off `navigator`/`screen`/`window.chrome`/canvas and which reads
came back `undefined` (`shim_needed`). That's manual: a human looks at the list
and edits the env.

Close the loop: feed `shim_needed` back into the render env so the isolate
**self-fills the gaps with coherent profile values**, re-runs, and repeats until
the gap list stops shrinking (fixpoint) or a budget is hit. Output: a page that
no longer trips *consistency/presence* checks, plus a diff of exactly which props
had to be added — which becomes either a permanent `ENV_BOOTSTRAP` addition or a
per-site override.

## Why it helps

- **Most "are you a bot" gates are presence/consistency checks**, not active
  fingerprints: they read dozens of props and bail if any are missing or
  internally contradictory. Auto-shim clears those mechanically.
- It's the **on-ramp to an in-house `ChallengeSolver`**: run a vendor's collector
  under the loop; if it converges (empty `shim_needed`, no canvas/WebGL draw), the
  vendor/version is all-static and a hand-written solver is viable. If it keeps
  hitting canvas raster, the loop *proves* you need a browser/solver for that one.
- Keeps the [[fingerprint seed pool]] coherent: gaps are filled from the *same*
  `Profile` already driving the headers + navigator, so nothing contradicts.

## Design

A new render entry point + a fill source:

```
pub struct ShimResult {
    pub html: String,             // hydrated page after convergence
    pub filled: Vec<(String, String)>,  // "navigator.foo" -> value JSON we injected
    pub unfilled: Vec<String>,    // gaps we could NOT coherently fill (need a human / raster)
    pub rounds: u32,
}

pub fn auto_shim(html, script, profile: &Profile, budget_rounds: u32) -> Result<ShimResult>
```

Loop (each round, in the isolate):
1. Run `probe_globals` instrumentation → collect `shim_needed`.
2. For each gap `target.prop`, pick a value from a **coherent fill table** keyed
   off the active `Profile`:
   - Known props (`navigator.connection`, `navigator.userAgentData`,
     `screen.availWidth`, `window.devicePixelRatio`, …) → real Chrome values
     derived from the profile (OS/screen/cores already in `Profile`).
   - Unknown props → a typed default (`undefined`-but-present marker, empty
     object, or `0`) only when safe; otherwise leave **unfilled** (guessing a
     value a real Chrome doesn't have is worse than absence).
3. Inject the fills as real own-properties on the global before re-running.
4. Stop when `shim_needed` is empty, unchanged for a round, or `budget_rounds`.

The fill table is the real work: a curated `prop -> (how to derive from Profile)`
map for the common Chrome surface. Start with the ~40 props CreepJS / the big
WAFs read; grow it as `unfilled` lists surface new ones in the wild.

## What it can and cannot do

| Check type | Auto-shim? |
|---|---|
| Missing/`undefined` prop presence | ✅ fills it |
| UA ↔ hints ↔ navigator consistency | ✅ (sourced from one `Profile`) |
| `navigator.webdriver`, `window.chrome` shape, plugins | ✅ already shimmed; loop covers stragglers |
| `Function.prototype.toString` native-fidelity | ✅ already done; loop verifies |
| **Canvas/WebGL/audio draw-and-hash** | ❌ needs real raster — reported as `unfilled` |
| **VM-bound PoW token** | ❌ needs to run the vendor VM with real raster — out |

The honest line: **auto-shim makes `unfilled` the precise, machine-generated
spec of what's left** — which is exactly the input to the rent-vs-build-a-browser
decision per vendor.

## Phases

1. **Fill table + `auto_shim` entry** (render). Curated `Profile`-derived values
   for the common surface; loop to fixpoint. Tests: a script reading N known props
   converges to empty `shim_needed`; a script touching canvas leaves a non-empty
   `unfilled`. **Effort: M.**
2. **MCP `auto_shim` tool** — run the loop over the current page's scripts, return
   `{filled, unfilled, rounds}`. Lets an agent self-heal a page. **Effort: S.**
3. **Persist learned fills** — emit the converged fill set as a per-host override
   (feeds the [[fingerprint seed pool]] / a per-site profile patch) so the second
   visit starts converged. **Effort: S–M.**
4. **(stretch) Run a real WAF collector under it** in the harness (offline fixture
   of a captured script) to measure convergence + surface the real `unfilled`
   set. **Effort: M.**

## Risks

- **Over-filling is a tell.** Adding a prop real Chrome lacks is worse than the
  gap. The table must be conservative; default to `unfilled` over guessing.
- **Coherence drift.** Every fill must derive from the one active `Profile`, never
  a constant — else the loop reintroduces the mismatch it's meant to remove.
- **Convergence ≠ pass.** An empty `shim_needed` means no *presence* gaps; the
  page can still fail on active raster. Don't report "solved" — report
  "consistency-clean, `unfilled` remains."

## First step

Phase 1: add `auto_shim` next to `probe_globals` in
`rust/crates/turbo-surf-render/src/probe.rs`, with a `Profile`-keyed fill table
seeded from the ~40 most-read Chrome props, looping to fixpoint. Reuse the
existing probe instrumentation; the only new piece is the fill table + the inject
+ re-run loop.

Related: [[fingerprint seed pool]] (the value source), the `ChallengeSolver`
trait in `turbo-surf-core::challenge` (where a converged-static vendor becomes a
hand-written solver), and the optional headless-browser sidecar (the fallback for
everything `unfilled` proves needs raster).
