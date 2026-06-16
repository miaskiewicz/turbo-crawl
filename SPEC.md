# turbo-crawl — Design Specification

> Native-speed web crawler for AI agents, built on turbo-dom. Fetch + parse +
> extract with no headless browser — 100×+ faster on server-rendered pages.
> Indexed interactive elements, link graph, accessibility tree, structured
> extraction, and an MCP interface agents drive directly.

Status: **draft v0** · Depends on: `@miaskiewicz/turbo-dom@^0.2`

---

## 1. What we are building

turbo-crawl is a **separate library** that depends on turbo-dom and extends it
into a headless, agent-grade fetch/extract engine. turbo-dom stays a pure
parser + DOM; turbo-crawl owns everything turbo-dom deliberately does not:
network, navigation, crawl orchestration, and the LLM-facing page
representation that lets an agent *act* on a page.

It is **a crawler, not a browser.** It does not render pixels, run page
JavaScript, or do layout. It fetches HTML over the network, parses it at native
speed via turbo-dom, and exposes the page to an agent as:

- an **indexed set of interactive elements** (links, buttons, inputs, forms),
- a **link/form graph** for navigation,
- an **accessibility tree** and **markdown** view for LLM context,
- **structured extraction** against a user-supplied schema.

Positioning: *the browserless browser for AI agents* — the fast path for the
~50–70% of the useful web that is server-rendered and needs no browser. A
Chromium fallback tier (Lane B, §11) handles JS-gated pages behind the same API.

### 1.1 Why it can be fast

turbo-dom parses real-page/SSR HTML ~8–35× faster than parse5/happy-dom/jsdom
and runs query-heavy DOM work ~130–765× jsdom. turbo-crawl adds only network +
orchestration around that core, and re-navigation reuses turbo-dom's parse
memoization and arena reset. The cost model is "HTTP fetch + a cheap parse,"
not "boot a Chromium tab."

---

## 2. Non-goals (v0 → v1)

- **No JavaScript execution.** Page scripts never run. SPAs that render an empty
  shell return an empty body — detected and (optionally) routed to Lane B.
- **No layout / geometry.** No pixel coordinates, bounding boxes, or
  screenshots. Visibility is *approximated* from the CSS cascade (§7.3), never
  from a render.
- **No simulated mouse/keyboard at the OS level.** Interaction is modeled as
  link/form graph traversal (§6), not synthetic pointer events against a live
  SPA.
- **No fork of turbo-dom.** turbo-crawl consumes turbo-dom's public API only.
  Any capability gap is solved here or upstreamed as a small additive export.

---

## 3. Architecture & dependency on turbo-dom

```
  @miaskiewicz/turbo-dom        (unchanged dependency)
    ├─ parseBuffer                native HTML → immutable SoA buffer
    └─ runtime: createEnvironment(html) → { window, document, reset, touched }
                                  lazy COW DOM, selectors, event dispatch,
                                  partial CSS cascade (display/visibility/color)
            ▲
            │  imports ONLY the public surface above
            │
  turbo-crawl                    (this library)
    ├─ net          fetch, cookies, redirects, decode, robots
    ├─ crawl        frontier queue, scheduling, rate-limit, dedupe
    ├─ page         Page — owns one turbo-dom env, navigation loop
    ├─ extract      interactive elements · AX tree · markdown
    ├─ visible      cascade-based visibility filter
    ├─ actions      click / fill / submit via link+form graph
    ├─ schema       extract(jsonSchema) → structured JSON
    └─ mcp          MCP server exposing the Page API to agents
```

### 3.1 The exact turbo-dom surface we consume

