# `src/actions.mjs` — link/form intent-graph helpers (no JS execution)

## Responsibility
Resolve the page's *intent graph* rather than firing synthetic events (SPEC §6):
`<a href>` → navigate; `<form action method>` → serialize successful controls and
build the resulting navigation; everything else is inert in Lane A. Pure helpers
over turbo-dom nodes; `Page` wires them to navigation.

## Exports

### `fillValue(el, value)`
Sets a control's live value. For `<input type=checkbox|radio>` sets `el.checked =
Boolean(value)`; otherwise `el.value = value == null ? "" : String(value)`.

### `serializeForm(form, submitter?) → Array<[name, value]>`
Collects the form's **successful controls** (the HTML form-submission subset) as
`[name, value]` pairs. Iterates `form.elements ?? form.querySelectorAll(
"input,select,textarea,button")`. Per-control rules (`controlPairs`):

- **Skipped** (no pairs): control with no `name`, or with the `disabled` attribute.
- **Submit controls** (`<button>`, or `<input type=submit|button|reset|image>`):
  contribute `[name, value]` **only if `el === submitter`** (the activated button);
  all other submit controls are dropped.
- **Checkbox/radio**: pair only when `el.checked`, value = `value` attr or `"on"`.
- **`<select>`**: one pair per `selected` `<option>`, value = option's `value` attr
  or its trimmed `textContent`.
- **Other typed controls**: one `[name, value]` pair where value prefers live
  `.value`, falling back to the `value` attribute, else `""`.

### `buildSubmission(form, baseUrl?, submitter?) → { method, url, body?, contentType? }`
Builds the navigation a submit produces. Action URL = resolved `action` attr (or
`baseUrl` when absent/unresolvable). Then:

- **GET** (default, or `method` ≠ POST): `{ method:"GET", url }` with serialized
  pairs encoded into `url.search` via `URLSearchParams`. (Existing query is replaced.)
- **POST, non-multipart**: `{ method:"POST", url, body, contentType:
  "application/x-www-form-urlencoded" }`, body = `URLSearchParams(pairs).toString()`.
- **POST, multipart** (`enctype` contains `"multipart"`): `{ method:"POST", url,
  body, contentType:"multipart/form-data; boundary=…" }`. Body is hand-assembled
  with CRLF-delimited parts and a generated boundary. **Text controls only** — file
  inputs cannot be read without JS in Lane A.

## Key internals
`controlValue`, `selectPairs`, `typedPairs`, `controlPairs`, `isSubmitControl`,
`isCheckable`; `buildGet`/`buildPost`/`buildMultipart`; `formMethod`, `isMultipart`,
`formActionUrl`; `makeBoundary` (module-level `boundarySeq` counter), `multipartPart`.
`SUBMIT_TYPES = {submit, button, reset, image}`.

## Depends on / used by
- Depends on `url.mjs` (`resolve`).
- Used by `locator.mjs` (`fillValue` for `fill`/`type`) and by `Page` for submit
  navigation.

## Invariants & gotchas
- Only the **named** submitter is successful — unnamed buttons add no pair.
- GET overwrites the action URL's existing query string entirely.
- Multipart boundaries are monotonic per process (`boundarySeq`), not crypto-random.
- No client-side validation or `formaction`/`formmethod` override handling.

## Example
```js
import { serializeForm, buildSubmission } from "./src/actions.mjs";

serializeForm(form, submitBtn);          // [["q","hi"], ["go","Search"]]
buildSubmission(form, "https://x.test/"); // { method:"GET", url:"https://x.test/?q=hi&go=Search" }
```
