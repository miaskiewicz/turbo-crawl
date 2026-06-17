# `src/frontier.mjs` — the crawl URL queue with canonical dedupe and depth tracking

## Responsibility
The URL queue behind the `Crawler` (SPEC §9): a FIFO of `{ url, canon, depth }`
items, a visited set keyed on the **canonical** form, and a per-URL depth. Dedupe
on the canonical form means `?utm_*`, fragments, and query-order differences never
re-fetch the same page.

## Exports
`class Frontier`:
- `add(url, depth = 0)` — canonicalize and enqueue if unseen; records the canon in
  the visited set; returns `true` if newly added, `false` if a dupe or
  un-canonicalizable.
- `requeue(item)` — re-enqueue a previously-claimed item; **bypasses the visited
  gate** (the item was already counted when first added).
- `next()` — pop the next item, or `undefined` when drained.
- `seen(url)` — `true` if a URL's canonical form has ever been enqueued.
- `pending` (getter) — items not yet popped (`queue.length - head`).
- `size` (getter) — count of distinct canonical URLs ever enqueued.

## Key internals
- **Canonical dedupe** — `add` runs `url` through `canonicalize` (from `url.mjs`);
  a null/empty canon or one already in `#visited` is rejected. The visited set
  grows monotonically; it is never pruned.
- **Requeue** — `requeue` pushes straight onto `#queue` without touching
  `#visited`, so `claim()` in the crawler can defer-and-restore items it passed
  over without them being treated as fresh or as dupes.
- **Head compaction** — `next()` advances a `#head` cursor instead of `Array.shift`
  (which is O(n)). When `#head > 1024` *and* the consumed prefix exceeds half the
  array, the queue is sliced (`queue.slice(head)`) and `#head` reset to 0, keeping
  memory bounded on large crawls without per-pop copying.

## Depends on / used by
Depends on `canonicalize` from `src/url.mjs`. Used by `src/crawl.mjs` — one
`Frontier` per crawl run, seeded by `seedFrontier`, drained by `claim`/`worker`,
and grown by `harvestLinks`.

## Invariants & gotchas
- Low complexity (cc<6); no hostile-input assumptions — canonicalization is the
  only normalization.
- `add` is the *only* path that touches the visited set; `requeue` intentionally
  does not, so callers must not `requeue` URLs they want re-deduped.
- `pending` reflects un-popped queue length, not unique URLs — after a requeue the
  same canon can appear twice in the queue even though `size` counts it once.
- Visited and queue are unbounded; the only space optimization is head compaction.
- Not thread-safe in the async sense beyond JS's single-threaded event loop — the
  crawler relies on synchronous `claim` to interleave workers safely.

## Example
```js
import { Frontier } from "./src/frontier.mjs";

const f = new Frontier();
f.add("https://x.com/?utm_source=a#top", 0); // true
f.add("https://x.com/");                      // false — same canon
f.add("https://x.com/page", 1);               // true

let item;
while ((item = f.next())) {
  console.log(item.depth, item.url);
  if (busyHost(item.url)) f.requeue(item);     // defer without re-dedupe
}
console.log(f.size, f.pending);
```