| turbo-dom export | Path | Used by | For |
|---|---|---|---|
| `createEnvironment(html, opts)` | `@miaskiewicz/turbo-dom/runtime` | `page` | Build a DOM env from fetched HTML. Returns `{ window, document, reset, touched }`. |
| `env.reset(nextHtml)` | (return value) | `page` | **Primary navigation primitive.** Re-point the same Document/window at freshly-fetched HTML; drops the COW overlay + node cache, keeps class machinery warm. Cheaper than a fresh `createEnvironment`, and hits turbo-dom's `parseBufferCached`. |
| `document.querySelectorAll/querySelector` | DOM | `extract`, `actions` | Find links, forms, inputs, interactive roles. Hot-path, cached per `Document.__version`. |
| `el.getAttribute` | DOM | everywhere | `href`, `action`, `method`, `name`, `value`, `type`, ARIA. |
| `window.getComputedStyle(el)` | runtime | `visible` | Real resolved `display` / `visibility` from injected `<style>` + inline (turbo-dom's partial cascade). The basis of geometry-free visibility. |
| `el.textContent` / serialization | DOM | `extract`, `schema` | Accessible name, markdown, text extraction. |
| `document.__cookieJar` (seam) | runtime | `net` | turbo-dom already nulls a `__cookieJar` on reset; we can attach the live jar so `document.cookie` reflects the session. (If the read seam is insufficient, upstream a tiny additive getter — see §13.) |

**Rule:** turbo-crawl never reaches into turbo-dom internals beyond documented
seams. Hot-path discipline from turbo-dom's CLAUDE.md (no per-element
allocation in matchers) applies to our `extract`/`visible` passes too — index
loops over `querySelectorAll` results, no `classList`, no regex per node.

### 3.2 Navigation = re-parse, not re-render

A navigation is: fetch URL → get HTML string → `env.reset(html)`. The Page holds
**one** turbo-dom env for its lifetime and resets it per hop. Repeated shells
(common in paginated crawls) hit turbo-dom's parse cache and cost almost
nothing. No browser context, no tab, no teardown.

---

## 4. Package layout

```
turbo-crawl/
  package.json            # "dependencies": { "@miaskiewicz/turbo-dom": "^0.2" }
  SPEC.md                 # this file
  README.md
  src/
    index.mjs             # public API barrel: { Page, Crawler, version }
    net.mjs               # fetchHtml(url, jar) → { html, finalUrl, status, headers }
    cookies.mjs           # CookieJar (RFC 6265 subset)
    robots.mjs            # robots.txt fetch + cache + allow(url, ua)
    crawl.mjs             # Crawler — frontier, scheduling, concurrency, dedupe
    frontier.mjs          # URL queue + canonicalization + visited set
    page.mjs              # Page — wraps one turbo-dom env, navigation loop
    extract.mjs           # interactiveElements(), accessibilityTree(), markdown()
    visible.mjs           # isVisible(el) via getComputedStyle (cascade)
    actions.mjs           # click(i), fill(i, v), submit(), follow(href)
    schema.mjs            # extract(document, jsonSchema) → object
    url.mjs               # canonicalize, resolve(base, href), sameSite helpers
  mcp/
    server.mjs            # MCP server: goto, interactive_elements, click, ...
  adapters/
    playwright.mjs        # Lane B: same Page interface, Chromium backend (optional dep)
  test/
    *.test.mjs            # node --test
  bench/
    *.mjs
```

Pure ESM, Node ≥ 20 (Node 24 to match turbo-dom dev). Zero native deps of our
own; turbo-dom carries the only native/wasm artifact.

---

## 5. Core concepts

- **`Page`** — a single navigable context. Owns one turbo-dom env + one
  `CookieJar`. Stateful: `goto`, then query/act, then `goto` again. The unit an
  agent drives.
- **`Crawler`** — orchestrates many fetches across a frontier of URLs with
  concurrency, rate-limiting, robots, and dedupe. Uses `Page`s (or a pool) under
  the hood. The unit a bulk crawl uses.
- **`AgentView`** — the serialized, indexed representation of the current page
  handed to an LLM: interactive elements with stable `[i]` refs, AX tree,
  markdown. Produced by `extract`, consumed by `actions` (index → node).
- **`Frontier`** — the URL queue with canonicalization + visited set + per-host
  scheduling state.

---

## 6. Interaction model (no-JS link/form graph)

