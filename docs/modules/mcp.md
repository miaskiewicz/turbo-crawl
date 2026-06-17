# `mcp/handlers.mjs` + `mcp/server.mjs` — MCP surface over a turbo-crawl `Page`

## Responsibility
Exposes a single turbo-crawl `Page` to any agent over MCP. The tool table is 1:1
with the Page API — no CDP / Playwright-protocol emulation; the clean Page API is
the surface for a no-JS fetcher.
- `handlers.mjs` — builds the transport-free, SDK-free tool table (so it
  unit-tests offline). Each handler returns plain JSON-able data.
- `server.mjs` — wires the handlers into an `@modelcontextprotocol/sdk` `Server`,
  attaches inline JSON input schemas, and runs over stdio.

## Exports / API
- `buildTools(page) → Array<{ name, description, handler }>` (handlers.mjs) — the
  33-tool table for a Page (or a pool exposing the Page API). Handlers may be sync
  or async.
- `createServer(opts = {}) → { server, page }` (server.mjs)
  - `opts.page` — the Page to drive (default: a fresh `new Page()`).
  - Registers `ListTools` (name + description + `INPUT_SCHEMAS[name]`) and
    `CallTool` (looks up by name, runs the handler, wraps the result as
    `JSON.stringify` text content). Does **not** connect a transport.
- CLI entry (server.mjs): when run directly, `createServer()` + connect a
  `StdioServerTransport`; logs readiness to stderr.

## The 60 tools (grouped)

### Navigation / history (5)
- `goto` — navigate to `{ url }`; returns `{ status, url, title }`.
- `go_back` — back in history; `{ status, url }` or `null` at the start.
- `go_forward` — forward in history; `{ status, url }` or `null` at the end.
- `reload` — reload current page; `{ status, url }`.
- `set_user_agent` — set UA (navigator + HTTP header) for subsequent navigations.

### Batch + crawl (2)
- `batch` — fetch a list `{ urls, mode?, view?, concurrency? }`; `mode` is
  `no-js` (default) | `fast` | `secure`, `view` is `markdown` (default) | `text` |
  `html` | `links` | `interactive` | `ax` | `hydration`. Returns one
  `{ url, ok, status, finalUrl, title, data }` per URL (failures: `{ url, ok:false,
  error }`). Uses the real network, independent of the driving Page.
- `crawl` — full-site crawl from `{ url, maxPages?, maxDepth?, sameHost?, allow?,
  deny?, mode?, view?, markdown?, robots? }` over a frontier. `allow`/`deny` are URL
  regexes; JS modes render only JS-gated pages (Lane B). Returns
  `[{ url, status, depth, title, links, view?, extracted? }]`.

### Render-mode control (2)
- `render` — re-render the current page (or `{ url }`) with the JS tier and switch
  the Page to that `mode` (fast default | secure | no-js) for later navigations;
  `{ status, url, title }`.
- `set_mode` — set the navigation mode for subsequent goto/click without
  re-navigating now; `{ mode }`.

### JS execution + DOM history (4)
- `eval_js` — execute a JS **function body** (`code`; `return` for the value,
  `arguments` for `args`) and return the value. In render mode (`render`/`set_mode`
  fast|secure) it re-enters the **live render heap** (page globals, handlers) and
  records a DOM-history entry on mutation; otherwise it runs in a node:vm over the
  parsed DOM behind a best-effort guard (**not** a security sandbox — use secure
  mode for untrusted JS).
- `inject_js` — inject/execute a `<script>` with `code`; in render mode runs in the
  live heap (history grows), else the element persists in the HTML; `{ ok }`.
