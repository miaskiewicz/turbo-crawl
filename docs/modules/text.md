# `src/text.mjs` — structured plain-text view of a page

## Responsibility
Renders an element subtree (or whole document) to plain reading text — all text, no markup — inserting line breaks at block-level boundaries so DOM structure survives as paragraphs. Distinct from `markdown()`: this emits no `#`/`-`/link syntax, producing raw text for embeddings/summarization where markup would be noise.

## Exports (precise signatures + behavior)
- `text(root)` → `string`
  - `root` may be a turbo-dom Element or Document. If it has `querySelector`, the walk starts at `body` (falling back to `root`); otherwise `root` itself is walked.
  - Returns lines joined with `"\n"`; each emitted line is collapsed (`[ \t]+`→space) and trimmed; empty lines are dropped.

## Key internals
- **Block-boundary line breaks**: a single mutable `cur` string accumulates inline text; `flush()` pushes the cleaned `cur` as a line and resets it. `walkElement` calls `flush()` **before and after** any tag in the `BLOCK` set (`P/DIV/LI/H1‑H6/SECTION/ARTICLE/TABLE/TR/UL/OL/TR/THEAD/…`), so block elements bracket their content with breaks while inline elements (`a/span/b/em/code/…`) stay on the current line.
- **Leaf tags** (`LEAF` map, no child recursion): `BR` and `HR` simply `flush()`; `PRE` flushes, then pushes its `textContent` (trailing whitespace stripped) as a **single preserved line** — `pre` formatting is kept verbatim rather than collapsed.
- **Table cells**: `TD`/`TH` (the `CELL` set) are not block-flushing; instead `walkElement` appends a `\t` after the cell's content, so a row's cells stay on one line separated by tabs while the enclosing `TR` (a `BLOCK`) ends the row.
- **Text nodes**: appended to `cur` after `collapse` (`[ \t\r\n]+`→space). `SKIP` tags (`SCRIPT/STYLE/NOSCRIPT/TEMPLATE/HEAD/META/LINK/TITLE/SVG`) are ignored entirely.
- All of `flush`, `LEAF`, `walkElement`, `walk` are closures over the per-call `lines`/`cur` state, making `text()` reentrant per invocation.

## Depends on / used by
Imports nothing. Consumed by `src/query.mjs` (the `text` field of `{node,html,text}` results) and usable standalone as a page view.

## Invariants & gotchas
- Closures are decomposed (leaf vs. element vs. node) to keep each path under cyclomatic complexity 6 (cc<6).
- `PRE` content is the one place internal whitespace is **not** collapsed.
- Cells emit a trailing `\t`, so each table line ends with a tab before the row flush — acceptable since `flush()` trims line edges only of spaces/tabs… note `flush` trims, so the trailing tab is removed at row end but inter-cell tabs survive.
- A line is emitted only if non-empty after trim; runs of block elements never produce blank lines.

## Example
```js
import { text } from "./src/text.mjs";
text(document);
// "Page Title\nFirst paragraph stays one line even with a bold word.\nName\tEmail\nAda\tada@x.com"
```
