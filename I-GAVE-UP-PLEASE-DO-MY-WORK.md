# Interactive SPA login — SOLVED ✅ (handoff #3)

**The browserless engine now DRIVES an authenticated SPA, not just renders it.** A real
PropelAuth login runs end-to-end through the Playwright shim, no Chromium:
`fill email/password → click submit → React onSubmit → POST /api/fe/v3/login (200) →
session cookie → GET /refresh_token → client redirect chain (login → /post-login →
/auth/me → /entity/{id}/admin/home)`. **The entity dashboard renders fully** (authed nav:
Inicio/Personal/Nómina/Gastos/Reportes/…, user identity, Cerrar sesión).

How (commits `eb70d68` + `73a8ed0` on `rust-port`):
- **`PageSession`** (render tier): a persistent V8 isolate that keeps the hydrated app
  (React fibers, closures, delegated listeners) ALIVE across ops — the prior render
  paths serialized + `reset()` after each call, killing the app. Thread-per-session
  (isolate is `!Send`). `eval` drains to a STABLE-DOM signal (background analytics
  polling never idles) and returns best-effort on budget.
- **Real event dispatch** for click/fill (fill bypasses React's `_valueTracker` via the
  native value setter; click fires mousedown→focus→mouseup→click + the form's submit
  default action). The vendored binding already does full bubbling → React delegation
  fires.
- **`op_fetch` honors `fetch(url, init)`** (method/headers/body) + sends browser
  `Origin`/`Referer` + the cookie jar (was a bodyless GET → 404, then Origin-rejected).
- **Missing globals**: Headers/File/Blob/FileReader, document.referrer/URL, screen/
  viewport (PostHog `.split`/`.height` looped without them).
- **Shim**: networkidle goto opens a live session; click/fill dispatch real events;
  `_selector` propagates through `.first()`; `page.evaluate`/`waitForURL` pump the
  session; **in-app redirects (path change) re-load the new route as a fresh page**
  (carrying cookies) so the redirect chain completes hop-by-hop.

napi: `liveOpen`/`liveEval`/`liveSerialize`/`liveCookies`/`liveClose`. Tests:
`live_session_dispatches_events_into_running_app`, `web_platform_globals_for_hydration`.
Gate green (clippy 0, render 29, shim 76/19).

## Remaining (the next layer): cold authed-page loads render empty

`page.goto('/entity/{id}/admin/people', {networkidle})` AFTER login (cookie carried)
renders an EMPTY body with ZERO fetches — the page doesn't bootstrap auth/data on a
direct (cold) navigation, unlike the dashboard reached *through* the login flow. So the
auth-guard / admin-page e2e specs (most of the 114) still fail "locator matched no
elements". The full login→dashboard path works; cold deep-page rendering is the next
investigation (likely: PropelAuth AuthProvider re-bootstrap from the cookie + the page's
data fetch not running on a fresh session at a deep route — possibly a redirect-follow
interaction or a budget-cut hydration). A few specs (`boundingBox`) need a real browser.

---
---

# (older) Login hydration — SOLVED ✅

Goal: render payroll-app's client-rendered `/login` headlessly through turbo-crawl's
render tier (so the Playwright shim / `run_playwright` MCP tool can drive the real SPA,
no browser).

**DONE.** The live payroll `/login` (Next.js + PropelAuth, fully client-rendered) now
hydrates end-to-end with NO browser. The form renders: `login-email-input`,
`login-password-input`, `login-submit-button`, plus Google/Microsoft SSO + magic-link +
language/theme buttons. Verified against a standard `next build` (webpack) prod server.

It took FOUR fixes, each unmasking the next (the previous handoff, "OLD" below, saw only
the first as an unbreakable wall and concluded "needs a real browser" — wrong):

1. **core-js `nomodule` skip** — the "infinite loop". The pump ran the legacy
   `polyfill-nomodule` bundle (core-js) that overwrites native `Promise`; its reaction
   drain via queueMicrotask→timer-queue spun forever. Module-capable runtimes skip
   `nomodule` scripts; now we do too. (commit `012920c`)
2. **ReadableStream park-on-empty** — RSC flight is a streaming producer; the reader
   reported EOF on an empty-but-open stream, truncating flight → render desynced. Now it
   parks until enqueue/close. (commit `012920c`)
3. **FormData global** — PropelAuth builds its credential payload with FormData; deno_core
   ships none → "FormData is not defined". Added a spec-shaped impl. (commit `d052bf7`)
4. **URL-backed `location`** — browser_env's static location didn't update `pathname`/
   `search` when `href` was set, so Next's `usePathname()` returned "/" and the auth route
   guard rendered "Redirecting…" instead of the form. Now `location` is backed by the URL
   polyfill and decomposes on `href` set. (commit `d052bf7`)

