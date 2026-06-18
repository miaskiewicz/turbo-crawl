# turbo-crawl Rust port — remaining gaps

The browserless engine, JS-execution tier, napi bridge, Playwright shim, MCP
binary, packaging, and pure-logic parity are **done** (branch `rust-port`, builds
on crates.io `turbo-dom@0.3.1`, 225 Rust + 9 shim tests green). This document
tracks everything still missing, in detail, to reach JS feature parity + a true
`@playwright/test` drop-in.

Crate map: `core` (net/cookies/robots/url/frontier/crawl) · `page`
(Page/Navigator) · `view` (15 view modules) · `render` (deno_core JS tier) ·
`napi` (Node addon) · `mcp` (stdio MCP binary) · `rust/playwright-shim/` (JS
façade over the addon).

Priority: **P1** = needed for parity/drop-in · **P2** = correctness/perf · **P3**
= nice-to-have.

---

## G1 — Locator accessors (P1)

**Missing.** The shim `Locator` (`rust/playwright-shim/index.mjs`) exposes only
`count` / `textContent` / `innerHTML` / `allTextContents` / `first` / `nth`.
Playwright's locator surface (`src/locator.mjs` in the JS lib) has ~20 read
accessors.

**Add:** `getAttribute`, `inputValue`, `isVisible`, `isChecked`, `isEnabled`,
`isEditable`, `isEmpty`, `ariaRole`, `accessibleName`, `accessibleDescription`,
`accessibleErrorMessage`, `selectedValues`.

**Where / how.** The Rust impls already exist in `view::dom_ops` + `view::aria` +
`view::visible`, but the napi addon does not expose per-element reads (it's
HTML-string-in). Two options:
- (a) Add napi fns `attr(html, selector, name)`, `inputValue(html, selector)`,
  `isVisible(html, selector)`, … each parsing + locating the first match + calling
  the view fn. Simple, consistent with the current stateless model.
- (b) A node-handle session model (see G11) so a Locator resolves to a handle and
  reads are O(1). Better long-term; bigger change.

Start with (a). The shim Locator then calls e.g. `native.attr(this._page._html, sel, name)`.

**Acceptance:** shim Locator has the 12 accessors above, each with a node test
over `setContent`; values match the JS lib for the same HTML.

---

## G2 — `expect` matcher surface (P1)

**Missing.** Shim `expect` has 3 (`toHaveCount` / `toHaveText` / `toContainText`
+ `.not`). The JS drop-in (`playwright/expect.mjs`) implements the full
Playwright assertion surface.

**Add:** `toBeVisible`, `toBeHidden`, `toBeChecked`, `toBeEnabled`,
`toBeDisabled`, `toBeEditable`, `toBeEmpty`, `toBeFocused` (no-JS: always false /
honest), `toHaveAttribute(name, value?)`, `toHaveValue`, `toHaveCSS(name, value)`,
`toHaveClass`, `toHaveJSProperty` (Lane-A subset), `toContainText`/`toHaveText`
with array forms + regex, `toHaveCount`, `toMatchAriaSnapshot`.

**Depends on:** G1 (the accessors these assert over) + a napi `cssValue` and
`matchesAriaSnapshot` binding (the Rust fns exist: `view::dom_ops::css_value`,
`view::matches_aria_snapshot`).

**Acceptance:** each matcher + its `.not` has a node test; behavior matches the
JS expect for representative HTML. Pixel/geometry matchers (`toBeInViewport`)
either approximate (documented) or throw honestly.

---

## G3 — Locator-scoped actions (P1)

**Missing.** Actions are page-level (`page.fill(selector, value)`,
`page.click(selector)`). Playwright is `page.locator(sel).fill(value)` /
`.click()` / `.check()` / `.selectOption()` / `.press()`.

**How.** Give `Locator` a way back to a concrete target. Easiest: store the
originating selector on the Locator (for `page.locator(sel)` / `getBy*`), and add
`fill/check/uncheck/selectOption/click` that delegate to the page-level addon ops
using that selector (first match) or the resolved node. For `getBy*` (no CSS
selector) this needs G11's handle model, or re-resolving by the same kind/value.

**Acceptance:** `locator(sel).fill()/.check()/.selectOption()/.click()` work with
node tests; `getByRole(...).click()` works (link/submit intent).

---

## G4 — True `@playwright/test` drop-in (rewire existing shim) (P1)

**Missing.** I built a **parallel** façade at `rust/playwright-shim/`. The
repo's existing `playwright/` dir — `register.mjs`, `loader-hooks.mjs`,
`shim.mjs`, `test.mjs`, `expect.mjs`, `context-state.mjs`, `net-events.mjs`,
`storage.mjs` — is the actual zero-edit drop-in (agents run
`--import …/playwright/register`, which redirects `@playwright/test` to turbo).
It still targets the JS engine.

