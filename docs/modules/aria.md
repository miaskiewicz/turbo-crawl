# `src/aria.mjs` — shared ARIA role + accessible-name heuristics

## Responsibility
Pragmatic, no-layout ARIA helpers used by `extract`, `ax`, and `locator`. Enough to
resolve `getByRole`/`getByText` and to build the agent view. No full accname
algorithm — cheap, deterministic heuristics only.

## Exports

### `implicitRole(tag, type?) → string`
Implicit ARIA role from tag (and `<input>` type):
- `<input>`: keyed by `type` — `checkbox→checkbox`, `radio→radio`,
  `button|submit|reset→button`, anything else (incl. text/email/missing) → `textbox`.
- Other tags via `IMPLICIT_ROLE`: `a→link`, `button→button`, `select→combobox`,
  `textarea→textbox`. Unknown tag → `generic`.

### `roleOf(el) → string`
Resolved role: the explicit `role` attribute if present (truthy), else
`implicitRole(lowercased tagName, lowercased type)`.

### `accessibleName(el) → string`
First trimmed, non-empty value from this ordered candidate list:
`aria-label` → `textContent` → `placeholder` → `value` (attr) → `title`.
Returns `""` if none produce a non-empty string. Each candidate is trimmed;
`null`/`undefined` are treated as empty.

### `accessibleDescription(el) → string`
Text of the `aria-describedby` targets (space-joined), else the `title` attribute.

### `accessibleErrorMessage(el) → string`
Text of the `aria-errormessage` targets — but only when `aria-invalid="true"`
(else `""`). Backs the `toHaveAccessibleErrorMessage` assertion.

## Key internals
- `IMPLICIT_ROLE` / `INPUT_ROLE` lookup tables.
- `firstNonEmpty(getters)` — runs getters in order, returns the first trimmed
  non-empty string; underpins `accessibleName`.
- `idList(el, attr)` / `resolveIds(doc, ids)` — IDREF-list parse + referenced-text
  join behind the accessible description/error-message getters (imports `textOf`
  from `dom-ops`).

## Depends on / used by
- No internal deps (leaf module).
- Used by `extract.mjs` (`role`, `name` fields), `locator.mjs` (`byRole`/`byText`
  matching), and the accessibility-tree (`ax`) layer.

## Invariants & gotchas
- Name precedence is **aria-label first, then visible text** — an `aria-label`
  overrides element text. `placeholder`/`value`/`title` are fallbacks only.
- `accessibleName` uses raw `textContent` (whitespace trimmed but not collapsed);
  contrast with `dom-ops.textOf`, which collapses runs of whitespace.
- `roleOf` honors any explicit `role` verbatim — it does not validate the token.
- Heuristic, not spec-complete: no `aria-labelledby`, no `<label>` association, no
  recursive subtree name computation.

## Example
```js
import { roleOf, accessibleName, implicitRole } from "./src/aria.mjs";

implicitRole("input", "submit"); // "button"
implicitRole("input");           // "textbox"
roleOf(buttonEl);                // "button"
accessibleName(el);              // aria-label > text > placeholder > value > title
```
