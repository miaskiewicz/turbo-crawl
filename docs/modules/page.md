# `src/page.mjs` — a single navigable browsing context driven by an agent

## Responsibility
A `Page` is one navigable context. It owns **exactly one** turbo-dom env for its
lifetime and *resets* (re-parses) it on every hop — navigation is re-parse, not
re-render (SPEC §3.2). It bridges the session cookie jar and navigator overrides
into the DOM, tracks a back/forward history stack, and exposes the query /
locator / interaction surface an agent (or the `Crawler`) drives.

## Exports
`class Page` — `constructor(opts)` accepts `fetchHtml` (injectable fetcher for
tests / Lane B), `jar` (shared `CookieJar`, default fresh), `userAgent`
(shorthand for `navigator.userAgent` *and* the HTTP `user-agent` header), and
`navigator` (property overrides: platform, language, …).

Getters: `url` (final URL after redirects, or null), `status` (last nav HTTP
status), `cookies` (the jar), `navigator` / `window` / `document` (live turbo-dom
objects; the last three throw before the first `goto`).

- **navigation** — `goto(url, opts)`, `follow(href, opts)` (resolves relative
  against current URL; throws on non-HTTP), `reload(opts)` (replaces the history
  entry), `goBack(opts)` / `goForward(opts)` (return `null` at the ends).
- **queries** — `title()`, `interactiveElements(options)` (indexed §7.1; also
  refreshes the action snapshot; `{visibility:false}` skips the cascade pass),
  `links()`, `requests()` (URLs fetched during render; `[]` in Lane A),
  `markdown()`, `text()` (block-aware plain text), `html()` (serialized DOM, with
  DOCTYPE for `<html>`), `accessibilityTree()`, `extract(schema)` (§7.4),
  `hydrationState()` (mine Next/Nuxt/Apollo/JSON-LD inline state, no JS),
  `query(selector, opts)` (CSS or XPath → `{node, html, text}`).
- **locators** (Playwright-style, each returns a `Locator`) — `locator(css)`,
  `getByRole(role, opts)`, `getByText(text, opts)`, `getByLabel(text, opts)`,
  `getByPlaceholder`, `getByTestId`, `getByAltText`, `getByTitle`.
- **interaction** (§6) — `click(i, opts)` (links navigate, submit controls submit
  their form, inert elements throw), `clickElement(el, opts)`,
  `submitFromElement(el, opts)`, `fill(i, value)` (sets value in the COW overlay,
  no navigation; returns `{ok:true}`), `submit(i, opts)` (no arg → first form).
- **evaluate** — `evaluate(fn|expr, ...args)`, `$eval(selector, fn, ...args)`
  (first match; throws if none), `$$eval(selector, fn, ...args)` (all matches).
  These run in a `node:vm` context over the *current* DOM — DOM reads/measures,
  not a re-entry of the render isolate.
- **navigator config** — `setNavigator(props)` (persists across hops, applies to
  current page), `setUserAgent(ua)` (shorthand).

## Key internals
- One turbo-dom env per Page (`#env`); `#load` calls `env.reset(html)` on every
  hop after the first (`createEnvironment` builds it once).
- Cookie bridge: turbo-dom nulls `document.__cookieJar` on reset, so `#load`
  re-attaches `jar.cookieMap(finalUrl)` each hop for consistent `document.cookie`.
- Navigator overrides (`#nav`) are re-applied via `Object.assign` after each reset
  because turbo-dom resets globals; `#uaHeader()` injects the UA into fetches.
- History stack (`#history` + `#histIndex`); `#recordHistory` modes: `"push"`
  (normal, truncates forward entries), `"replace"` (reload), `"none"` (back/fwd).
- Action snapshot `#snapshot` is the last `interactiveElements()` result, an
  index→record map carrying `.ref` (a `WeakRef`). `#node(rec)` derefs it and
  throws a "stale element handle" error if collected (snapshot used after a nav).
- `#submitForm` builds the submission via `buildSubmission`, sets POST body /
  content-type when needed, and loads the response.

## Depends on / used by
Depends on `@miaskiewicz/turbo-dom/runtime`, `node:vm`, and the local modules
`actions`, `ax`, `cookies`, `extract`, `hydration`, `locator`, `markdown`, `net`,
`query`, `schema`, `text`, `url`. Used by `src/crawl.mjs` (warm Page pool, plus
lazy per-worker Lane-B fallback Pages) and by agents driving a context directly.

## Invariants & gotchas
- Per-method cyclomatic complexity stays low (cc<6); navigation modes are factored
  into `#load`/`#recordHistory`.
- No hostile-input hardening assumed — Lane A executes no page JS; `evaluate`/`$eval`
  run the **caller's** function, not page scripts.
- `document`/`window`/`navigator` throw before the first `goto`.
- Element handles are `WeakRef`s — re-query (`interactiveElements()`) after any
  navigation; a stale index throws.
- Lane A inert elements (jsHandler-only, no native nav) throw on `click` — failures
  are surfaced honestly, not swallowed (§6).

## Example
```js
import { Page } from "./src/page.mjs";

const page = new Page({ userAgent: "my-agent/1.0" });
await page.goto("https://example.com");
console.log(page.title(), page.status);

const els = page.interactiveElements();         // indexed snapshot
await page.click(0);                            // a link → navigates
await page.goBack();

await page.getByLabel("Email").fill("a@b.com"); // locator-driven
await page.submit();
```
