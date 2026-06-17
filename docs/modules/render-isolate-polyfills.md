# `src/render/isolate-polyfills.mjs` — minimal web globals for the bare V8 isolate

## Responsibility
Provides the minimal web globals a bare V8 isolate lacks but turbo-dom's WASM glue
needs: `TextEncoder` and `TextDecoder` (UTF-8 only). Exported as a **source
string** because it runs inside the isolate (not the host), and it must be
evaluated **before** the bundle — wasm-bindgen builds a `TextDecoder` at
module-init time.

## Exports / API
- `POLYFILLS: string` — a JS source string installing `globalThis.TextEncoder` and
  `globalThis.TextDecoder` classes.
  - `TextEncoder`: `encode(s) → Uint8Array` (manual UTF-8, incl. surrogate-pair
    handling), `encodeInto(s, arr) → { read, written }`.
  - `TextDecoder`: `decode(buf) → string` (accepts a `Uint8Array` or anything with
    a `.buffer`; manual UTF-8 decode incl. 4-byte → surrogate pair).

## Key internals
- Hand-rolled UTF-8: 1/2/3/4-byte sequences; high surrogates (`0xd800–0xdbff`)
  combine with the next char into a code point for 4-byte encoding.
- `decode` returns `""` for falsy input and normalizes the buffer to a
  `Uint8Array`.
- Enough fidelity for wasm-bindgen string marshalling + DOM text; **not** a
  general/streaming TextEncoder/TextDecoder (no encodings other than UTF-8, no
  `stream` option, no BOM/fatal handling).

## Depends on / used by
- Depends on: nothing (pure source string).
- Used by: `src/render/backend-secure.mjs` `bootIsolate`, which
  `context.eval(POLYFILLS)` before compiling/instantiating the isolate bundle.

## Invariants & gotchas
- **Order matters:** must be eval'd before the bundle, because wasm-bindgen
  constructs a `TextDecoder` during module init.
- UTF-8 only; these are deliberately minimal and not spec-complete.
- It is a string, not executable code in the host — importing it does nothing on
  its own; the secure backend injects it into the isolate.

## Example
```js
// in backend-secure.mjs bootIsolate:
import { POLYFILLS } from "./isolate-polyfills.mjs";
await context.eval(POLYFILLS); // installs TextEncoder/TextDecoder in the isolate
// ...then compile + instantiate the bundle (wasm-bindgen needs them)
```
