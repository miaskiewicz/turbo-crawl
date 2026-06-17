# `src/net.mjs` — hardened HTML fetcher over Node's global `fetch`

## Responsibility
Owns the single network entry point `fetchHtml`: it wraps the global `fetch` (undici — so redirects and gzip/br/deflate decoding come for free) and adds the hardening the spec calls for: charset sniffing, a hard max-body-size cap, an HTML content-type gate, and an optional `CookieJar` round-trip. It deliberately does *not* parse HTML, schedule requests, consult robots, or persist anything — it returns decoded text plus response metadata and lets callers decide.

## Exports
- `class HttpError extends Error` — `new HttpError(message, code)` sets `name="HttpError"` and `.code`. Codes thrown: `BODY_TOO_LARGE` (Content-Length or streamed bytes exceed `maxBytes`) and `NOT_HTML` (content-type fails the gate).
- `async fetchHtml(url, opts = {})` → `Promise<{ html, finalUrl, status, headers, redirected }>`.
  - `opts.headers` override UA (`turbo-crawl/0.0 …`) and `accept` defaults; `opts.method`/`opts.body` (default `GET`); `opts.signal` (AbortSignal); `opts.jar` (CookieJar) injects `Cookie` and ingests `Set-Cookie`; `opts.maxBytes` (default `8 MiB`); `opts.allowNonHtml` skips the type gate; `opts.fetch` injects a fetch impl (tests / Lane B); `opts.maxRedirects` switches to manual redirect following.
  - Throws `HttpError` on oversized body or non-HTML content-type; lets fetch/abort errors propagate.

## Key internals
- `detectCharset(headers, head)` — sniff order is **Content-Type `charset=`** → `<meta charset>` / `<meta content="…charset=…">` over the first 1024 bytes (decoded as latin1) → `utf-8` fallback. `decode()` catches an unknown TextDecoder label and retries as utf-8.
- `readCapped` → `checkContentLength` (reject up-front if declared length blows the cap) then `accumulate` streams chunks, enforcing the cap as bytes arrive, and `concatChunks` flattens to one `Uint8Array` — so a huge body is never fully buffered.
- Redirect handling splits two ways: `followAuto` delegates to undici (`redirect:"follow"`, cap 20); `followManually` (used only when `opts.maxRedirects` is set) loops `redirectHop`, re-deriving Cookie/Set-Cookie per hop and rewriting method/body via `nextMethod` (303 → GET; 301/302 on POST → GET; 307/308 keep) in `advanceHop`.
- `isHtmlType` is permissive when the server omits content-type (returns true).

## Depends on / used by
Imports no other turbo-crawl module (only references `CookieJar`'s shape via JSDoc). Consumed by `src/page.mjs`, `src/index.mjs`, and `src/render/index.mjs`.

## Invariants & gotchas
- Helpers are decomposed (`buildHeaders`, `ingestSetCookie`, `gateHtmlType`, `decodeBody`, `redirectHop`, …) to keep each function's cyclomatic complexity under 6.
- Streaming cap is the hot path — keep `accumulate` allocation-light.
- `Set-Cookie` ingest needs `res.headers.getSetCookie` (guarded with a `typeof` check); absent on non-undici fetch mocks.
- `finalUrl` falls back to the request URL when `res.url` is empty.

## Example
```js
import { fetchHtml, HttpError } from "./src/net.mjs";
import { CookieJar } from "./src/cookies.mjs";

const jar = new CookieJar();
try {
  const { html, finalUrl, status } = await fetchHtml("https://example.com/", {
    jar,
    maxBytes: 2 * 1024 * 1024,
  });
  console.log(status, finalUrl, html.length);
} catch (e) {
  if (e instanceof HttpError && e.code === "NOT_HTML") console.warn("skipped non-HTML");
  else throw e;
}
```
