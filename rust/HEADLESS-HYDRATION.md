# Headless hydration — requirements & status (Rust port)

"Headless hydration" in turbo-crawl means two distinct things. Both are tracked
here so the requirements are explicit.

## 1. No-JS hydration-state mining (`hydration.mjs`)

Recover SPA data **without executing any JS** by mining the server-shipped state
that frameworks inline:

- `<script id="__NEXT_DATA__">` (Next.js, pure JSON)
- `<script type="application/ld+json">` (JSON-LD, object or array per block)
- `<script type="application/json" id="...">` (Remix / SvelteKit / typed islands)
- `window.__INITIAL_STATE__ / __APOLLO_STATE__ / __PRELOADED_STATE__ / __NUXT__ /
  __remixContext` — `window.X = <json>` assignments parsed **without eval**

**Requirements for the Rust port:** a `hydration` module in `turbo-crawl-view`
over `rtdom::Tree` — `query_selector(_all)` for the script tags, `text_content`
for the JSON, plus a tiny tolerant scanner for the `window.X = {...};` globals
(balanced-brace slice → `serde_json`). No turbo-dom additions needed.

**Status:** ⬜ not yet ported (part of task #4). Cheap, self-contained, offline.

## 2. JS-execution hydration (the render tier)

Run the page's **own** scripts so a client-rendered SPA hydrates, then read the
resulting DOM. This is `turbo-crawl-render` (deno_core isolate over the turbo-dom
`Tree`).

Requirements and where each stands:

| Requirement | Status |
|---|---|
| Real V8 isolate, host heap unreachable from guest | ✅ deno_core |
| DOM read/mutate/serialize bound to native `rtdom::Tree` | ✅ `DomBackend`/`TreeDom` |
| `document` + `Element` + `window`/`navigator`/`location`/`localStorage`/`console` | ✅ bootstrap |
| Timers (`setTimeout`/`rAF`/`queueMicrotask`) | ✅ virtual (drained by delay) |
| Promise / `async`-`await` / microtask resolution (event loop) | ✅ `render_html_async` |
| `fetch` over the real net stack (relative-URL aware) | ✅ `op_fetch` → `turbo_crawl_core::net` |
| `document.cookie` ↔ `CookieJar` bridge | ✅ `op_cookie_get/set` |
| Entry point | ✅ `render_page(backend, base_url, script)` → hydrated HTML |

**Known gaps / not-yet-required:**

- `XMLHttpRequest` (only `fetch` is wired). Add if a target SPA needs it.
- `MutationObserver`, `IntersectionObserver`, history API beyond `location.href`.
- `esbuild`→`swc` transform for non-ESM/JSX page bundles (task #8).
- Bundle/module loading: scripts are evaluated as classic scripts; ESM `import`
  graphs are not fetched/linked yet.
- The `node:vm` + `isolated-vm` dual backend (JS repo) collapses onto this one
  isolate (task #8).

## Lane routing (when to hydrate)

`detect.mjs` (Lane B heuristic) decides whether a page is JS-gated and worth the
isolate: near-empty rendered text + heavy external scripts, or an empty known SPA
mount (`#root`/`#app`/`#__next`/`[data-reactroot]`). Porting `detect` to
`turbo-crawl-view` (over `text` + `query`) is part of task #4; until then a caller
chooses Lane A (no-JS parse) vs Lane B (`render_page`) explicitly.
