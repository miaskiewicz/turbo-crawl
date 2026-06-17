# Façade gaps blocking a real Playwright e2e suite (post-render-fix)

> **RESOLVED (2026-06-17).** Gaps 1 + 2 implemented on the `/playwright` façade
> (fast backend), plus `route()` interception and `addInitScript`:
> - **Gap 1 — events/network**: `page.on/once/off` for `request`, `response`,
>   `requestfinished`, `requestfailed`, `console`, `pageerror`, `domcontentloaded`,
>   `load`, `close`; `waitForEvent`/`waitForResponse`/`waitForRequest`; full
>   `PWRequest`/`PWResponse`/`PWConsoleMessage` shapes. Page-initiated fetch/XHR
>   emit through render-tier hooks (`src/render/page-fetch.mjs`).
> - **Gap 2 — context state**: persistent cookie jar threaded into in-render
>   requests (Cookie sent + Set-Cookie ingested across `goto`); persistent per-origin
>   `localStorage`/`sessionStorage`; `context.storageState()` dump +
>   `newContext({ storageState })` seed; `addCookies`/`cookies`.
> - **Plus**: `route()`/`unroute()` (fulfill/abort/continue), `addInitScript`,
>   `setExtraHTTPHeaders`; a `batch(urls, { mode })` interface (no-js | fast |
>   secure) exposed on the barrel + MCP.
>
> **Follow-ups (not done):** event/storage/route/console parity on the **secure**
> (isolated-vm) backend — currently fast-backend only (cookie threading is
> backend-agnostic). Page-side `document.cookie` writes are not synced back to the
> jar (server `Set-Cookie` is). Full interactive PropelAuth login still needs a live
> seeded backend (infra, not façade).

Date: 2026-06-17
Engine: `@miaskiewicz/turbo-crawl@0.1.3`, `fast` backend, `/playwright` façade.
Context: Next.js 15 + React 19 + MUI + PropelAuth app, 33-spec `@playwright/test`
suite, all selectors `getByTestId`.

The render walls are **solved** (see `FINDINGS-nextjs-render-tier.md` +
`FINDINGS-rsc-hydration-wall.md`): real pages hydrate headless, and turbo-crawl
drives the `@playwright/test` runner end-to-end — the no-auth `smoke` spec passes
green with no browser. Full-suite run: **1 passed, 9 failed, 64 skipped (2.6 min)**.

The remaining failures are NOT rendering — they are two missing pieces of the
Playwright automation surface. Documented here for the façade backlog.

---

## Gap 1 — `page.on()` + `waitForResponse()` (event / network API)

### Symptom
```
TypeError: page.on is not a function
  at e2e/src/payroll-wizard/timeEntryAndApprovalStep.spec.ts:42
  > page.on('response', async (response) => { ... })
```

### Why it matters
Real e2e specs don't just read the DOM — they **assert on the network**. The two
dominant patterns in this suite:

```js
// 1. wait for a specific backend write to land before asserting UI
await Promise.all([
  page.waitForResponse(r => r.url().includes('/language-preferences') && r.request().method() === 'PUT'),
  englishOption.click(),
]);

// 2. capture a stream of responses to build expected state
page.on('response', async (response) => {
  if (isTimesheetListResponse(response)) { const body = await response.json(); ... }
});
```

The façade's `PWPage` exposes navigation + locators + actions, but **no event
emitter and no response waiting**. Specs that gate on a backend call (most
data-mutating ones) throw immediately on `page.on(...)` / `page.waitForResponse(...)`.

### What the façade needs
The render tier already routes page-initiated requests through the host net layer
(`makePageFetch` / `makeXHR` in `src/render/page-fetch.mjs`) — those calls are the
exact "responses" the specs want. Surface them as Playwright-shaped events:

1. **`page.on(event, cb)` / `page.off(...)`** — at minimum `'response'`,
   `'request'`, `'console'`, `'pageerror'`. Back it with a small EventEmitter on
   `PWPage`. (`'console'`/`'pageerror'` also unblock the suite's failure-capture
   fixture, which calls `page.on('console')` / `page.on('pageerror')`.)
2. **`page.waitForResponse(urlOrPredicate, {timeout})`** → Promise. Resolve when a
   host-net request matching the predicate completes; reject on timeout.
3. **A Playwright-shaped Response object** passed to those callbacks:
   `.url()`, `.status()`, `.ok()`, `.request().method()`, `.json()`, `.text()`,
   `.headers()`. (`makePageFetch` already builds a near-identical shape — adapt it
   to the Playwright method names.)