Gate green after all four: `cargo test --workspace`, `clippy` (0 warnings), `cargo fmt`,
and `npm run test:playwright` (shim 19/19). Tests added: `nomodule_scripts_are_skipped`,
`readable_stream_parks_for_async_producer`, `form_data_present_and_spec_shaped`,
`location_href_decomposes_into_components`.

Everything below is the debugging history (still useful — gotchas, test-env traps).

## Two non-obvious gotchas (read these first)

1. **The "infinite render loop" was core-js, NOT React signals.** The pump ran a
   `<script noModule>` legacy polyfill bundle that overwrites native `Promise`; its
   reaction drain via `queueMicrotask` (→ timer queue) spins forever. The
   "reactive-signals flush" the OLD handoff chased is core-js's Promise notify
   (`zloirock`). Fix = skip `nomodule` scripts (done). Full detail below.

2. **`fetchHtml` (napi) returns a JSON string `{"html":...,"status":...}`, not raw
   HTML.** You MUST `JSON.parse(await addon.fetchHtml(url)).html` before `hydrate`.
   Passing the raw JSON in JSON-escapes every `"`→`\"`, so the inline `__next_f.push`
   flight scripts fail to eval ("Invalid or unexpected token"). This faked a "textContent
   over-escaping" bug during debugging — it was the probe misusing the API, not rtdom.

## The actual root cause of the infinite loop (now fixed)

Next ships a legacy polyfill bundle as `<script src=".../polyfill-nomodule.js" noModule="">`.
A module-capable browser (and ours) **skips `nomodule` scripts** and runs the module
build. Our hydration pump executed EVERY `<script>`, so it ran core-js's
`polyfill-nomodule` bundle, which **overwrites the native global `Promise`** with
core-js's. core-js's Promise drains its reaction queue through `queueMicrotask`, which we
alias to the timer queue — so every promise reaction posted a timer, forever ("1000
timers per round" = the symptom the previous agent saw). The "reactive-signals flush"
loop `for(var r,n=t.reactions;r=n.get();)…t.notified=!1` is **core-js's Promise internal
notify**, not a signals lib (`zloirock` / `core-js_shared__` confirm it).

**Fix (shipped this branch):** the pump honors `nomodule` —
`rust/crates/turbo-crawl-render/src/runtime.rs`, `__execScriptEl` skips elements with a
`nomodule`/`noModule` attribute. Regression test: `nomodule_scripts_are_skipped` in
`tests/render.rs`. Gate green (cargo test/clippy/fmt).

## Where it dies NOW (the real, isolated wall)

The infrastructure ALL works now. Verified by instrumenting a clean prod build (see
"test env gotcha" below) and the dev server:

- ✅ Turbopack runtime installs: `TURBOPACK.push` → `registerChunk` (modules run).
- ✅ Flight consumer installs: `__next_f.push` → `nextServerDataCallback`.
- ✅ Flight ReadableStream is **fully read and closed** (one stream, no `pull`; rows
  enqueue, `close()` fires on the DOMContentLoaded `setTimeout`, reader drains to EOF).
  This is what the **ReadableStream park-on-empty fix** (shipped, below) unblocked — before
  it, the reader hit the empty-but-open stream and returned `{done:true}`, truncating
  flight.

But React's **render phase still loops** (budget exceeded at 10s AND 60s — a genuine
non-converging loop, not slow) and never commits app DOM: `divs` stays at 1 (the server
`<div hidden>` shell), `inputs=0`, and **`console.info('[Providers] …')` never fires** —
so React never even renders the root `Providers` component. The loop is INSIDE React's
flight-model→element resolution / hydration, BEFORE any app component runs.

Ruled out for THIS loop:
- NOT useSyncExternalStore unstable snapshot — app components never render, and dev React
  emits NO "getSnapshot should be cached" / "Maximum update depth" warning (we capture
  console; only output is one benign dev-HMR `Unexpected token '.'`).
- NOT network — only JS chunks fetched, each once; no auth/API call.
- NOT a sync infinite loop — timers keep firing (a poll setTimeout ticks 30+ times), so
  the event loop progresses; React's scheduler just never finishes the render.
- NOT matchMedia/getComputedStyle — adding stable versions didn't help (and they're
  already provided by browser_env.js; do NOT override in ENV_BOOTSTRAP — it clobbers the
  shim's real getComputedStyle).

### Next ideas (in order of value)
1. **Find what React's scheduler keeps doing.** Sample the scheduler work callback
   (`performWorkUntilDeadline` via MessageChannel→timer). Likely a Suspense/`use()`
   thrash: a component throws a thenable during render that resolves immediately then
   re-throws (new promise each render) → React retries render forever, silently. Find
   which thenable. Candidate: React's `use(initialServerResponse)` in `ServerRoot`, or
   `createFromReadableStream`'s response chunk staying "pending"/"blocked" and re-waking.
