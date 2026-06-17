# `src/batch.mjs` — batch crawl a list of URLs

## Responsibility
Fetch + view a list of URLs under a chosen **execution mode**, with bounded
concurrency, returning one result per URL (input order). Per-URL failures are
captured in the result — they never abort the batch.

## Exports / API
- `batch(urls, opts?) → Promise<BatchResult[]>`
  - `opts.mode` — `"no-js"` (default) | `"fast"` | `"secure"`. Aliases accepted:
    `nojs`/`static` → `no-js`, `fast js`/`fast-js` → `fast`, `secure js`/
    `secure-js` → `secure`.
  - `opts.view` — per-URL view returned as `data`: `markdown` (default) | `text` |
    `html` | `links` | `interactive` | `ax` | `hydration`.
  - `opts.concurrency` — parallelism, **honored only for `no-js`** (default 4).
  - `opts.fetchHtml` — underlying network fetcher (injectable for tests / Lane B).
- `BatchResult` — `{ url, ok, status?, finalUrl?, title?, data?, error? }`.
  `ok:false` carries `error` (the message); the URL is otherwise skipped.

```js
import { batch } from "@miaskiewicz/turbo-crawl";

const out = await batch(["https://a.com", "https://b.com"], {
  mode: "fast",        // run page JS in-process
  view: "markdown",
  concurrency: 8,      // ignored for fast/secure (they run sequentially)
});
// → [{ url, ok:true, status:200, finalUrl, title, data: "<markdown>" }, ...]
```

## Key internals
- `MODE_ALIAS` — lookup table normalizing accepted spellings → canonical mode.
- `VIEWS` — dispatch map `view → (page) => result`; `resolveView` throws on an
  unknown view.
- `makeFetcher(mode, base)` — `no-js` returns the raw Lane-A fetcher; `fast`/
  `secure` wrap it in `jsRenderer({ mode, fetchHtml: base })` and expose its
  `close()`.
- `concurrencyFor(mode, opts)` — `no-js` honors `opts.concurrency`; JS modes are
  forced to **1** (a render owns turbo-dom's global virtual clock, so renders
  cannot safely overlap).
- `runOne(fetcher, url, render)` — fresh `Page` per URL, `goto`, then the view fn;
  `try/catch` turns any failure into `{ url, ok:false, error }`.
- `mapLimit(items, limit, fn)` — concurrency-bounded map preserving input order.

## Depends on / used by
- Depends on: `./net.mjs` (`fetchHtml`), `./page.mjs` (`Page`),
  `./render/index.mjs` (`jsRenderer`).
- Used by: the barrel (`src/index.mjs`) and the MCP `batch` tool
  (`mcp/handlers.mjs`).

## Invariants & gotchas
- **JS modes run sequentially** regardless of `concurrency` — by design.
- `no-js` never executes page scripts (fastest, safe for hostile pages); `secure`
  needs the optional `isolated-vm`/`esbuild` deps (it throws actionably if absent);
  `fast` runs page JS in-process (trusted targets only).
- The MCP `batch` tool uses the real network (no injected fetcher) — it does not
  reuse the driving Page's dispatcher/cache.