**How.** Point `playwright/`'s Page/Locator/expect/context at the napi addon
(`@miaskiewicz/turbo-crawl-native`) instead of the JS turbo-dom engine, reusing
G1–G3. Keep `register.mjs`/`loader-hooks.mjs` (the import-redirect mechanism)
intact; swap only the engine calls underneath.

**Acceptance:** an existing Playwright test file, run with the register import,
executes against the native addon (goto/locator/expect/actions) with no test
edits; the parallel `rust/playwright-shim/` is either merged into this or kept as
the minimal reference.

---

## G5 — Honest-throw for unsupported (pixel/render-only) APIs (P1)

**Missing.** `screenshot`, `pdf`, `boundingBox`, `video`, real `waitForTimeout`,
mouse/keyboard coordinate APIs are undefined on the shim Page/Locator. CLAUDE.md
rule: surface what can't be done rather than silently no-op.

**How.** Define these to `throw new Error("turbo-crawl: <api> unavailable — no-JS
render engine")`, mirroring the JS shim's behavior. `waitForTimeout` can resolve
(virtual time) or no-op with a note.

**Acceptance:** each unsupported API throws a clear message; a node test asserts
the throw.

---

## G6 — MCP action tools (P1)

**Missing.** `turbo-crawl-mcp` exposes 13 read tools. The JS MCP
(`mcp/handlers.mjs`) has ~40, including the action/navigation set: `click`,
`fill`, `submit`, `click_selector`, `fill_selector`, `select_option`, `check`,
`uncheck`, `set_user_agent`, `go_back`, `go_forward`, `reload`, plus locator
accessors (`get_attribute`, `is_visible`, `is_checked`, …) and `evaluate`.

**How.** The napi action ops + render now exist (`fill`/`setChecked`/
`selectOption`/`click`/`request`/`evaluate`/`render`); wire equivalents into
`turbo-crawl-mcp` (it depends on `view`/`core` directly, so it calls the Rust fns,
not the addon). Add: `click`, `fill`, `check`, `uncheck`, `select_option`,
`evaluate`, `render`, `reload`, plus the locator-accessor read tools. Navigation
history (`go_back`/`go_forward`) needs a session URL stack.

**Acceptance:** MCP `tools/list` covers the action set; `tools/call` mutates the
session tree (fill/check) and follows click intents (navigate/submit); node /
stdio test for each.

---

## G7 — `cache.mjs` (ResponseCache / conditional requests) (P2)

**Missing.** `src/cache.mjs` (ResponseCache: ETag/Last-Modified validators,
304 revalidation, body store) is not ported. `core/src/net.rs` has the
content-type gate + byte cap + cookies but dropped the `opts.cache` hooks
(`validators()` / `store()` / `body()` / 304 short-circuit) the JS `fetchHtml`
wires.

**How.** New `core/src/cache.rs`: a `ResponseCache` keyed by URL holding
ETag/Last-Modified + body; `net::fetch_html` re-adds the cache path
(`If-None-Match`/`If-Modified-Since` request headers, 304 → cached body). Mirror
the JS `notModified`/`finishFetch` logic already stubbed in net.rs comments.

**Acceptance:** conditional-request unit tests (localhost server returning 304);
parity with the JS cache behavior; cache wired through `Crawler`/`Page`.

---

## G8 — `dispatcher.mjs` (HTTP/2 + DNS cache) (P2)

**Missing.** `src/dispatcher.mjs` builds an undici Agent (HTTP/2 + DNS cache) the
JS crawler passes as the fetch dispatcher. reqwest pools connections and can do
HTTP/2, but there's no explicit DNS cache and the crawl driver doesn't share a
tuned client.

**How.** Build a shared `reqwest::Client` (HTTP/2 enabled, pool tuned) once per
crawl and thread it through `net::fetch_html` (add `client` to `FetchOptions`).
Optional: a DNS cache layer (`hickory-resolver`) if measured to matter.

**Acceptance:** the crawl driver reuses one client across hosts; a bench shows
connection reuse; HTTP/2 negotiated where the server supports it.

---

## G9 — `batch.mjs` + `measure.mjs` + `eval-guard.mjs` (P2/P3)

**Missing.** Three small JS modules unported:
- `batch.mjs` (P3) — batch-fetch convenience over the crawler. Port to a
  `core::batch` helper or expose via napi `crawl`.
- `measure.mjs` (P3) — timing/metrics. Port as optional instrumentation; keep the
  hot path zero-cost when off.
- `eval-guard.mjs` (P2) — guards for the JS-eval tier (resource/time limits,
  hostile-input protection). The render tier (`render`) currently runs page JS
  with virtual timers but **no execution budget / guard**. Port: a max
  microtask/timer-drain cap, a wall-clock/instruction budget, and the
  "host heap unreachable from guest" invariant audit (deno_core gives a true
  isolate, but add explicit limits).

**Acceptance:** eval-guard enforces a render budget (test: an infinite
`setTimeout` loop is capped, not hung); batch/measure ported or explicitly
descoped.

---

