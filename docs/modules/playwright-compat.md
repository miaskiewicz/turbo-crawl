# `playwright/` — Playwright-compatibility façade

## Responsibility
Lets an existing Playwright script run on turbo-crawl's engine — with **NO
playwright or chromium loaded at runtime**. `chromium`/`firefox`/`webkit` all
launch the **same** turbo-crawl-backed pseudo-browser (there is no real browser).
Genuinely pixel-only APIs throw a clear error pointing at the JS-execution tier.

- `index.mjs` — browser/context/page shims + the three launcher aliases.
- `expect.mjs` — a web-first assertions subset over a turbo-crawl Locator.
- `net-events.mjs` — Playwright-shaped `PWRequest`/`PWResponse`/`PWConsoleMessage`
  + URL matchers built from the render tier's raw request/response records.
- `storage.mjs` — `localStorage`/`sessionStorage` impl (Proxy over a Map) held at
  the context level so it survives across navigations.
- `context-state.mjs` — the persistent `BrowserContext` surface: cookie jar,
  per-origin storage, init scripts, routes, extra headers, `storageState`.

## Execution modes
- **No mode** (default) → Lane A: static fetch + parse, no page JS. Still emits
  navigation `request`/`response` events.
- **`mode: "fast" | "secure"`** (passed to `launch`/`newContext`/`newPage`) → the
  JS-execution tier runs the page's scripts. Page-initiated `fetch`/XHR surface as
  `request`/`response` events, `console`/`pageerror` fire, `route()` can intercept,
  and `localStorage`/cookies persist across navigations in the same context.

## Exports / API
- `chromium`, `firefox`, `webkit` — all the same
  `browserType = { launch: async (opts) => new Browser(opts) }`.
- `expect(locator) → LocatorAssertions` (re-exported from `expect.mjs`).
- `PWPage`, `Browser`, `BrowserContext` (classes, for advanced use).

```js
import { chromium, expect } from "@miaskiewicz/turbo-crawl/playwright";
const browser = await chromium.launch({ mode: "fast" });
const ctx = await browser.newContext({ storageState });   // auth reuse
const page = await ctx.newPage();
const [resp] = await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api") && r.request().method() === "PUT"),
  page.getByRole("button", { name: "Save" }).click(),
]);
```

### `Browser` / `BrowserContext`
- `Browser.newPage(opts)` — a page with its own fresh `ContextState` (seeded from
  `opts.storageState`).
- `Browser.newContext(opts)` — a `BrowserContext` merging launch + context opts;
  `opts.storageState` seeds the jar + per-origin storage.
- `BrowserContext.newPage()` — pages **share** the context's `ContextState` (jar,
  storage, init scripts, routes, headers) and forward their events to the context.
- Context state surface: `addCookies`, `cookies`, `storageState`, `addInitScript`,
  `route`/`unroute`, `setExtraHTTPHeaders`, `on`/`off`, `pages`, `close` (no-op).

### `PWPage` (wraps a turbo-crawl `Page`)
- `get tcPage` — escape hatch to the underlying Page. `context()` — owning context.
- Navigation: `goto` (→ `PWResponse`, also emits `domcontentloaded`+`load`),
  `goBack`/`goForward` (→ `PWResponse`|`null`), `reload`, `url()`, `title()`,
  `content()`.
- **Events** (`node:events` EventEmitter): `on`/`once`/`off`/`removeListener` for
  `request`, `response`, `requestfinished`, `requestfailed`, `console`,
  `pageerror`, `domcontentloaded`, `load`, `close`.
- **Waiting on traffic**: `waitForEvent(event, opts|predicate)`,
  `waitForResponse(url|regex|pred, {timeout})`, `waitForRequest(...)` — one-shot,
  reject on timeout (default 30 000 ms).
- **Routing**: `route(pattern, handler)` / `unroute(...)`; handler gets a
  Playwright `Route` (`fulfill({status,body,json,headers})` / `abort()` /
  `continue()`). Page routes are checked before context routes.
- **Init / headers**: `addInitScript(fn|string|{content}, arg?)` runs before any
  page script on every navigation; `setExtraHTTPHeaders(headers)`.
- Locators, selector shorthands, accessors, `evaluate`/`$eval`/`$$eval` — delegate
  to the Page (unchanged).
- No-op emulation: `emulateMedia`, `setViewportSize`, `bringToFront`,
  `waitForLoadState`/`waitForTimeout`/`waitForURL`.
- Pixel-only → throw `jsTier`: `screenshot`, `pdf`, `hover`.

### Shapes (`net-events.mjs`)
- `PWRequest` — `url()`, `method()`, `headers()`, `postData()`, `resourceType()`.
- `PWResponse` — `url()`, `status()`, `ok()`, `headers()`, `request()`, `text()`,
  `json()`.
- `PWConsoleMessage` — `type()`, `text()`, `args()`.
- `urlMatcher(pattern)` — glob (`**`=any, `*`=non-slash) | RegExp | predicate.

## Key internals
- `PWPage.#netHooks()` builds the hooks the render tier calls
  (`onRequest`/`onResponse`/`onRequestFinished`/`onRequestFailed`/`intercept`);
  each emits the matching event (and re-emits on the context emitter).
- `#makeRenderer` builds a per-page `jsRenderer` bound to the context's
  `storageFor`, the page's net hooks, and `console`/`pageerror` hooks; `initScripts`
  is a **live, enumerable getter** (context + page scripts read at each render).
- `withExtraHeaders` / `wrapLaneA` compose the effective fetcher; Lane A still
  emits navigation `request`/`response` via the same hooks.
- `ContextState` owns the `CookieJar` (shared with the Page), lazily-created
  per-origin storage, and `runRoutes` (first matching route wins: `null`=continue,
  a mock=fulfill, `"abort"`).

## Depends on / used by
- `index.mjs` → `../src/page.mjs`, `../src/net.mjs`, `../src/render/index.mjs`,
  `./context-state.mjs`, `./net-events.mjs`, `./expect.mjs`.
- `context-state.mjs` → `../src/cookies.mjs`, `./net-events.mjs`, `./storage.mjs`.
- Used by: Playwright scripts importing `@miaskiewicz/turbo-crawl/playwright`.

## Invariants & gotchas
- **No browser, no playwright dependency at runtime.**
- Event timing: in render mode all page traffic fires **synchronously during the
  triggering action's `await`** — use `Promise.all([page.waitForResponse(...),
  action()])` (register the wait before the action), exactly as in Playwright.
- **No auto-retry for the DOM** — it is static per navigation; `waitForLoadState`/
  `waitForTimeout`/`waitForURL` resolve instantly and `waitForSelector` throws
  `jsTier` when nothing matches.
- Cookies set by the **server** (`Set-Cookie`) persist across `goto` within a
  context and are sent on later requests; page-side `document.cookie` writes are
  **not** synced back to the jar (one-way).
- `storageState()` dumps cookies + per-origin `localStorage` (not
  `sessionStorage`), matching Playwright.
- Pixel APIs (`screenshot`/`pdf`/`hover`) throw a pointed `jsTier` error — never
  silently faked.

## Example
```js
import { chromium } from "@miaskiewicz/turbo-crawl/playwright";

const browser = await chromium.launch({ mode: "fast" });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => console.log(m.type(), m.text()));
page.route("**/analytics/**", (route) => route.abort());   // block analytics
await page.goto("https://example.com");
const state = await ctx.storageState();                    // reuse auth elsewhere
await browser.close();
```
