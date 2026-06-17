# `src/detect.mjs` — Lane-B routing heuristic: is this page JS-gated?

## Responsibility
A cheap, geometry-free heuristic (SPEC §11) that decides whether a no-JS (Lane A)
parse is a JS-gated shell that should be escalated to the Chromium adapter
(Lane B). The signal is: near-empty rendered text **plus** a heavy external-script
payload ⇒ "shell only". Defaults lean conservative — escalate only on a clear
shell — so the fast no-JS path stays the default.

## Exports
`detectJsRequired(document, opts = {})` → `{ jsRequired, textLength, scripts, reason }`:
- `document` — the turbo-dom Document of the Lane-A parse.
- `opts` — overrides for the tunables below.
- returns the verdict (`jsRequired`), the measured `<body>` `textLength`, the count
  of external `scripts`, and a human-readable `reason`.

Tunables (`DEFAULTS`):
- `minTextLength` (200) — body text shorter than this looks empty.
- `minScripts` (1) — at least one `script[src]` to suspect a SPA.

## Key internals
- Measures `body.textContent` collapsed to single spaces and trimmed → `textLength`.
- Counts `script[src]` elements → `scripts`.
- `hasEmptyMount(document)` — true when a common SPA mount (`#root`, `#app`,
  `#__next`, `[data-reactroot]`) exists but is empty.
- Verdict: `jsRequired` is true when `shellish` (`textLength < minTextLength` and
  `scripts >= minScripts`) **or** (`emptyMount` and `scripts >= minScripts`).
- `detectReason` explains the call: server-rendered content, empty SPA mount, or
  near-empty body.

## Depends on / used by
No imports — pure function over a turbo-dom Document. Used by `src/crawl.mjs`
(`maybeLaneB`): when `jsRequired` and a `fallback` fetcher is configured, the item
is re-rendered through the Lane-B Page and the record is tagged `lane:"B"`. The
crawler passes `options.detect` through as `opts`.

## Invariants & gotchas
- Trivial complexity (cc<6); no hostile-input assumptions — only reads text/scripts.
- §15.4 trade-off: tightening `minTextLength` risks false negatives (returning an
  empty SPA); loosening it risks false positives (needless Chromium boots).
  Defaults are conservative on purpose.
- Geometry-free: it never measures layout/visibility, so inline `<script>` (no
  `src`) and CSS-hidden content are ignored — only external scripts count.
- An empty mount alone is not enough; it still requires `scripts >= minScripts`.

## Example
```js
import { detectJsRequired } from "./src/detect.mjs";

const v = detectJsRequired(page.document);
// { jsRequired: true, textLength: 12, scripts: 3,
//   reason: "empty SPA mount + external scripts" }

if (v.jsRequired && fallbackFetcher) {
  // escalate to Lane B (Chromium) and re-render
}

// stricter: treat <500 chars as empty
detectJsRequired(page.document, { minTextLength: 500 });
```