- `latest_dom` — most recent DOM snapshot after eval/inject (render tier), else the
  current HTML. `dom_history` — the full ordered list of snapshots (one per
  navigation + per mutating eval; read-only evals don't grow it).

### Session / detection (4)
- `detect_js` — heuristically detect whether the page needs JS;
  `{ jsRequired, textLength, scripts, reason }`.
- `robots_check` — `{ allowed, crawlDelay }` for `{ url, userAgent? }` from
  robots.txt.
- `get_cookies` — the Page jar's cookies as
  `[{ name, value, domain, path, expires, secure, httpOnly, sameSite }]`.
- `set_cookie` — add a cookie to the jar (`{ name, value, domain, path?, expires?,
  secure?, httpOnly?, sameSite? }`); `set_extra_headers` — persistent extra HTTP
  headers (`{ headers }`) merged into every request.

### Ergonomic helpers (4)
- `snapshot` — `{ url, title, headings, interactive, links }` in one call.
- `forms` — `[{ action, method, submitUrl, fields:[{ name, type, value }] }]`.
- `find_text` — elements containing visible `text` → `{ html, text }` (up to
  `limit`, default 20).
- `fetch_json` / `fetch_raw` — fetch a URL directly through the session jar →
  `{ status, finalUrl, json|body }`. `fill_many` — fill several fields
  (`[{ selector|i, value }]`) in one call. `extract_links` — `links` filtered by
  `sameHost`/`pattern`/`limit`.

### Page content / representations (8)
- `interactive_elements` — indexed array of interactive elements (the `[i]`
  handles for click/fill).
- `accessibility_tree` — `{ role, name, value?, children }` tree.
- `aria_snapshot` — YAML-ish ARIA snapshot (role/name tree) of the page body.
- `markdown` — readable Markdown of the main content.
- `html` — serialized current DOM.
- `text` — plain text with block-boundary line breaks.
- `links` — all absolute http(s) link targets.
- `requests` — URLs the page fetched during render (JS tier: fetch/XHR/module
  deps); empty without the render tier.

### Indexed-handle interactions (4)
(operate on the `[i]` handles from `interactive_elements`)
- `click` — activate element `[i]`; links navigate, submit buttons submit;
  returns new `{ status, url }` or errors if the element is inert (JS-only).
- `fill` — set value of control `[i]` (`{ i, value }`); returns an ack.
- `submit` — submit a form (optionally the form owning `[i]`); `{ status, url }`.

### Structured data (3)
- `extract` — structured JSON against a selector-bound `{ schema }`.
- `hydration_state` — mine server-embedded hydration data
  (Next/Nuxt/Apollo/JSON-LD/typed JSON) from inline scripts; **no JS executed**.
- `query` — query by CSS or XPath (`type: auto|css|xpath`, `first: boolean`);
  returns matched subtree(s) as `{ html, text }` (live `node` ref stripped).

### Locator resolution (2)
- `get_by` — Playwright-style resolution by `kind`
  (role|text|label|placeholder|testid|alttext|title) + `value` (+ optional `name`
  for role); returns matches as `{ html, text }`.
- `evaluate` — evaluate a JS **expression string** against the rendered DOM;
  returns the JSON-able result. (Function form is JS-API only.)

### Selector-string actions (5)
- `click_selector` — click the first element matching a CSS selector;
  `{ status, url }`.
- `fill_selector` — fill the first control matching a selector; `{ ok: true }`.
- `select_option` — select an `<option>` (by value/label) of the matched
  `<select>`.
- `check` — check the checkbox/radio matching a selector.
- `uncheck` — uncheck the checkbox matching a selector.

### Selector-string accessors (14)
- `get_attribute` — attribute of first match (`{ selector, name }`).
- `text_content` — text content of first match.
- `inner_html` — innerHTML of first match.
- `input_value` — current value of first matching control.
- `is_visible` — visibility of first match (cascade).
- `is_checked` — checked state of first matching checkbox/radio.
- `is_enabled` — enabled state of first match.
- `is_editable` — editable state of first match.
- `is_focused` — whether first match is the document's active element.
- `is_empty` — whether first match has no text and no element children.
- `aria_role` — resolved ARIA role of first match.
- `accessible_name` — accessible name of first match.
- `accessible_description` — accessible description of first match.
- `count` — number of elements matching a CSS selector.

(Group counts: navigation 5, batch+crawl 2, render-mode 2, JS-exec+DOM-history 4,
session/detection 4, ergonomic 4, content 8, indexed interactions 3, structured 3,
locator 2, selector actions 5, selector accessors 14 = **60**.)

## Key internals
- `GET_BY` map + `resolveBy(page, kind, value, name)` — dispatch for `get_by`;
  throws a descriptive error on an unknown `kind`.
- `elementSummary(el)` → `{ html: el.outerHTML ?? "", text: textOf(el) }` (from
  `../src/dom-ops.mjs`) — the JSON-safe shape returned by `get_by`.
- `stripNodes(result)` — recursively removes the live DOM `node` key (not
  JSON-serializable) from `query` results; used so `query` output can cross MCP.
- Selector-string tools call `page.locator(selector).first()` (or `.isVisible()` /
  `.count()` directly on the locator for `is_visible`/`count`).
- `INPUT_SCHEMAS` (server.mjs) — inline JSON Schemas per tool name; `ListTools`
  falls back to `{ type: "object", properties: {} }` for any missing name.
  Handlers themselves are schema-free.
- `CallTool` — `byName.get(name)` (throws `unknown tool` if absent), runs the
  handler with `arguments ?? {}`, returns `{ content: [{ type: "text", text:
  JSON.stringify(result ?? null) }] }`.

## Depends on / used by
- `handlers.mjs` depends on: `../src/dom-ops.mjs` (`textOf`); otherwise only the
  Page API. No transport/SDK imports (offline-testable).
- `server.mjs` depends on: `@modelcontextprotocol/sdk` (`Server`,
  `StdioServerTransport`, request schemas), `../src/index.mjs` (`Page`),
  `./handlers.mjs` (`buildTools`).
- Used by: agents over stdio (`node mcp/server.mjs`), or embedded via
  `import { createServer } from "turbo-crawl/mcp"`.

## Invariants & gotchas
- **1:1 with the Page API** — no browser/CDP emulation; tools mirror Page methods.
- The live DOM `node` is never sent over MCP — `query` strips it via `stripNodes`;
  `get_by` returns only `{ html, text }`.
- `evaluate` accepts only an **expression string** over MCP; the function form of
  `Page.evaluate` is JS-API only. Likewise `$eval`/`$$eval` are not MCP tools.
- `click` (and `click_selector`) error on inert / JS-only elements — those need
  the JS-execution tier.
- `requests` is empty unless the page was rendered through the JS render tier.
- A handler throwing surfaces as an MCP tool error; results are JSON-stringified
  (with `null` for `undefined`).

## Example
```js
import { createServer } from "turbo-crawl/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { server, page } = createServer();      // fresh Page (or pass opts.page)
await server.connect(new StdioServerTransport());
// agent calls e.g. goto { url }, then interactive_elements, then click { i }
```
