# `src/dom-ops.mjs` — element-level read/write accessors backing locator actions

## Responsibility
Thin, pure DOM helpers that back the Playwright-style accessors and locator actions.
No navigation and no `window` dependency, except `isVisibleEl` (which needs a window
for the cascade). Each function operates on a single turbo-dom element.

## Exports

### Readers
- `textOf(el) → string` — `textContent`, with whitespace runs collapsed to single
  spaces and trimmed (`/\s+/g → " "`). Empty string when absent.
- `innerHTMLOf(el) → string` — `el.innerHTML ?? ""`.
- `attrOf(el, name) → string | null` — `el.getAttribute(name)` (raw `null` if absent).
- `inputValueOf(el) → string` — `String(el.value)`; `""` when value is null/undefined.
- `isEnabledEl(el) → boolean` — `true` when the `disabled` attribute is absent.
- `isCheckedEl(el) → boolean` — `Boolean(el.checked)`.
- `isVisibleEl(el, window) → boolean` — delegates to `visible.isVisible`.

### Writers
- `setChecked(el, on)` — `el.checked = Boolean(on)`.
- `selectOption(el, value) → boolean` — over each `<option>` of the `<select>`,
  sets `selected` to whether the option matches `value` by its `value` attribute
  **or** its trimmed `textContent`. Non-matching options are deselected. Returns
  `true` if any option matched.

## Key internals
None beyond the exported functions; this is a flat helper module.

## Depends on / used by
- Depends on `visible.mjs` (`isVisible`).
- Used by `locator.mjs` — every `Locator` accessor/action routes through these.

## Invariants & gotchas
- `textOf` collapses whitespace (differs from `aria.accessibleName`, which only
  trims) — use `textOf` for display/match text, `accessibleName` for the accname.
- `attrOf` returns `null` (not `""`) for missing attributes — callers must handle it.
- `selectOption` is last-write-wins per option and deselects everything that does
  not match; it implicitly enforces single-selection behavior for the given value.
- `isVisibleEl` is the only window-dependent helper here.

## Example
```js
import { textOf, selectOption, setChecked } from "./src/dom-ops.mjs";

textOf(el);                    // "Hello   world" → "Hello world"
selectOption(selectEl, "US");  // true if an <option value="US"> or text "US" matched
setChecked(checkboxEl, true);  // el.checked = true
```
