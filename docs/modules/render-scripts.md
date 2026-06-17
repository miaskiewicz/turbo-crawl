# `src/render/scripts.mjs` — extract executable `<script>`s from a parsed document

## Responsibility
Shared by both render backends: pull the executable `<script>` elements out of a
parsed turbo-dom document, **in source order**. Inline classic scripts carry their
code; external ones carry a resolved absolute URL the renderer fetches. Module
scripts are flagged (so the caller can bundle them); data scripts
(json / ld+json / importmap) are excluded.

## Exports / API
- `extractScripts(document, baseUrl) → Array<{ code?: string, url?: string, module: boolean }>`
  - `document` — a turbo-dom Document.
  - `baseUrl` — base for resolving relative `src`.
  - Each item is either `{ code, module }` (inline) or `{ url, module }`
    (external). `module` is `true` for `type="module"`.

## Key internals
- `CLASSIC_TYPES` set = `["", "text/javascript", "application/javascript",
  "module"]`. Any `<script>` whose lowercased `type` is **not** in this set is
  skipped (so `application/json`, `application/ld+json`, `importmap` are excluded).
- `scriptItem(el, baseUrl)`:
  - reads `type` (lowercased; missing → `""`),
  - `module = type === "module"`,
  - if `src` present → `{ url: resolve(baseUrl, src) ?? src, module }`,
  - else → `{ code: el.textContent ?? "", module }`.
- `resolve` (from `../url.mjs`) resolves relative `src` to absolute; falls back to
  the raw `src` if resolution fails.

## Depends on / used by
- Depends on: `../url.mjs` (`resolve`).
- Used by: `src/render/index.mjs` (`loadScripts`).

## Invariants & gotchas
- **Source order is preserved** — scripts are returned in document order, which
  the backends rely on for execution order.
- `module` items are returned here, not filtered out — `index.mjs` decides to
  bundle them; the backends themselves skip any residual `module` item.
- `importmap` scripts are **not** returned (their type isn't classic); they are
  read separately by `index.mjs`'s `readImportMap`.
- Inline empty scripts still produce `{ code: "" }`.

## Example
```js
import { extractScripts } from "turbo-crawl/render/scripts";

const items = extractScripts(document, "https://example.com/page");
// [{ code: "console.log(1)", module: false },
//  { url: "https://example.com/app.js", module: false },
//  { url: "https://example.com/main.mjs", module: true }]
```
