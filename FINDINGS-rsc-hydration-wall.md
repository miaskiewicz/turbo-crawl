# Wall #3 — RSC flight hydration never commits (v0.1.2)

> **RESOLVED (post-0.1.2, commit `7854593`).** Root cause: the fast backend ran
> scripts in DOM order, so the **async `_R_` RSC bootstrap ran *before* the inline
> `__next_f.push` flight rows that follow it** → it saw a partial buffer → the RSC
> stream never closed → `hydrateRoot` never committed. Fix: capture `async`/`defer`
> and execute in **browser order** — sync → defer → DOMContentLoaded → async →
> load. The async bootstrap now sees the fully-buffered flight stream, closes it,
> and React commits. Verified live on `/login` (Next 15 + React 19 + MUI +
> PropelAuth): the full login form hydrates headless — **11 interactive elements**
> (email/password inputs, Google/Microsoft SSO, submit, magic-link, …), 9.5 KB of
> committed DOM, PropelAuth's `refresh_token` resolved → form (not spinner). The
> hypotheses below (async ordering #1) were correct.

---


Date: 2026-06-17
Engine: `@miaskiewicz/turbo-crawl@0.1.2`, `fast` backend (`node:vm` + turbo-dom)
Target: Flux payroll-app — Next.js 15.5.2 App Router, React 19, Turbopack, MUI,
TanStack Query, PostHog. Selectors in the e2e suite are 100% `getByTestId` →
`data-test-id`.

Companion doc: `FINDINGS-nextjs-render-tier.md` (bugs #1 currentScript, #2 entry
evaluation). Those are **fixed in 0.1.2**. This documents the next wall.

## TL;DR
0.1.2 runs the whole client bundle cleanly — no crash, no hang, all chunks +
bootstrap execute, flight data present, scheduler works. But **React never commits
the tree into `<body>`**: the DOM stays the SSR shell, **0 `data-test-id`** nodes,
so every e2e spec fails at its first locator. The App Router RSC **flight stream
hydration** starts but never completes. **Reproduces identically in dev AND prod
build** (byte-for-byte) — so it is NOT a dev/HMR artifact.

---

## What 0.1.2 fixed (verified on the live server)

| Check | 0.1.1 | 0.1.2 |
|---|---|---|
| Scripts throwing (`currentScript`) | 14/53 throw | **0 throw** |
| Infinite hang on `/` | (later builds looped) | **no hang, ~1.1s** |
| Chunks fetched + executed | partial | **26/26 + `_R_` bootstrap** |
| DOM mutated by JS | no (byte-identical) | **yes (+2799 bytes)** |
| `__next_f` flight data | present | present |

So the runtime, chunk execution, and currentScript are all working now. Good.

---

## The new wall: hydration starts, never commits

### Evidence
Probed `http://localhost:3010/` (the public landing page) on 0.1.2:

```
no-JS raw fetch : status=200  bytes=397610  data-test-id=0
JS-render tier  : status=200  bytes=400409  data-test-id=0   (no hang, 1.1s)

render fetch detail:
  total URLs fetched during render : 30
  _R_ bootstrap (b622afce…js)      : FETCHED        ← App Router client bootstrap loaded
  /_next/static chunk fetches      : 26
  <script id="_R_"> in rendered DOM: present (added)
  body has mounted tree            : NO — still SSR shell
```

Rendered `<body>` after the full render:
```html
<body class="antialiased">
  <div hidden><!--$--><!--/$--></div>            <!-- empty Suspense boundary, unresolved -->
  <script src=".../ingest/.../config.js"></script>
  <script src="/_next/static/chunks/b622afce…js" id="_R_" async></script>
  <script>(self.__next_f=self.__next_f||[]).push([0])</script>
  <script>self.__next_f.push([1,"1:\"$Sreact.fragment\"\n"])</script>
  <script>self.__next_f.push([1,"3:I[347257,[...17 chunk paths...]]"])</script>
  ...
</body>
```
The body has the **SSR placeholder + flight rows + bootstrap**, but **no rendered
React tree**. (Note any `login`/`email`/`password`/`spinner` strings you grep are
inside the `__next_f` flight JSON text, NOT mounted DOM — don't be fooled.)

### Everything underneath hydration is confirmed WORKING (ruled out)
Direct sandbox probes (`probe2`, `probe5`, `probe7`):
```
self === window === globalThis : true
MessageChannel new + postMessage→onmessage : FIRED   ← React 19 scheduler primitive OK
setTimeout(0)         : FIRED
queueMicrotask        : FIRED
requestAnimationFrame : present
self.__next_f.push    : works (flight rows accept)
TURBOPACK runtime     : installed (.push overridden, CHUNK_LISTS present)
document.currentScript: object (fix #1 holding)
```
And React logs **nothing** during render — no hydration error, no warning, no
"Maximum update depth", no "did not match". Grepped the full render output:
```
(blank — React emitted no error/warning)
```
So: not a thrown error, not a setState loop, not a dead scheduler, not a geometry
loop. Hydration is **scheduled and silently never finishes**.

### Dev vs prod — identical
`next build && next start` on the same port gives the **byte-identical** result
(`397610` / `400409`, 0 test-ids, no hang). This kills the "dev HMR gate" theory
from the earlier doc. The non-commit is intrinsic to how the App Router client
consumes the flight stream in this DOM — **use the prod build as the repro**
(deterministic, no HMR/turbopack-dev noise).

---

## Leading hypothesis: the RSC flight stream never reaches a clean END

App Router does NOT hydrate from static HTML. The client:
1. reads `self.__next_f` — an array the SSR fills with flight rows
   (`push([0])` init, `push([1,"…"])` data rows),
2. the `_R_` bootstrap wraps `__next_f` in a **ReadableStream** and feeds it to
   `createFromReadableStream()` → produces the root RSC element,
3. calls `hydrateRoot(document, rootElement)` and **awaits the stream** before the
   first commit.

If that stream never gets its **terminal/close** signal, `createFromReadableStream`
stays pending → the root element never resolves → `hydrateRoot` never commits →
body stays the SSR shell. **No error, just forever-pending.** That matches every
symptom exactly.

Two concrete things that break the stream's start→data→**end** contract in the
sandbox:

1. **Ordering: `_R_` is `async`.** In a browser, an `async` external script runs
   **after** HTML parse completes — i.e. AFTER all the inline `__next_f.push([…])`
   rows have already populated the array. The bootstrap then (a) installs its real
   `__next_f.push = (row) => controller.enqueue(row)` and (b) **replays** the
   already-buffered rows, then closes the stream when the document is done.
   turbo-crawl runs scripts in **DOM source order**, so if the `_R_` bootstrap is
   executed inline at its DOM position (before the later `push` rows) OR without
   the post-parse "replay buffered rows + close" step, the stream gets a partial /
   never-closed feed. **Check how the backend orders `async`/`defer` scripts** —
   they must be deferred to after the synchronous inline scripts, mirroring the
   browser, and the bootstrap's close path must fire.

2. **Stream end is tied to document load/parse completion.** The bootstrap closes
   the RSC stream when the initial HTML stream ends (in a browser, when parsing
   reaches `</html>` / `readyState` transitions). The render tier fetches the whole
   HTML at once and runs scripts; if the signal the bootstrap waits on
   (`document.readyState === 'complete'`, a final sentinel row, or the
   `DOMContentLoaded`/`load` ordering relative to the bootstrap) never arrives in
   the right order, the controller is never `.close()`d. **Verify `readyState`
   advances to `complete` and `load` fires AFTER the bootstrap installed its
   handler, not before.**

---

## Next diagnostics for the turbo-crawl agent (in order)

1. **Confirm the pending-stream theory.** After render, inspect whether
   `hydrateRoot` was reached and is awaiting. Cheap proxy: instrument the sandbox
   `ReadableStream`/`controller.close` (or whatever the bootstrap uses) and log
   whether `.close()` / stream-end is ever called. If never → confirmed.

2. **Check async-script ordering.** Log the execution order the backend uses for
   `<script async id="_R_">` vs the inline `__next_f.push` scripts. Browser order:
   all inline/sync first (in DOM order), then `async` scripts after parse. If the
   backend runs `_R_` at its DOM position, fix the ordering: run sync + inline
   scripts first, defer `async`/`defer` to a second pass, then fire
   `DOMContentLoaded`/`load`.

3. **Drive document lifecycle correctly.** Ensure, in this exact order:
   parse → run sync/inline scripts → set `document.readyState='interactive'` →
   `DOMContentLoaded` → run deferred/async scripts → set `readyState='complete'`
   → `load`. The bootstrap's stream-close is almost certainly gated on one of
   these. (backend-fast already fires some of these in `fireReady` — verify the
   ORDER and that it happens AFTER async scripts, and that `readyState` actually
   transitions, not just the events.)

4. **Use the prod build as the fixture** (`next build && next start`) — identical
   repro, no HMR noise.

5. If the stream genuinely cannot be closed from outside, consider a targeted
   shim: after running all scripts + lifecycle, if `__next_f` has a registered
   push-handler (the bootstrap installed one), synthesize the terminal close the
   App Router runtime expects.

## Repro
Probes in the consuming repo, `payroll-app/e2e/turbo/` (branch
`experiment/turbo-crawl-e2e2`), against any local Next server on :3010:
- `smoke.mjs`  — no-JS vs JS-render, bytes + test-id + timing
- `probe6.mjs` — fetch capture: bootstrap fetched?, body still SSR shell?, test-ids
- `probe7.mjs` — MessageChannel / setTimeout / queueMicrotask delivery in sandbox
- `dump2.mjs`  — dump rendered `<body>` to eyeball what mounted

```bash
cd payroll-app && npm run build && PORT=3010 npm start &   # prod repro
node e2e/turbo/probe6.mjs        # → body still SSR shell, data-test-id 0
```

## Bottom line
0.1.2 cleared bugs #1 and #2. The remaining wall is **App Router RSC flight-stream
hydration not committing** — almost certainly an async-script-ordering /
stream-termination problem in the sandbox's document lifecycle, not a React or
scheduler defect (both verified healthy). Fix the script-execution order + document
lifecycle so the flight stream closes, and React should commit → `data-test-id`
nodes appear → e2e becomes possible.