Because no JavaScript runs, we do **not** simulate clicks against a live SPA.
Instead we resolve the page's *intent graph*:

- **Link** (`<a href>`): `click(i)` / `follow(href)` → resolve URL against the
  document base → `goto`.
- **Form** (`<form action method>`): `fill(i, value)` mutates the input's value
  in the COW DOM overlay; `submit()` reads the form's controls, builds the query
  (GET → querystring, POST → body per `enctype`), and navigates to the action
  URL. Buttons of `type=submit` map to `submit()` of their owning form.
- **Everything else** (`<button onclick>`, `[role=button]` with JS handlers):
  flagged in the AgentView as `interactive: true, jsHandler: true` but **inert**
  in Lane A (no JS to fire). Surfaced honestly so the agent/router can decide to
  escalate to Lane B rather than silently no-op.

This is the correct, fast crawler model: the link/form graph is exactly what's
traversable without a JS runtime, and it parallelizes trivially.

---

## 7. Agent-facing representation (the differentiator)

What separates turbo-crawl from `Scrapy`/`colly`: a page view purpose-built for
an LLM to *act on*, in the shape browser-use popularized but without Chromium.

### 7.1 Interactive elements

`page.interactiveElements()` → array of:

```ts
{
  i: number,            // stable index for this snapshot, the agent's handle
  tag: string,          // 'a' | 'button' | 'input' | 'select' | 'textarea' | ...
  role: string,         // ARIA role (explicit or implicit)
  name: string,         // accessible name (label/aria-label/text/placeholder)
  value?: string,       // current value for form controls
  href?: string,        // resolved absolute URL for links
  type?: string,        // input type
  visible: boolean,     // cascade-derived (§7.3)
  jsHandler: boolean,   // has onclick/handler but no native nav → inert in Lane A
  ref: WeakRef<Element> // internal: index → node map for actions
}
```

Selection set: `a[href]`, `button`, `input` (non-hidden), `select`, `textarea`,
`[role=button|link|checkbox|tab|menuitem|...]`, `[contenteditable]`,
`[tabindex]`, `[onclick]`. Built with a single index loop over
`querySelectorAll` results — no per-node allocation, honoring turbo-dom's
hot-path rules.

### 7.2 Accessibility tree & markdown

- `page.accessibilityTree()` → nested `{ role, name, value, children }`,
  computed from semantics + ARIA. The compact, structural view for reasoning.
- `page.markdown()` → readable Markdown of main content (headings, links,
  lists, tables, code). For RAG/summarization context. Built from a DOM walk;
  boilerplate stripped via simple heuristics (nav/footer/aside demotion).

### 7.3 Visibility without geometry

We cannot measure pixels. We **approximate** visibility from turbo-dom's real
cascade: an element is treated as not-visible if `getComputedStyle(el).display
=== 'none'` or `visibility === 'hidden'`, or it carries `hidden` /
`aria-hidden="true"`, or `type="hidden"`. This is honest: it reflects *declared*
visibility, not rendered. Documented as such. It is enough to drop the bulk of
off-screen/menu-collapsed noise from the agent's element list — a capability
plain HTML scrapers lack, and one turbo-dom gives us essentially for free.

### 7.4 Structured extraction

`page.extract(schema)` where `schema` is a JSON-Schema-ish description with
optional per-field CSS selectors → returns a typed object (or array for `list`
fields). Pure DOM reads over turbo-dom's cached selector engine. This is the
"give me the product name, price, and rating" path that most agent crawls
actually want, skipping the click dance entirely.

---

## 8. Networking (`net` / `cookies` / `robots`)

- **`fetchHtml(url, { jar, headers, signal })`** — `undici`-based fetch.
  Follows redirects (capped), decodes gzip/brotli/deflate, sniffs charset
  (header → `<meta charset>` → BOM → utf-8 fallback) and decodes to a JS string,
  rejects non-HTML content types (configurable), enforces a max body size.
  Returns `{ html, finalUrl, status, headers, redirects }`.
