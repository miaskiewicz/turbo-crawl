# `src/schema.mjs` — typed, selector-bound structured extraction (SPEC §7.4)

## Responsibility
`extractSchema(document, schema)` reads a typed object out of a page using turbo-dom's cached selector engine — the "give me name, price, rating" path that skips the click-and-scrape dance. Each field is bound to a CSS selector and declares how to read, coerce, and reshape its value.

## Exports (precise signatures + behavior)
- `extractSchema(document, schema, baseUrl?)` → `object`
  - Accepts either `{ field: spec, … }` or a wrapping `{ fields: { … } }` (top-level `schema.fields` is unwrapped).
  - `baseUrl` resolves url-bearing attributes to absolute URLs.

**Field spec** `{ selector, attr?, type?, list?, fields?, transform? }`:
- `selector` — CSS selector; required unless reading the root (when omitted, the current root/container is read directly).
- `attr` — `"text"` (default; `textContent`, whitespace-collapsed, trimmed) | `"html"` (`innerHTML`) | any attribute name. Attributes in `URL_ATTRS` (`href/src/action/poster/data-src`) are absolutized via `resolve(baseUrl, …)`, falling back to the raw value.
- `type` — `"string"` (default) | `"number"` (strips non-`[0-9.+-]`, then `Number`; unparseable → `null`) | `"boolean"` (`Boolean(value)`).
- `list` — `true` → array of **all** selector matches.
- `fields` — nested schema → the field is an object (or, with `list`, an array of objects, one per selector match; nested selectors are relative to the matched container).
- `transform` — `(value) => value`, applied **last** to whatever the field produced.

## Key internals
- `extractField` dispatches four ways on `(fields?, list?)`: `extractObjectList`, `extractNestedObject`, `extractScalarList`, `extractScalar`.
- `readNode` = `ATTR_READERS[attr]` (`text`/`html`) **or** `readAttr` (attribute read + URL absolutize) → then `coerce(raw, type)`.
- `extractObject` walks `Object.keys(fields)` building the result object; nested object extraction recurses with the matched element as the new root.
- `apply(spec, value)` runs `transform` if it's a function — wired into every extractor so transform works on scalars, lists, and objects uniformly.
- Missing matches yield `null` for scalars/objects and `[]` for lists (empty `querySelectorAll`).

## Depends on / used by
Imports `resolve` from `src/url.mjs`. Relies on turbo-dom's `querySelector`/`querySelectorAll` (and their cached selector engine). Independent of the XPath/query path.

## Invariants & gotchas
- Functions are split per extraction mode to keep each under cyclomatic complexity 6 (cc<6).
- `coerce` to `"number"` strips characters globally, so `"$1,234.50"` → `1234.50` but `"1.2.3"` → `Number("1.2.3")` → `NaN` → `null`. `"boolean"` is truthiness of the raw value, **not** a string parse (`"false"` → `true`).
- Only CSS selectors — no XPath here (use `src/query.mjs` for that).
- Nested-object selectors are evaluated **relative to the matched container** in the list/nested cases, but for a single object without `list`, `querySelector(spec.selector)` runs against the current root.

## Example
```js
import { extractSchema } from "./src/schema.mjs";
const data = extractSchema(document, {
  title: { selector: "h1" },
  price: { selector: ".price", type: "number" },
  cover: { selector: "img", attr: "src" },          // → absolute URL
  tags:  { selector: ".tag", list: true },
  items: { selector: ".item", list: true, fields: {
    name: { selector: ".name" },
    url:  { selector: "a", attr: "href" },
  }},
}, "https://shop.example/");
```
