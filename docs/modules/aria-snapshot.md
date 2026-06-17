# `src/aria-snapshot.mjs` — ARIA snapshot text + subset matcher

## Responsibility
A YAML-ish text view of an element subtree's **role/name** structure, plus a
matcher used by Playwright `toMatchAriaSnapshot` / the MCP `aria_snapshot` tool and
`Page.ariaSnapshot()`. Built on the accessibility tree (`src/ax.mjs`) so roles and
names match the `ax` view. Geometry-free, no JS.

## Exports
- `ariaSnapshot(root) → string` — indented YAML-ish lines for the subtree rooted at
  element `root` (e.g. `- button "Save"`, nested two spaces per level). The
  synthetic `generic` wrapper that `ax` emits for roleless containers is elided
  (its children keep their place); nameless nodes drop the quoted name.
- `matchesAriaSnapshot(root, expectedText) → boolean` — true when `expectedText` is
  an ordered role/name **subset** of `root`'s flattened roled nodes.

## How matching works
`expectedText` is parsed line-by-line (`LINE_RE`): `- <role>`, `- <role> "<name>"`,
or `- <role> /<src>/<flags>`. Blank and unparseable lines are ignored. Each parsed
entry must appear, **in document order**, among the actual roled nodes
(`isSubsequence`): role compares exactly; name compares by exact string, by RegExp
(`/…/` literal), or matches anything when omitted.

## Key internals
`axSubtree(el)` (from `ax.mjs`, exposes the internal `build`) → `flatten`/`serialize`
walk the node tree (`kidsOf` for children, eliding `generic`); `parseExpected` +
`entryFrom` build matcher entries; `entryMatches` + `isSubsequence` do the ordered
subset check.

## Depends on / used by
- Depends on `ax.mjs` (`axSubtree`).
- Used by `playwright/expect.mjs` (`toMatchAriaSnapshot`), `src/page.mjs`
  (`ariaSnapshot()`), the MCP `aria_snapshot` tool, and the barrel
  (`src/index.mjs`).

## Invariants & gotchas
- **Subset, not equality** — extra actual nodes are fine; the template only needs to
  appear in order. Roleless/`generic` wrappers never appear in output or matching.
- Playwright YAML extras (`[level=…]`, selected/checked properties, strict child
  nesting) are **not** modeled — role + name + order only.
- Names use `ax`'s heuristic (`aria-label` > text > alt), collapsed whitespace.

## Example
```js
import { ariaSnapshot, matchesAriaSnapshot } from "@miaskiewicz/turbo-crawl";

ariaSnapshot(document.querySelector("nav"));
// - navigation
//   - link "Home"
matchesAriaSnapshot(document.body, `- button /save/i`); // true if a Save button exists
```