4. Optionally `page.waitForRequest(...)` and `page.route(...)` (currently `route()`
   throws) for request interception/mocking.

Implementation hook: emit a `'request'` event when `makePageFetch`/`makeXHR`
starts, and a `'response'` event (with the shaped Response) when it resolves —
inside the same `state.pending` bookkeeping the settle loop already tracks.

---

## Gap 2 — PropelAuth programmatic login + session (cookies / storage)

### Symptom
Auth-gated specs call a `login()` helper:
```js
const emailField = page.getByTestId('login-email-input').locator('input').first();
await emailField.waitFor({ state: 'visible', timeout: 30000 });
await emailField.fill(credentials.email);
// ... fill password, submit, then land authenticated on /entity/...
```
The login **form hydrates** (proven: `/login` → 3 test-ids, 11 interactive
elements, PropelAuth `refresh_token` resolved). But completing the login and
carrying the session into subsequent navigations needs browser state the façade
doesn't model.

### Why it matters
PropelAuth (like most auth) is **stateful across requests**:
- Submitting the form POSTs credentials → server sets an **auth cookie** /
  returns tokens stored in `localStorage`/`sessionStorage`.
- The SDK then reads that cookie/storage on the **next** page load to resolve
  `useAuthInfo()` to a logged-in user; otherwise `AuthRedirectProvider` shows the
  spinner / redirects to `/login`.

turbo-crawl renders each `goto` as a **fresh, stateless** render: no persistent
cookie jar shared into the page's `document.cookie`, no `localStorage`/
`sessionStorage` that survives between navigations. So even after a "successful"
form submit, the next `goto('/entity/...')` re-renders unauthenticated → back to
the login gate. Real Playwright persists this via the **BrowserContext**
(cookies + storage + `storageState`).

### What the façade needs
1. **A persistent `BrowserContext` state across pages**, holding:
   - a **cookie jar** wired to `document.cookie` (read+write) AND sent as the
     `Cookie` header on host-net requests. turbo-crawl already has cookie handling
     in `src/net.mjs` (`jar.setFromResponse` / `document.cookie` bridge) — the gap
     is **persisting one jar across `goto`s within a context**, not per-render.
   - persistent **`localStorage` / `sessionStorage`** on the sandbox `window`,
     surviving between `page.goto()` calls in the same context.
2. **`context.storageState()` / `browser.newContext({ storageState })`** —
   Playwright's standard auth-reuse mechanism. Lets a suite log in once in
   `global-setup` and inject the state into every spec (this suite is built to do
   exactly that). Even without driving the live form, accepting a `storageState`
   (cookies + origin storage) would unblock most auth-gated specs.
3. Make `newContext()` actually isolate + retain state (today
   `Browser.newContext()` returns a thin wrapper that builds fresh pages with no
   shared jar/storage).

### Lower-effort unblock
Supporting **`storageState` injection** alone (item 2) likely unblocks the bulk of
the suite: seed a logged-in cookie/token set once, hand it to each context, skip
driving the PropelAuth form entirely. Full interactive login (form fill → submit →
cookie set → persists) is the larger lift and needs gap 1's request/response plumbing
plus a live backend.

---

## Priority for a green suite
1. **Gap 1** (`page.on`/`waitForResponse` + Response shape) — broadest unblock;
   the data already flows through `makePageFetch`/`makeXHR`, just needs Playwright-
   shaped events. Also fixes the suite's `console`/`pageerror` capture fixture.
2. **Gap 2, `storageState` injection** — unblocks auth-gated specs without
   modelling full interactive login.
3. **Gap 2, full interactive login + cross-`goto` cookie/storage persistence** —
   largest lift; depends on gap 1 and a live seeded backend.

None of these are rendering problems. The engine renders the app; what's missing is
**Playwright automation-API breadth** (network events + persistent browser-context
state). Plus, orthogonally, the specs need a **live seeded flux-apis backend** for
their data — infra, not façade.

## Repro context
Full-suite run used an env-gated `page`-fixture swap (turbo-crawl page instead of
Chromium) + a minimal config pointing at a running frontend, no backend. Result:
`smoke` (no auth, no locators, no backend) passed; everything else hit gap 1, gap 2,
or the missing backend. Wiring was reverted after measuring — the consuming branch
is dep-bump-only.
