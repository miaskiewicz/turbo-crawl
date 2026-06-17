# `src/url.mjs` — URL resolution, canonicalization, and scheme gating

## Responsibility
Owns the small set of URL primitives the crawler shares: resolving relative hrefs against a base, producing a canonical form for dedupe, and gating to http(s). It is pure (no I/O, no network) and stateless — it does not fetch, normalize Unicode hosts beyond what the WHATWG `URL` does, or maintain any seen-set itself.

## Exports
- `resolve(base, href)` → `string | null` — absolute URL string, or `null` when `href` is not a non-empty string or `new URL(href, base)` throws. Absolute special schemes (`javascript:`, `mailto:`) resolve to their verbatim absolute form.
- `canonicalize(url)` → `string | null` — for dedupe (SPEC §9): lowercases host, drops the fragment, strips known tracking params, sorts the remaining query, and forces an empty path to `/`. Returns `null` on an unparseable URL.
- `isHttpUrl(url)` → `boolean` — true only for `http:`/`https:`; false for non-strings, other schemes, and unparseable input.

## Key internals
- `canonicalize` iterates `u.searchParams`, dropping any key whose lowercase form is in `TRACKING_PARAMS` (`utm_*`, `gclid`, `fbclid`, `mc_cid`, `mc_eid`, `ref`, `ref_src`), then sorts the kept pairs by key then value before reassigning `u.search`. The WHATWG `URL` already lowercases scheme/host and drops default ports, so canonicalization leans on it rather than re-implementing those.
- All three exports wrap `new URL(...)` in try/catch and return `null`/`false` instead of throwing — callers never need to guard.

## Depends on / used by
Imports no other turbo-crawl module. Widely consumed: `src/page.mjs`, `src/markdown.mjs`, `src/crawl.mjs`, `src/extract.mjs`, `src/actions.mjs`, `src/frontier.mjs`, `src/index.mjs`, `src/render/scripts.mjs`, and `src/schema.mjs`.

## Invariants & gotchas
- Each function's cyclomatic complexity stays under 6 — the cost is that errors surface as `null`/`false`, not exceptions.
- Hot path: `canonicalize` and `resolve` run per discovered link, so the frontier relies on them for the dedupe key — two URLs differing only by fragment, tracking params, query order, or a missing trailing-slash-vs-empty path canonicalize equal.
- `canonicalize` does **not** strip a trailing `/` from non-empty paths, lowercase the path, or remove `index.html`; it only forces empty → `/`. Treat its output as the dedupe key, not a display URL.
- Full canonicalization is staged ("Canonicalization lands in Phase 3") — keep callers tolerant of it tightening later.

## Example
```js
import { resolve, canonicalize, isHttpUrl } from "./src/url.mjs";

const abs = resolve("https://ex.com/a/b", "../c?utm_source=x#frag");
// "https://ex.com/c?utm_source=x#frag"
canonicalize(abs);     // "https://ex.com/c"  (fragment + utm stripped)
isHttpUrl("mailto:a"); // false
```
