# Render-tier: the geometry measurement-loop (and how to fix it)

Found running a **Next.js 15 + MUI** app through the JS-render tier. After the
bundler-runtime fixes (currentScript + raw chunk src + load gate) and turbo-dom
0.2.2 (`removeAttributeNode` et al.), the Turbopack entry runs and **React 19
hydrates** — then the render **never terminates**: it spins in a synchronous loop
(minutes of CPU; the watchdog can't fire because the event loop is blocked).

## Root cause: degenerate geometry → infinite measure→setState→re-render

turbo-dom implements all the geometry/observer APIs, but they return **degenerate
values**:

```
getBoundingClientRect() → { width:0, height:0, top:0, left:0, right:0, bottom:0 }
offsetWidth/Height = 0   clientWidth/Height = 0
matchMedia('(min-width:600px)').matches = false   // even though innerWidth = 1024
ResizeObserver callback   → never fires (no-op stub)
```

Layout-driven components (MUI Popper, autosizers, virtualized lists,
`useMediaQuery`, anything with a `useLayoutEffect` that measures) do:

> measure → it's 0 / wrong / no RO callback → set state to "correct" the layout →
> re-render → measure again → still 0 → set state → … forever.

A geometry-free DOM that returns **0** isn't neutral: many components treat 0 as
"not measured yet" and keep retrying. That's the loop.

## The fix is two layers

### Layer A — turbo-dom: plausible, STABLE, deterministic geometry (the lever)

This is what actually breaks the loop. The values don't need to be pixel-correct;
they need three properties:

1. **Non-zero & plausible** — so "not measured yet" branches don't trigger.
2. **STABLE across calls for the same DOM state** — measure→setState→measure must
   see the *same* value the second time so React reconciles to a fixed point and
   stops. (Random/changing values would loop forever; this is the critical one.)
3. **Internally consistent** — `rect.width === offsetWidth === clientWidth` (±box),
   `rect.bottom - rect.top === height`, children fit parents.

Concrete, cheap synthetic box model (no real layout engine):

- **Block element**: `width = (parent content width, default innerWidth e.g. 1024)`;
  `height = lineHeight * (rough line count from text) || a fixed default (e.g. 18)`.
- **Inline/text**: `width = textLength * ~8px`, `height = lineHeight`.
- `getBoundingClientRect()` returns `{width, height, top, left, right:left+width,
  bottom:top+height, x:left, y:top}`; `offsetWidth/clientWidth = width`;
  `offsetHeight/clientHeight = height`. Positions can be a simple running offset or
  even all-`0`-top/left — **size** is what matters, and it must be non-zero+stable.
- **`matchMedia(q)`**: actually parse `min-width`/`max-width`/`min-height`/
  `max-height`/`orientation` and evaluate against `innerWidth`/`innerHeight`. Return
  a real `{matches, media, addEventListener, removeEventListener}`. (Today it
  returns `matches:false` for everything → responsive components mis-branch and can
  thrash.)
- **`ResizeObserver`/`IntersectionObserver`**: fire the callback **once**,
  asynchronously, with one initial entry (`contentRect` = the element's synthetic
  rect; IO `isIntersecting:true, intersectionRatio:1`). Components that gate render
  on the first observer callback then proceed and settle. **Fire once — never on a
  loop.**

> Ownership: this layer is turbo-dom (`src/runtime/dom.mjs` geometry getters,
> `window.mjs` `matchMedia`, `stubs.mjs` observers). It also makes the existing
> `visible`/cascade features more accurate as a bonus.

### Layer B — turbo-crawl: a render wall-clock deadline (the backstop)

Even with good geometry, some app will loop. The render tier must **guarantee it
returns** and degrade to a partial snapshot:

- Add `renderDeadlineMs` (e.g. default 5000). The settle loop checks elapsed
  wall-clock between rounds and stops, then snapshots whatever rendered.
- Sketch (`backend-fast.mjs` / isolate drain): keep the existing round/pending
  bounds, add `if (now() - start > renderDeadlineMs) break;` between rounds, and
  snapshot on exit regardless.

**Caveat (important):** a *purely synchronous* infinite loop inside a single timer/
effect callback **cannot be interrupted by JS** — the deadline check only runs
between rounds, after a callback returns. So Layer B catches **async-paced** loops
(setState → rAF/timer → re-render) and guarantees termination for those; it does
**not** stop a sync-infinite callback. The `node:vm` per-script timeout bounds the
*initial* script only, not timer callbacks. Therefore **Layer A is necessary** to
prevent the loop forming; Layer B is the safety net + the "always returns"
guarantee.

## Validation

With the Next dev server on :3010 (turbo-crawl symlinked into
`payroll-app-turbocrawl`):

```sh
node e2e/turbo/smoke.mjs    # JS-render tier returns < deadline; data-test-id 0 → large
node e2e/turbo/probe4.mjs   # requestAnimationFrame 0 → >0; no CPU peg
```

Win: `smoke` test-id count goes 0 → large, render returns in seconds, CPU not
pegged. A **prod build** (`npm run build && PORT=3010 npm start`) is the cleaner
target — prod Turbopack has no HMR chunk-load gate.

## Summary

- The crash is fixed; the remaining wall is a **measurement loop from degenerate
  geometry**, not a missing API.
- **Fix = realistic, stable, deterministic geometry in turbo-dom (Layer A)** — the
  actual unlock — **plus a render deadline in turbo-crawl (Layer B)** so the render
  always returns even when an app still loops.
