# `src/query.mjs` — unified CSS-or-XPath node query returning `{node, html, text}`

## Responsibility
A single entry point to query a page by **CSS selector** or **XPath** and get back the matched subtree(s) in a uniform shape. CSS delegates to turbo-dom's native engine; XPath delegates to the pragmatic subset in `src/xpath.mjs`. The default `type: "auto"` sniffs which language a string is.

## Exports (precise signatures + behavior)
- `query(root, selector, opts = {})` → `Array<{node,html,text}>` | `{node,html,text}` | `null`
  - `root` — turbo-dom Document or Element to search within.
  - `opts.type` — `"auto"` (default) | `"css"` | `"xpath"`.
  - `opts.first` — `true` → return the first match (or `null`); otherwise the full array.
  - Each match is described as `{ node, html: node.outerHTML, text: nodeText(node) }`.

## Key internals
- **Auto-detect** (`resolveType` → `looksLikeXPath`): a selector matching `/^\s*[(/]/` (starts with `(` or `/`, after leading whitespace) **or** starting with `"./"` is treated as XPath; everything else is CSS. Explicit `type` short-circuits the sniff.
- **CSS path** (`cssNodes`): spreads `root.querySelectorAll(selector)` into an array, then `describe`s each.
- **XPath path** (`xpathResults`): calls `evaluateXPath`. A node result (`r.nodes`) is `describe`d normally; a **values** result (`r.values`, produced by a trailing `/@attr` step) maps each attribute string to `{ node: null, html: null, text: value, value }` — so attribute queries still satisfy the `{…text}` contract and additionally expose `value`.
- `describe(node)` is the single serializer producing `{node, html, text}`, where `text` comes from `src/text.mjs`'s `text()`.

## Depends on / used by
Imports `evaluateXPath` from `src/xpath.mjs` and `text as nodeText` from `src/text.mjs`. Intended as the agent/extraction-facing query surface.

## Invariants & gotchas
- **CSS is whatever turbo-dom supports** (Sizzle-derived, mostly CSS3). Sizzle-only extensions like `:contains` are **NOT** available — for text matching use the XPath `text()` predicate (`//a[contains(text(),'Next')]`) instead.
- Attribute (`@attr`) XPath results have `node === null` and `html === null`; consumers must handle the value-only shape.
- Auto-detect is purely syntactic: a CSS selector that happens to start with `(` would be misrouted to XPath (rare in practice).
- `first: true` returns `null`, not `undefined`, when there are no matches.

## Example
```js
import { query } from "./src/query.mjs";

query(document, "a.product");                     // CSS → array of {node,html,text}
query(document, "//h1", { first: true });         // XPath → first {node,html,text} | null
query(document, "//a[contains(text(),'Next')]");  // text() predicate (CSS :contains has no equivalent)
query(document, "//a/@href");                      // → [{ node:null, html:null, text:href, value:href }, …]
```
