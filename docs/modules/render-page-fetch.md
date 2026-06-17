# `src/render/page-fetch.mjs` — host-net-backed `fetch` + `XMLHttpRequest` for the fast backend

## Responsibility
Provides a `fetch` and `XMLHttpRequest` for page scripts in the render tier that
route page-initiated requests through turbo-crawl's **host net layer**
(cookies / UA / redirects) instead of the turbo-dom stub. Shared design with the
secure backend, but these implementations target the **fast** (node:vm) backend.
A shared `state.pending` counter lets the settle loop wait for in-flight requests
before snapshotting.

## Exports / API
- `makePageFetch(hostFetch, base, state) → (input, init?) => Promise<Response-like>`
  - returns a minimal Response: `{ ok, status, url, text(), json() }`.
  - `init.method`, `init.body`, `init.headers` are forwarded to `hostFetch`.
- `makeXHR(hostFetch, base, state) → class XMLHttpRequest`
  - minimal async XHR: `open(method, url)`, `setRequestHeader()` (no-op),
    `getResponseHeader()` (→ null), `send(body)`; sets `status`, `responseText`,
    `response`; fires `onreadystatechange` + `onload` at `readyState === 4`.
- Parameters:
  - `hostFetch` — host `fetchHtml(url, opts) → { html, status, ... }`.
  - `base` — page URL, for resolving relative request URLs.
  - `state` — `{ pending: number }` in-flight counter shared with the settle loop.

## Key internals
- `requestUrl(input, base)` — resolves `input` against `base` via `new URL`,
  falling back to `String(input)` on failure.
- `pageResponse(res, url)` — wraps a host result; `ok` is `status` in `[200,300)`;
  `text()` returns `res.html ?? ""`; `json()` `JSON.parse`s it.
- `makePageFetch` increments `state.pending` on entry and decrements in `finally`,
  so the settle loop sees in-flight requests. On host error it resolves a
  `{ html: "", status: 0 }` response rather than rejecting.
- `makeXHR.send` increments `state.pending`, runs `hostFetch`, applies the result,
  swallows errors, and in `finally` decrements `pending` and calls `finishXhr`
  (sets `readyState = 4`, fires callbacks).

## Depends on / used by
- Depends on: nothing (only the WHATWG `URL`).
- Used by: `src/render/backend-fast.mjs` (injects both into the vm sandbox when
  `hostFetch` is present).

## Invariants & gotchas
- **Fast-backend only.** The secure backend has its own synchronous
  (`applySyncPromise`) `fetch`/XHR inside `isolate-entry.mjs`; these async ones
  rely on the host event loop and the `state.pending` settle counter.
- Errors never reject — page scripts always get a Response-like (status `0`,
  empty body) so a failed request can't crash the render.
- The XHR is async and only supports the callback path
  (`onreadystatechange`/`onload`); there is no synchronous mode and no real
  header support.
- `state.pending` is the **only** settle signal — requests made outside these
  shims won't be awaited.

## Example
```js
import { makePageFetch, makeXHR } from "turbo-crawl/render/page-fetch";

const state = { pending: 0 };
sandbox.fetch = makePageFetch(hostFetch, "https://example.com/", state);
sandbox.XMLHttpRequest = makeXHR(hostFetch, "https://example.com/", state);
// settle loop waits while state.pending > 0
```
