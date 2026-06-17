# `src/extract.mjs` — index a turbo-dom Document's interactive elements and links

## Responsibility
Phase-0 extraction passes over a turbo-dom `Document`: produce the `[i]`-addressable
list of interactive elements (the agent view) and the deduped list of navigable
link targets. No JS executes; this is a pure read over the parsed DOM + CSS cascade.

## Exports

### `interactiveElements(document, baseUrl?, window?, options?) → Array<record>`
Indexes every node matching the interactive selection set (SPEC §7.1):
`a[href]`, `button`, `input`, `select`, `textarea`, `[role=button|link|checkbox|tab|menuitem]`,
`[contenteditable]`, `[tabindex]`, `[onclick]`. One index loop over the
`querySelectorAll` result; each node becomes one record. Record shape:

```
{
  i:         number,        // stable position index ( = out.length at push time )
  tag:       string,        // lowercased tagName
  role:      string,        // explicit role attr, else implicitRole(tag, type)
  name:      string,        // accessibleName(el)
  value?:    string,        // value attribute → undefined if absent
  href?:     string,        // resolved absolute href; <a> only, else undefined
  type?:     string,        // lowercased type attribute → undefined if absent
  visible:   boolean,       // cascade-derived if window given + opt-in, else true
  jsHandler: boolean,       // true = has onclick but no native nav (can't fire in Lane A)
  ref:       WeakRef<Element>
}
```

- **Visibility opt-out**: `visible` is computed via `isVisible(el, window)` only when
  `window != null` AND `options.visibility !== false`. Otherwise every record is
  reported `visible: true`. The cascade pass is the hot-path cost (`getComputedStyle`),
  so callers that don't read `visible` should pass `{ visibility: false }`.
- **`ref: WeakRef`** (SPEC §7.1): the snapshot does not pin DOM nodes. The action
  layer derefs and errors on a stale handle (e.g. used after a navigation).
- **`jsHandler`**: `<a href>` and submit controls are "native nav"; anything else
  carrying an `onclick` is flagged (not dropped) since Lane A cannot fire it.

### `links(document, baseUrl?) → string[]`
All absolute, navigable **http(s)** link targets from `a[href]`, deduped (`Set`),
preserving document order. Each href is resolved against `baseUrl`; non-http(s) and
unresolvable targets are skipped.

## Key internals
`hrefFor` (anchor-only resolved href), `jsHandlerFor` (native-nav test),
`nullToUndefined`, `toRecord` (per-node record builder). `INTERACTIVE_SELECTOR` is
the joined selector string.

## Depends on / used by
- Depends on `aria.mjs` (`accessibleName`, `implicitRole`), `url.mjs` (`isHttpUrl`,
  `resolve`), `visible.mjs` (`isVisible`).
- Used by the Page / agent-view layer to build the `[i]` action surface.

## Invariants & gotchas
- **Hot path**: single index loop over `querySelectorAll`; no per-node allocation
  beyond the result record; no `classList`/regex per node.
- `i` is assigned from `out.length`, so indices are always contiguous `0..n-1`.
- Without a `window`, visibility cannot be derived → all records `visible: true`.
- `value`/`type`/`href` are normalized to `undefined` (not `null`/`""`) when absent.

## Example
```js
import { interactiveElements, links } from "./src/extract.mjs";

const els = interactiveElements(doc, "https://x.test/p", win, { visibility: false });
els[0]; // { i:0, tag:"a", role:"link", name:"Home", href:"https://x.test/", ... }

links(doc, "https://x.test/p"); // ["https://x.test/", "https://x.test/about", ...]
```
