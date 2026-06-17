# `src/markdown.mjs` — Markdown view of a page's main content (SPEC §7.2)

## Responsibility
Walks a turbo-dom document and serializes its main content to GitHub-flavored Markdown for RAG / summarization context. It is a DOM walk, **not** a faithful renderer: boilerplate (`script/style/noscript/template/svg/nav/footer/aside`) is dropped by tag, and only a curated set of block/inline tags get real syntax — everything else passes its children through. Per SPEC §15.2 this is the heuristic (vs. readability) approach, intended to be measured and revised.

## Exports (precise signatures + behavior)
- `markdown(document, baseUrl?)` → `string`
  - Root selection: first `main`, else `body`, else the document itself.
  - Iterates the root's `childNodes`, emitting block strings into an array, then joins with blank lines (`"\n\n"`) and `.trim()`s.
  - `baseUrl` is threaded through to resolve `<a href>` to absolute URLs via `resolve()` from `url.mjs`; when absent/unresolvable, links degrade to plain inner text.

## Key internals
Two cooperating passes, each a table-dispatch over the tag name:
- **Block pass** (`block` → `blockHandlerFor`): precedence is **heading > `BLOCK_TAGS[tag]` > `blockContainer`** (recurse into children). `BLOCK_TAGS` covers `P`, `BLOCKQUOTE` (`> `), `PRE` (fenced ```` ``` ````, trailing newlines stripped, raw `textContent` — no inline pass), `UL`/`OL` (delegate to `emitList`), `HR` (`---`), `TABLE` (delegate to `emitTable`). Headings `H1`–`H6` map to `#`…`######` via `HEADINGS`. Bare text nodes become their own collapsed, trimmed block.
- **Inline pass** (`inline` → `INLINE_TAGS` or `passthrough`): text nodes are whitespace-collapsed; `A` → `[inner](href)`, `STRONG`/`B` → `**`, `EM`/`I` → `*`, `CODE` → `` ` ``, `BR` → `\n`. `wrap(marker)` returns `""` for empty inner so no stray markers leak.
- **Table rendering**: `emitTable` selects all `tr`; `appendRow` emits `| a | b |` and, after the **first** row only (`lines.length === 1`), injects the `| --- | --- |` header rule. `rowCells` reads `th,td`, runs each through the inline pass, trims, and escapes `|` → `\|`.
- **List rendering**: `emitList` selects all `li` but `appendListItem` keeps only **direct children** (`item.parentNode === listNode`); ordered numbering is positional (`lines.length + 1`).

## Depends on / used by
Imports `resolve` from `src/url.mjs`. Independent of the other view modules. Intended for the page/extraction layer that produces agent-facing context.

## Invariants & gotchas
- Every dispatch handler is a small standalone function so each stays under cyclomatic complexity 6 (cc<6); that is why block/inline logic is split across many one-tag functions instead of a switch.
- `PRE` bypasses the inline pass entirely — emphasis/links inside code fences are **not** processed; raw text is preserved.
- Nested lists are flattened: a nested `ul` is selected by the outer `emitList`'s `querySelectorAll("li")` for its own `li`s, but the parent only keeps direct children, so nested items render as a sibling list block, not indented.
- Tables use the **first `tr` as the header** regardless of whether it contains `th`.
- `SKIP` here is content-oriented (drops `nav/footer/aside`); it differs from the `SKIP` sets in `ax.mjs`/`text.mjs`.

## Example
```js
import { markdown } from "./src/markdown.mjs";
const md = markdown(document, "https://example.com/page");
// "# Title\n\nIntro paragraph with a [link](https://example.com/x).\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"
```