2. **Hydration vs client-render.** Next wraps hydrate in `startTransition`. Check React's
   `shouldYield` in our env — if the transition never gets a "commit" window it spins.
   (OLD note: forcing `performance.now()` constant didn't help — revisit now that flight
   actually completes.)
3. **Robustness:** make `render_hydrate` return best-effort partial DOM on budget-exceed
   instead of erroring (idea kept from OLD handoff) — won't fix login (nothing commits)
   but is correct for non-converging SPAs generally.

## How to reproduce a probe (works today)

```js
const addon = require("rust/crates/turbo-crawl-napi/index.js");
const f = JSON.parse(await addon.fetchHtml(url));   // ⚠️ fetchHtml returns JSON {html,...}
const out = await addon.hydrate(f.html, url);        // pass f.html, NOT the JSON string
```

⚠️ **`fetchHtml` returns a JSON string** `{"html":...,"status":...}` (napi
`do_fetch_headers` → `json!{}.to_string()`). You MUST `JSON.parse(...).html` before
passing to `hydrate`. Passing the raw JSON string in makes every `"`→`\"` (JSON escaping)
and the inline `__next_f.push` flight scripts fail to eval ("Invalid or unexpected
token"). (The previous probe shape hit this; the real consumers parse it.)

- payroll dev `:3000` (`npm run dev`). `/login` is client-rendered; server HTML is a
  ~400KB shell with NO form.
- testIdAttribute is `data-test-id` (hyphen).
- Always cap probes at the Node level (Promise.race) and `pkill -f turbo-crawl` after.

**⚠️ prod test-env gotcha:** `next build --turbopack` + `next start` is BROKEN here —
`next start` throws `routesManifest.dataRoutes is not iterable`, and a stale `.next`
makes the served HTML reference a runtime chunk that 404s (`turbopack-_3fb52da9._.js`),
so TURBOPACK never installs and you get a false "empty render". For a valid prod probe:
`rm -rf .next && npm run build && npx next start -p 3100` AND verify the referenced
`turbopack-*.js` returns 200 first. The dev server is the reliable target.

## What IS working / shipped (don't redo)

- ✅ **nomodule skip** (this branch) — kills the core-js Promise loop. Test:
  `nomodule_scripts_are_skipped`.
- ✅ **ReadableStream park-on-empty** (this branch) — the reader now blocks on an
  empty-but-open stream instead of reporting EOF, so streaming producers (RSC flight)
  work. Test: `readable_stream_parks_for_async_producer`.
- Full browser-env runtime + hydration pump; all the globals/DOM APIs the OLD table
  lists (URL, MessageChannel, performance, TextEncoder, crypto+subtle, ReadableStream,
  AbortController, BroadcastChannel, WebSocket, shadow-DOM light fallback, element APIs).
- `@playwright/test` shim + `run_playwright` MCP tool. Local SPA hydration test passes.
- turbo-dom 0.3.4. browser_env @ `87aaaec`.

Branch: `rust-port`. Publish on hold.

---
---

# OLD handoff #1 (kept for the gap-closing history; its CONCLUSION was wrong)

The OLD doc's "most likely cause = useSyncExternalStore unstable snapshot / signals loop"
and "this SPA needs a real browser" were **incorrect** — see above, it was core-js. The
per-blocker gap table (URL → currentScript → hydration pump → MessageChannel → … →
crypto.subtle) is accurate history of real fixes and worth keeping:

| Blocker hit | Fix | Result |
|---|---|---|
| `URL`/`URLSearchParams` undefined | regex URL polyfill | ✅ |
| `document.currentScript` undefined | per-script currentScript in the pump | ✅ |
| chunks never execute | hydration pump (fetch+eval each injected `<script>`) | ✅ |
| `performance`, `MessageChannel`, `TextEncoder`/`crypto`/`btoa` | added to ENV_BOOTSTRAP | ✅ |
| `ReadableStream`, `AbortController` (broken deno stub) | queue-backed / overridden | ✅ |
| `attachShadow` (PropelAuth) | light-DOM fallback + `shadowRoot.host` | ✅ |
| React element-API crashes (`rel`, `removeAttributeNode`, `a.origin`…) | turbo-test browser_env | ✅ |
| `crypto.subtle`/`BroadcastChannel`/`WebSocket` | SHA-256 + same-isolate channel + stub | ✅ |
| **the "infinite loop"** | **core-js `nomodule` skip** (handoff #2) | ✅ **SOLVED** |