## G10 — Cookie persistence across `goto` (session/storageState) (P2)

**Missing.** The addon is stateless: every `fetchHtml`/`request` uses a fresh
`CookieJar`, so `Set-Cookie` from one navigation isn't sent on the next. The JS
lib threads a `CookieJar` through the Page/context and supports
`context.addCookies` / `storageState`.

**How.** Give the napi addon (or a session object) a persistent `CookieJar`
shared across `fetchHtml`/`request` calls; expose `addCookies` / `storageState`
get+set. This likely rides on G11's session model. Wire the same jar into the
render tier's `document.cookie` bridge + page `fetch`.

**Acceptance:** login-flow test — a cookie set on page A is sent on the request
to page B; `storageState()` round-trips.

---

## G11 — Stateful session model (handle-based Page) (P2)

**Missing / design.** The addon is stateless (HTML in, parse-per-call). This
reparses on every read and can't hold node identity, a live cookie jar, or a
mutated tree across calls. The JS lib + Playwright are stateful (a Page holds a
Document; locators resolve to live nodes).

**How.** A napi `Page`/session object owning a `Tree` (+ `CookieJar` + URL) across
calls, with reads/actions taking node handles (Locator → handle). Caveat: the
turbo-dom `Tree` and the deno_core isolate are **not `Send`** — the session must
be pinned to one thread (napi `ThreadsafeFunction`/`Reference` or a dedicated
worker thread + message channel). This is the enabler for G1(b), G3(getBy
actions), G10, and a big perf win over reparsing.

**Acceptance:** a `Page` napi class: `goto` parses once; subsequent
reads/actions/locators operate on the retained tree; identity preserved
(`locator` stable across reads); benchmarked faster than parse-per-call.

---

## G12 — render tier: XHR / observers / history / pooled isolate (P2/P3)

**Missing in `render`'s bootstrap** (`render/src/dom.rs` BOOTSTRAP):
- `XMLHttpRequest` (only `fetch` is provided) — some SPAs still use XHR (P2).
- `MutationObserver` / `IntersectionObserver` (P3) — frameworks may register them.
- History API beyond `location.href`: `pushState`/`replaceState`/`popstate` (P3).
- render's `fetch` uses a fresh jar — should share the session jar (ties to G10).
- **Perf (P2):** `render`/`evaluate` create a new thread + tokio runtime + V8
  isolate **per call** and reparse the HTML. Pool/reuse an isolate (per session,
  G11) and avoid reparsing.

**Acceptance:** an XHR-driven fixture hydrates under `render`; a render-budget
guard (G9) bounds it; a perf note/bench on isolate reuse.

---

## G13 — DOM-module differential parity (P2)

**Missing.** `#13` parity covers only the pure modules (url/robots/cookies) via
`rust/parity/gen-golden.mjs` → `golden.json`. The DOM views
(text/markdown/ax/aria-snapshot/extract/hydration/query/detect/locator/visible)
are covered by their own unit tests but **not** differential'd against the JS
implementation.

**How.** Install the turbo-dom **JS** package in the repo
(`npm i turbo-dom`), extend `gen-golden.mjs` with a `dom` section (parse
`fixtures/*.html` the JS way, run the `src/*.mjs` view fns), and add
`crates/turbo-crawl-view/tests/parity.rs` gated on `golden.dom`. Extension point
+ steps already documented in `rust/parity/README.md`.

**Acceptance:** Rust view output byte-/structurally-identical to the JS views for
a fixture set; gated so CI runs without Node.

---

## G14 — `esbuild` → `swc`; collapse the dual JS-render backend (P3)

**Missing (nice-to-have).** The JS lib's render tier has two backends (`node:vm`
plain + `isolated-vm` secure) and uses `esbuild` to transform/bundle page
scripts before isolate execution. The Rust render tier is a single deno_core
isolate and does **not** transform/bundle — it evaluates classic scripts only
(no ESM `import` graph, no JSX/TS).

**How.** Add an `swc`-based transform step (swc_core) ahead of `render`/`evaluate`
for non-ESM/JSX bundles; optionally a minimal module loader/linker for ESM
`import` graphs. Document that this supersedes the JS `node:vm`/`isolated-vm`
dual backend (one true isolate already collapses that).

**Acceptance:** a JSX/TS or ESM-`import` page script transforms + runs under
`render`; the JS dual-backend is formally descoped in favor of the deno_core
isolate.

---

## Suggested order

1. **G6** MCP action tools (ops exist; completes the agent server) — fast.
2. **G1 + G2 + G3 + G5** shim accessors/expect/locator-actions/honest-throws
   (makes the shim a real Playwright surface).
3. **G11** session model (unblocks O(1) reads, cookies, perf) → then **G10**, **G12 perf**.
4. **G7** cache, **G8** dispatcher (crawl correctness/perf).
5. **G13** DOM parity, **G4** rewire the real drop-in.
6. **G9** eval-guard, **G14** swc (hardening / nice-to-have).
