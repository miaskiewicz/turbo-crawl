# `src/visible.mjs` — cascade-based (declared, not rendered) visibility test

## Responsibility
Approximate element visibility from turbo-dom's real CSS cascade (SPEC §7.3). We
cannot measure pixels, so this reports *declared* visibility, not *rendered*
visibility. Used by extraction and by locator/dom-ops accessors.

## Exports

### `isVisible(el, window) → boolean`
Returns `false` when any of these hold, in this short-circuit order:

1. `hidden` attribute present
2. `aria-hidden="true"`
3. `<input type="hidden">`
4. computed `visibility: hidden` (one read on `el` — `visibility` inherits, so an
   ancestor's hidden value already shows up on the element)
5. `display: none` on `el` or **any** ancestor (`display` does NOT inherit → the
   ancestor chain must be walked)

Otherwise `true`. Requires `window` (only used to obtain `getComputedStyle`).

## Key internals
- `hasDisplayNoneAncestor(el, gcs)` — walks `parentNode` while `nodeType === 1`,
  returning `true` on the first `display:none`. Each `gcs(node)` is memoized per
  node on `Document.__version`, so shared ancestors resolve their cascade once.
- `isHiddenInput(el)` — `INPUT` tag with lowercased `type === "hidden"`.

## Depends on / used by
- Depends on the turbo-dom `window.getComputedStyle` cascade.
- Used by `extract.mjs` (`interactiveElements` visibility pass), `dom-ops.mjs`
  (`isVisibleEl`), and transitively the `Locator.isVisible()` accessor.

## Invariants & gotchas
- **Hot path**: the dominant cost is the first `getComputedStyle()` per element
  (full cascade resolution, then memoized on `Document.__version`). Two deliberate
  minimizations: (a) the three cheap attribute signals are tested first and
  short-circuit before any cascade work; (b) values are read via
  `getPropertyValue()` rather than the computed-style Proxy's property accessor,
  avoiding the per-read Proxy `get` trap.
- "Declared, not rendered": an element pushed off-screen, `opacity:0`, or zero-sized
  is still reported visible — only `display`/`visibility`/`hidden`/`aria-hidden`/
  `type=hidden` are honored.
- `visibility:hidden` needs only the self read because it inherits; `display:none`
  needs the full ancestor walk because it does not.

## Example
```js
import { isVisible } from "./src/visible.mjs";

isVisible(el, window); // false if el or an ancestor has display:none, etc.
```
