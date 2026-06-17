# `src/hydration.mjs` — mine server-embedded hydration state (the no-JS answer to SPAs)

## Responsibility
Most JS frameworks ship the page's data server-side inside inline `<script>` tags. This module recovers that data with **zero JS execution and zero browser** — recovering a large slice of the "needs a browser" web by parsing (never `eval`-ing) the embedded JSON.

## Exports (precise signatures + behavior)
- `extractHydrationState(document)` → `{ next, jsonLd, json, states }`
  - `next` — parsed `<script id="__NEXT_DATA__">` JSON, or `null`.
  - `jsonLd` — array of parsed `<script type="application/ld+json">` blocks (each may be an object or array).
  - `json` — map of `id → parsed` for every `<script type="application/json" id="…">` (excluding `__NEXT_DATA__`, surfaced as `next`).
  - `states` — map of global key → parsed value for the recognized `window.<KEY> = <json>` assignments.
  - Everything is best-effort: fields are `null`/empty when absent or when JSON parsing fails (`tryParse` swallows errors).

## Key internals
- **`__NEXT_DATA__` / typed-JSON / JSON-LD** read script `textContent` directly and `JSON.parse` it. `parseTypedJson` skips scripts with no `id` and the `__NEXT_DATA__` blob (which `next` already covers). `parseJsonScript` returns `null` on miss or parse failure.
- **Global assignments** (`parseGlobalStates`): the recognized `GLOBAL_KEYS` are `__INITIAL_STATE__`, `__APOLLO_STATE__`, `__PRELOADED_STATE__`, `__NUXT__`, `__remixContext`. `inlineScriptText` concatenates the `textContent` of every `<script>` **without** a `src` attribute, then for each key:
  - `parseAssignment` finds `<KEY>\s*=\s*` via regex (matches `window.__X__ =`, `var __X__=`, etc. — only the key segment is anchored), then `findBracket` locates the next `{` or `[`.
  - **Balanced-brace scan** (`sliceBalanced` → `stepJson`/`applyBracket`): a hand-rolled state machine walks from that bracket counting `depth` while respecting JSON string state and `\` escapes (`stepInString`), returning the exact balanced JSON substring; that slice is `tryParse`d. This correctly stops at the matching close even when braces appear inside strings.

## Depends on / used by
Imports nothing. A standalone extractor consumed by the page/extraction layer; complements `schema.mjs` (DOM-bound) by recovering framework data blobs.

## Invariants & gotchas
- **No `eval`** — global assignments are recovered by text + balanced-brace scanning, so only JSON-shaped right-hand sides are recovered; values built by function calls / references are not.
- `parseAssignment`'s regex anchors only on the **key name**, so it matches the first `<KEY>=` occurrence in *any* inline script; an unusual earlier textual occurrence could mislead it.
- Only scripts **without** `src` are scanned for globals (external scripts aren't fetched here).
- JSON-LD always returns an array (possibly empty); `json`/`states` always return objects (possibly empty); `next` is the only field that is `null` on miss.
- Helpers are decomposed to keep each under cyclomatic complexity 6 (cc<6).

## Example
```js
import { extractHydrationState } from "./src/hydration.mjs";
const { next, jsonLd, json, states } = extractHydrationState(document);
// next   → Next.js props/page data (or null)
// jsonLd → [{ "@type": "Product", … }]
// json   → { "remix-context": {…} }
// states → { __APOLLO_STATE__: {…}, __NUXT__: {…} }
```
