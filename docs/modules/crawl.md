# `src/crawl.mjs` — bulk crawler: an async-iterator over a politeness-gated frontier

## Responsibility
Drives bulk crawls over a `Frontier` (SPEC §9) with global + per-host concurrency,
per-host politeness delays, backoff on `429`/`5xx`, a retry budget, and depth/page
caps. Output is a **backpressure-aware async iterator** of page records. A pool of
warm `Page`s is reused across the frontier (env reset per hop), and pages that
look JS-gated can be re-rendered through a configured Lane-B fallback fetcher.

## Exports
`class Crawler` — `constructor(options)` merges `options` over `DEFAULTS` into
`this.options`. It is **async-iterable**: `for await (const rec of new Crawler({…}))`.

**CrawlerOptions** (defaults in parens):
- `start` — seed URL or array of URLs (filtered to HTTP).
- `concurrency` (4) — number of warm Pages / parallel workers.
- `perHostConcurrency` (2) — max simultaneous in-flight fetches per host.
- `politenessMs` (0) — min gap between fetches to a host.
- `maxPages` (100) — produced-record cap; stops the crawl.
- `maxDepth` (3) — links beyond this depth are not harvested.
- `retryBudget` (2) — retries per item on retryable status / thrown error.
- `backoffMs` (200) — base for exponential backoff (`backoffMs * 2**(n-1)`).
- `sameHostOnly` (true) — restrict to the seed hosts.
- `robots` — optional `{ allowed(url, ua), crawlDelay(origin, ua) }` gate.
- `schema` — selector-bound schema; when set, each record gets `extracted`.
- `fallback` — Lane-B fetcher (Chromium adapter); enables JS re-render.
- `followRequests` — also harvest render-discovered request URLs as links.
- `allow(url)` — predicate; URLs failing it are dropped.
- `jar` — shared `CookieJar` across the Page pool.
- `signal` — `AbortSignal` threaded into every sleep (rejects "aborted").
- `now` (Date.now) / `sleep` (real timer) — **injectable clock/timer for tests**.
- `view` (on) / `markdown` (off) — control the per-record `view` payload.
- `userAgent` ("turbo-crawl") — robots UA; `httpUserAgent` / `navigator` configure
  the Page pool; `fetchHtml` / `detect` are passed through.

**Record shape** yielded by the iterator:
`{ url, status, depth, lane, title, links, view?, extracted?, error? }` —
`lane` is `"A"` or `"B"`; `view` (unless `view:false`) is
`{ interactiveElements, markdown? }`; `extracted` present when `schema` is set;
terminal errors yield `{ url, status:0, depth, error }`.

## Key internals
- **`Channel`** — single-producer/many-consumer async channel backing the
  iterator: `push`/`close`/`next`, buffering values or parking waiters.
- **`makeState(crawler)`** — per-run mutable state: resolved `sleep`/`now`,
  `channel`, `frontier`, `startHosts`, `hostState` map (`{inFlight, nextAt}`),
  `fallbackPages` WeakMap, plus `produced`/`active` counters.
- **`claim(st)`** — pulls the next frontier item whose host is under its
  concurrency cap and past its politeness gate (`itemReady`); passed-over items
  are `requeue`d (bypassing the visited gate); returns the min wait when nothing's
  ready.
- **`resolvePoliteness`** — computes a host's effective delay once: `max(politenessMs,
  robots Crawl-delay × 1000)`, cached on the host state (robots consulted ≤ once/host).
- **`gotoWithRetry`** — navigates with retry/backoff on retryable statuses or
  thrown errors; updates `state.nextAt = now() + politeness` after each attempt.
- **`maybeLaneB`** — if `detectJsRequired` flags a shell-only parse and a fallback
  Page exists, re-renders through it and marks the record `lane:"B"`.
- **`harvestLinks` + `followRequests`** — enqueue accepted out-links (and, when
  enabled, discovered request URLs) at `depth+1`, gated by `acceptLink`
  (HTTP-only, same-host, allow-predicate).
- **`worker`** — each pulls items until the page cap or a true drain
  (`active===0 && frontier.pending===0`), idling on a host wait or a 5ms tick.
- The iterator builds the warm Page pool, fans `concurrency` workers across it,
  pushes any thrown error as a record, and closes the channel on completion.

## Depends on / used by
Depends on `detect`, `schema`, `frontier`, `page`, `url`. Top-level entry point —
used by CLI / library callers that want a managed bulk crawl rather than driving a
single `Page`.

## Invariants & gotchas
- Helpers are module-level (not closures) so each keeps cc<6 and carries `st`
  explicitly instead of nesting in the iterator.
- No hostile-input assumptions; Lane A runs no page JS.
- The politeness clock is injectable (`now`/`sleep`) — tests advance virtual time
  without real waits; `signal` aborts in-flight sleeps.
- `maxPages` caps *produced* records but in-flight fetches may still complete; the
  cap is re-checked before publishing.
- `requeue` deliberately bypasses the visited set — deferred items were already
  counted, so re-adding via `add` would be a no-op.

## Example
```js
import { Crawler } from "./src/crawl.mjs";

const crawler = new Crawler({
  start: "https://example.com",
  maxPages: 50,
  perHostConcurrency: 2,
  politenessMs: 500,
});

for await (const rec of crawler) {
  if (rec.error) { console.warn("failed", rec.url, rec.error); continue; }
  console.log(rec.lane, rec.status, rec.url, rec.title);
}
```
