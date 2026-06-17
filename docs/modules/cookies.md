# `src/cookies.mjs` — RFC 6265-subset cookie jar

## Responsibility
Owns `CookieJar`: an in-memory store that parses `Set-Cookie` lines, scopes cookies by domain/path, honors `Secure`/`HttpOnly`/`Expires`/`Max-Age`/`SameSite`, and emits the `Cookie` header (or a name→value map for turbo-dom's `document.__cookieJar`). It implements a pragmatic subset of RFC 6265 — no public-suffix list, no per-cookie size limits, and (because no JS runs in Lane A) the document bridge is one-way: it never syncs page-side writes back.

## Exports
- `class CookieJar`
  - `setFromResponse(url, setCookieLines, now = Date.now())` — ingest each `Set-Cookie` line for the response `url`'s host. Drops malformed lines, rejected cookies, and treats `expiresAt <= now` as a deletion (removes the keyed entry).
  - `cookiesFor(url, now = Date.now())` → `Array<cookie>` applicable to `url`, sorted longest-path-first (RFC 6265 §5.4).
  - `cookieHeader(url, now = Date.now())` → `string` like `a=1; b=2`, or `""` when none apply.
  - `cookieMap(url, now = Date.now())` → `Map<name,value>` — the shape `document.__cookieJar` expects.
  - `get size` → number of live stored cookies (test/introspection).

## Key internals
- `parseSetCookie` splits on `;`, takes the first `name=value`, then `applyAttr` dispatches each attribute through `ATTR_HANDLERS` (keyed by lowercased name). Defaults: `path:"/"`, `secure:false`, `httpOnly:false`, `sameSite:"lax"`. `Domain` strips a leading dot and lowercases.
- `domainMatch(host, domain)` = exact or `host` ends with `.domain`. `pathMatch(reqPath, cookiePath)` is the RFC 6265 prefix rule: equal, or `reqPath` starts with `cookiePath` and the boundary is a `/` (or cookiePath already ends in `/`).
- `rejectedCookie` drops at ingest when the response host isn't within `Domain`, or `SameSite=None` without `Secure` (RFC 6265bis §5.5).
- `expiryOf` resolves absolute expiry: **Max-Age wins over Expires**; non-positive Max-Age → 0 (delete); no lifetime attribute → `Infinity` (session cookie). Send-time filtering uses `cookieApplies` = `notExpiredSecure` (live + secure-context ok) ∧ domain ∧ path.
- Store key is `` `${domain} ${path} ${name}` `` so same-name cookies at different scopes coexist.

## Depends on / used by
Imports no other turbo-crawl module. Consumed by `src/net.mjs` (request/response round-trip), `src/page.mjs`, and `src/index.mjs`.

## Invariants & gotchas
- Helpers are decomposed and attribute logic is table-driven (`ATTR_HANDLERS`) to keep each function's cyclomatic complexity under 6.
- `now` is injectable everywhere for deterministic expiry tests.
- The document bridge (`cookieMap`) is one-way only — Lane A runs no page JS, so there are no writes to sync back.
- A `Set-Cookie` with no explicit `Domain` defaults to the exact response host (host-only cookie).

## Example
```js
import { CookieJar } from "./src/cookies.mjs";

const jar = new CookieJar();
jar.setFromResponse("https://shop.example.com/login", [
  "sid=abc; Path=/; Secure; HttpOnly; Max-Age=3600",
]);
jar.cookieHeader("https://shop.example.com/cart"); // "sid=abc"
jar.cookieHeader("https://other.com/");            // "" (domain mismatch)
```
