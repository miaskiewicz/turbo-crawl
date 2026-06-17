# `src/ax.mjs` — compact accessibility tree for agent reasoning (SPEC §7.2)

## Responsibility
Computes a nested, geometry-free accessibility tree (`{ role, name, value?, children? }`) from a turbo-dom document using element semantics + ARIA. It is a structural summary for agents, not a spec-complete AX tree: presentational/skipped subtrees are pruned and roleless wrapper elements are collapsed so the result stays small.

## Exports (precise signatures + behavior)
- `accessibilityTree(document)` → `{ role, name?, value?, children? }`
  - Roots at `body`, else `documentElement`. Returns the built tree, or `{ role: "document", children: [] }` if the root itself is pruned away.

## Key internals
- **Role resolution** (`roleOf`): explicit `role=` attribute wins; otherwise `<input>` maps by lowercased `type` through `INPUT_ROLE` (`checkbox/radio/button/submit/reset`, `hidden` → `null` = skipped, any other/unknown type → `"textbox"`); all other tags map through the `IMPLICIT` table (`A`→link, `BUTTON`→button, `NAV`→navigation, headings→heading, `UL`/`OL`→list, `LI`→listitem, `IMG`→img, `SELECT`→combobox, `TEXTAREA`→textbox, etc.). Unlisted tags resolve to `null` (no role).
- **Name resolution** (`nameOf`): `aria-label` (trimmed) → for `IMG` the `alt` attribute → otherwise the element's `textContent`, whitespace-collapsed and trimmed.
- **Value** (`valueOf`): only `INPUT`/`TEXTAREA`/`SELECT` surface `.value`; empty/null values are omitted (field left `undefined`).
- **Skip test** (`isSkipped`): non-elements, the `SKIP` tag set (`SCRIPT/STYLE/NOSCRIPT/TEMPLATE/HEAD/META/LINK`), and `aria-hidden="true"` are dropped wholesale.
- **Roleless-wrapper pruning** (`build` → `pruneRoleless`): an element with **no role** is replaced by its built children — 1 child collapses to that child, 0 children collapses to `null`, ≥2 children collapse into a synthetic `{ role: "generic", children }`. Elements **with** a role become a real node via `nodeFor` (always carries `role` + `name`; adds `value`/`children` only when present).

## Depends on / used by
Imports nothing (pure DOM reads). Sits alongside `markdown.mjs`/`text.mjs` as one of the page-view producers.

## Invariants & gotchas
- Helpers are intentionally tiny to keep each under cyclomatic complexity 6 (cc<6).
- Traversal uses `el.children` (elements only), so text-node content survives only through `nameOf`'s `textContent`, never as its own node.
- A roleful ancestor's `name` is the **collapsed text of its entire subtree**, so it can duplicate text that also appears in child nodes — names are not deduplicated against children.
- `pruneRoleless` only fires for roleless elements; a roleful element with one child is **not** collapsed.

## Example
```js
import { accessibilityTree } from "./src/ax.mjs";
const tree = accessibilityTree(document);
// { role: "main", name: "...", children: [
//   { role: "heading", name: "Title" },
//   { role: "link", name: "Home" },
//   { role: "textbox", name: "Email", value: "a@b.com" } ] }
```
