# `src/xpath.mjs` — minimal XPath evaluator over turbo-dom (a pragmatic subset)

## Responsibility
turbo-dom has no `document.evaluate`, so this module provides a small XPath engine covering the constructs that actually appear in real scraping scripts. It is explicitly **NOT** a full XPath 1.0 implementation — see the supported grammar below for exactly what works.

## Exports (precise signatures + behavior)
- `evaluateXPath(root, expr)` → `{ nodes: Element[] }` | `{ values: string[] }`
  - Returns `{ nodes }` for normal location paths; returns `{ values }` when the expression ends in an attribute step (`/@attr`) — the matched attribute strings, with `null`s filtered out.
  - Evaluation starts from `[root]` and applies each step left-to-right.

## Supported grammar (the whole subset — anything else is unsupported)
Axes / steps:
- `/a/b` — absolute child path. The **first** step has no leading `/` context distinction: `consumeAxis` makes the first step a `descendant` search unless it begins with `/`. (i.e. `a/b` searches descendants for `a`, then children `b`.)
- `//a` — descendant axis (implemented via `querySelectorAll(test)`).
- `a/b` — relative; first step descendant, subsequent `child`.
- `*` — wildcard node-test (matches any element; with `descendant` axis becomes `querySelectorAll("*")`).
- `//a/@href` — **trailing attribute step**: returns the attribute string(s) instead of nodes.

Predicates (a step may chain several `[...]`):
- `[@attr='v']` / `[@attr="v"]` — attribute equals (single or double quotes).
- `[@attr]` — attribute exists (`getAttribute(name) !== null`).
- `[contains(@attr,'v')]` — attribute contains substring.
- `[text()='v']` — element's trimmed `textContent` equals.
- `[contains(text(),'v')]` — trimmed `textContent` contains substring.
- `[n]` — 1-based positional index.

Anything not matching these compiled patterns (other functions, `and`/`or`, `..`, `position()>1`, namespaces, `@*`, etc.) is unsupported; an unrecognized predicate body compiles to `{ fn: () => false }` (matches nothing).

## Key internals
- **Char-scan step splitter** (`splitSteps` → `scanStepEnd` → `advanceScan`): walks the expression char by char, splitting on a top-level `/` while tracking quote state (`'`/`"`) and bracket `depth` so slashes inside predicates/strings don't split a step. `consumeAxis` reads leading `/` or `//` to set the axis.
- **Step parse** (`parseStep`): a leading `@` → attribute step `{ attr }`; otherwise the node-test is `/^([A-Za-z*][\w-]*)/` (default `*`), and each `[...]` body is `compilePred`d.
- **Predicate compile** (`compilePred`): positional `^\d+$` → `{ pos: n }`; equals/contains regexes build `{ fn }` matchers via `readTerm` (which handles `text()` vs `@attr`); `[@attr]` → existence matcher.
- **Step run** (`runStep`): gathers `candidates` for every context node (`querySelectorAll` for descendant, direct `children` filtered by tag for child), `dedupe`s by identity, then applies predicates in order. Positional predicates index into the **combined deduped match set** for the step.

## Depends on / used by
Imports nothing. Consumed by `src/query.mjs`.

## Invariants & gotchas
- This is a **pragmatic subset, not XPath 1.0** — only the grammar listed above is honored; everything else silently yields no matches (or `() => false` predicates).
- **Positional predicates `[n]` apply over the combined, deduped match set for a step**, not per-context-node numbering as strict XPath requires. So `//ul/li[1]` selects the 1st `li` across *all* matched `ul`s combined, not one per `ul`. This is a documented deviation.
- Node tests are tag-name only and case-insensitive (uppercased for comparison); no `node()`/`text()` node tests as steps (only inside predicates).
- A trailing `@attr` step short-circuits and returns `{ values }`; it must be last to take effect.
- Helpers are decomposed to keep each under cyclomatic complexity 6 (cc<6).

## Example
```js
import { evaluateXPath } from "./src/xpath.mjs";

evaluateXPath(root, "//div[@class='card']");          // { nodes: [...] }
evaluateXPath(root, "//a[contains(text(),'Next')]");  // { nodes: [...] }
evaluateXPath(root, "//table/tr[2]");                  // 2nd <tr> across all matched tables
evaluateXPath(root, "//a/@href");                      // { values: ["https://…", …] }
```
