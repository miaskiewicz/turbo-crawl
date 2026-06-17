# `src/robots.mjs` — robots.txt parser + per-host cache

## Responsibility
Owns parsing of robots.txt (a pragmatic subset of the Robots Exclusion Protocol: `User-agent` grouping, `Allow`/`Disallow` with longest-match-wins, `*`/`$` wildcards, `Crawl-delay`) and `RobotsCache`, which fetches robots.txt once per origin and caches it with a TTL. It deliberately ignores sitemaps and host directives, and makes no scheduling decisions — it answers allow/deny and surfaces crawl-delay for the scheduler.

## Exports
- `parseRobots(text)` → `Array<group>` where each group is `{ agents:Set<string>, rules:[{allow, pattern, len, re}], crawlDelay }`. Lines after a rule re-open a new group on the next `User-agent`.
- `class RobotsCache`
  - `constructor(opts = {})` — `opts.fetchText(url) → {status, text}` (default `defaultFetchText`, a plain `fetch`); `opts.ttlMs` (default `1h`).
  - `async allowed(url, ua = "turbo-crawl", now = Date.now())` → `Promise<boolean>` — whether `ua` may fetch `url` (path+search tested).
  - `async crawlDelay(origin, ua = "turbo-crawl", now = Date.now())` → `Promise<number|undefined>`.

## Key internals
- `compile(pattern)` builds an anchored `^…` RegExp: `*` → `.*`, a trailing `$` → end anchor, everything else regex-escaped. Rules keep `len` (pattern length) for tie-breaking.
- Parsing is a small state machine: `parseLine` strips `#` comments and splits on the first `:`; `applyField` routes `user-agent` to `handleUserAgent` (opens/extends a group) and `allow`/`disallow`/`crawl-delay` through `GROUP_FIELDS` (ignored before the first User-agent). An empty `Disallow:` means allow-all and is skipped.
- Group selection `pickGroup` prefers any group whose agent list contains a non-`*` token that is a substring of the UA, else falls back to the first `*` group. Decision `groupAllows` evaluates every matching rule and keeps the **longest pattern** (`moreSpecific`; ties keep the earlier rule); no match → allow.
- Fetch policy in `#fetchGroups`: 2xx → parse; **4xx → allow all (`[]`)**; 5xx/unreachable/throw → conservative allow-all to avoid stalling. `#groupsFor` serves cached groups while `#isFresh` (within TTL).

## Depends on / used by
Imports no other turbo-crawl module (its default fetcher uses global `fetch`). Consumed by `src/index.mjs`.

## Invariants & gotchas
- Helpers (`handleUserAgent`, `handleRule`, `handleCrawlDelay`, `pickGroup`, `groupAllows`, …) are decomposed to keep each function's cyclomatic complexity under 6.
- UA matching is substring-based and case-insensitive — `"turbo-crawl/0.0"` matches a `turbo-crawl` group token.
- `allowed` tests `pathname + search`; `crawlDelay` takes an *origin*, not a full URL.
- Both reads share `#groupsFor`, so a single robots.txt fetch backs allow + delay; `now` is injectable for TTL tests.

## Example
```js
import { RobotsCache } from "./src/robots.mjs";

const robots = new RobotsCache({ ttlMs: 10 * 60 * 1000 });
if (await robots.allowed("https://example.com/admin", "turbo-crawl")) {
  // fetch it
}
const delay = await robots.crawlDelay("https://example.com"); // seconds | undefined
```