- **`CookieJar`** — RFC 6265 subset: domain/path scoping, `Secure`,
  `HttpOnly`, `Expires`/`Max-Age`, `SameSite`. Attached to a `Page`; fed into
  request headers and updated from `Set-Cookie`. Bridged to
  `document.__cookieJar` so page-side `document.cookie` reads are consistent.
- **`robots.txt`** — fetched once per host, cached with TTL; `allow(url, ua)`
  honored by `Crawler` (overridable for authorized testing).

---

## 9. Crawl orchestration (`crawl` / `frontier`)

`Crawler` drives bulk crawls:

- **Frontier**: queue of canonicalized URLs (lowercase host, sorted query,
  strip fragment/known-tracking params), a visited `Set`, and per-host state.
- **Scheduling**: global + per-host concurrency caps, per-host politeness delay,
  exponential backoff on 429/5xx, retry budget.
- **Discovery**: after each `Page.goto`, harvest `links()` (filtered by
  same-host / allow-list / `robots`), enqueue new ones up to `maxDepth` /
  `maxPages`.
- **Output**: streaming async iterator of `{ url, status, view, extracted }`
  records, or a callback per page. Backpressure-aware.
- **Pooling**: N `Page`s reused across the frontier (each holds a warm turbo-dom
  env; `reset` per hop keeps allocation flat).

```js
for await (const rec of new Crawler({ start, maxPages: 500, concurrency: 8 })) {
  // rec.url, rec.view.interactiveElements, rec.extracted
}
```

---

## 10. Agent interface (`mcp`)

An MCP server (`mcp/server.mjs`) exposes a `Page` (or a managed pool) to any
agent. Tools, 1:1 with the `Page` API:

| MCP tool | Maps to | Returns |
|---|---|---|
| `goto(url)` | `page.goto` | `{ status, url, title }` |
| `interactive_elements()` | `page.interactiveElements` | indexed list |
| `accessibility_tree()` | `page.accessibilityTree` | tree |
| `markdown()` | `page.markdown` | string |
| `links()` | `page.links` | absolute URLs |
| `click(i)` | `page.click` | new `{ status, url }` |
| `fill(i, value)` | `page.fill` | ack |
| `submit()` | `page.submit` | new `{ status, url }` |
| `extract(schema)` | `page.extract` | structured object |

Design choice: **no CDP / Playwright-protocol emulation.** That surface is huge
and shaped for a JS-running browser; the clean `Page` API + MCP is the right
abstraction for a no-JS fetcher and is what agents consume directly.

A thin programmatic JS/TS API (`import { Page, Crawler } from 'turbo-crawl'`)
sits underneath the MCP layer for embedders.

---

## 11. Lane B — Chromium fallback (later)

For JS-gated pages, an **optional** adapter (`adapters/playwright.mjs`, peer dep
on `playwright`) implements the *same* `Page` interface against real Chromium.

- **Detection heuristic**: near-empty `<body>` text + large external script
  bundle, or a content hash that signals "shell only" → mark page as
  JS-required.
- **Routing**: `Crawler`/`Page` can be configured `{ fallback: 'playwright' }`;
  JS-required URLs are escalated to the adapter, everything else stays on the
  fast turbo-dom path. The agent/MCP surface is identical either way.
- Base library has **zero** Chromium weight; the adapter is opt-in.

This is what efficient production crawlers do: JS-on-everything is the slow
naive default; turbo-crawl makes the fast path the default and escalates only
when forced.

---

## 12. Implementation phases

Each phase is independently shippable and ends with a green test gate.

### Phase 0 — Scaffold & spike (proof of life)
- `package.json` with the turbo-dom dependency; ESM, `node --test`.
- `net.fetchHtml` (no cookies/robots yet) + `Page.goto` using
  `createEnvironment` then `env.reset` on subsequent hops.
- `extract.interactiveElements` (links + buttons + inputs) over
  `querySelectorAll`.
- **Acceptance:** `Page.goto(<real SSR page>)` then dump interactive elements
  and `links()` to stdout. End-to-end through turbo-dom.

### Phase 1 — Page API & interaction
- `actions.follow/click/fill/submit` (link + GET/POST form synthesis).
- `visible.isVisible` via `getComputedStyle` cascade; wire `visible` into the
  element list.
- `url.mjs` canonicalize/resolve; base-href handling.
- `extract.markdown` + `extract.accessibilityTree`.
- **Acceptance:** drive a multi-page form flow (search box → results → follow
  link) with no JS; visibility filtering verified against fixtures.

### Phase 2 — Networking hardening
- `CookieJar` + `Set-Cookie`/`Cookie` round-trip; bridge to
  `document.__cookieJar`.
- redirects, charset sniffing, gzip/brotli, max-size, content-type gate.
- `robots.txt` fetch/cache/allow.
- **Acceptance:** session cookies persist across hops; robots respected;
  malformed/large/binary responses handled without crashing.

### Phase 3 — Crawl orchestration
- `Frontier` (canonical + visited), `Crawler` with concurrency, per-host
  politeness, backoff, retry, `maxPages`/`maxDepth`.
- `Page` pooling (warm-env reuse).
- Streaming async-iterator output + `extract(schema)` integration.
- **Acceptance:** crawl a 500-page SSR site under N seconds with bounded memory;
  no duplicate fetches; politeness honored.

### Phase 4 — Agent / MCP surface
- `mcp/server.mjs` exposing the tool set in §10.
- `schema.extract` with selector-bound fields + `list`.
- Stable index semantics across a snapshot; `click(i)` after `interactive_
  elements()` resolves the same node.
- **Acceptance:** an agent (Claude) completes a "find X on this site and return
  its price" task end-to-end via MCP, no human glue.

### Phase 5 — Lane B fallback (optional)
- JS-required detection heuristic.
- `adapters/playwright.mjs` implementing `Page` against Chromium.
- `Crawler` routing config.
- **Acceptance:** a known SPA that returns an empty body in Lane A returns real
  content via the adapter, through the identical API.

---

## 13. turbo-dom changes (kept minimal)

Goal: **none** to start. Everything in §3.1 is already public or a documented
seam. Candidates to upstream as small *additive* exports only if a phase proves
them necessary:

- A public cookie-jar attach point if `document.__cookieJar` write access proves
  insufficient for Phase 2 (likely a 1-line getter/setter, no behavior change).
- An optional `baseURI` setter on the document so resolved hrefs use the fetched
  URL without us re-implementing base resolution (nice-to-have).

Any such change is additive, hot-path-neutral, and lands in turbo-dom with its
own test — never a behavioral fork.

---

## 14. Testing & benchmarks

- **Unit** (`node --test`): each module against fixtures; deterministic, offline
  (served from local fixture HTML, no live network in CI).
- **Differential**: compare `interactiveElements`/`markdown`/`extract` against a
  Playwright oracle on a fixture corpus to bound representation drift.
- **Crawl integration**: a local fixture site (static server) exercising the
  frontier, cookies, robots, forms.
- **Bench**: pages/sec on an SSR corpus vs a Playwright baseline; target the
  100×+ headline on the no-JS path. Memory flat across a long crawl (pool +
  `reset` reuse).

---

## 15. Open questions

1. **Cookie/`document.cookie` fidelity** — how far to bridge turbo-dom's
   `__cookieJar` vs keeping the jar entirely crawler-side. Phase 2 decides.
2. **Markdown boilerplate stripping** — heuristic vs. a readability-style pass;
   start heuristic, measure.
3. **Index stability** — recompute every `interactive_elements()` call vs. a
   versioned snapshot keyed on `Document.__version`. Lean on the latter to match
   turbo-dom's caching model.
4. **Lane B detection** — false-positive cost (needlessly booting Chromium) vs.
   false-negative (returning an empty SPA). Tunable threshold + override.
5. **Auth** — header/token injection and login-form flows are in scope for Lane
   A (forms work); full OAuth redirects may need Lane B.
```
