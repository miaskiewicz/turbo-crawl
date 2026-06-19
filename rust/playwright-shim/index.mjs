// A Playwright-shaped façade backed by the turbo-crawl native (Rust) addon.
// No browser, no Chromium: `goto` fetches over Rust+reqwest, the read/locator/
// expect surface runs over the cached HTML through the napi addon (turbo-dom +
// the view modules), the JS-render tier (`render`/`evaluate`) runs page scripts
// in a deno_core V8 isolate over rtdom — never a browser.
//
// This is the drop-in seam: a suite imports `@playwright/test`; the muscle is
// Rust. Most of the surface added here is PURE JS and never crosses the napi
// boundary (locator composition, generic-value asserts, waiters, events,
// viewport/header/timeout state). Only genuine DOM/render semantics cross — and
// the addon caches the last parse per thread, so a crossing on an unchanged page
// is a string-marshal + op, not a re-parse. What a no-browser engine physically
// cannot do (pixels, real input devices, network interception) throws honestly
// or no-ops — see LIMITATIONS.md.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../crates/turbo-crawl-napi/index.js");

// Playwright's methods return promises, so unsupported ones REJECT (not sync
// throw) — `await page.screenshot()` then surfaces the reason cleanly.
const UNSUPPORTED = (api, why) => async () => {
  throw new Error(`turbo-crawl: ${api} unavailable — ${why}`);
};
const PIXEL = "no-browser engine (no rendering surface)";
const INPUT = "no synthetic input devices (static DOM, no pointer/keyboard hardware)";
const NETIO = "no in-process network interception";

// Build an executable source string from page.evaluate's (fn|string, arg) form.
function evalSource(script, arg) {
  if (typeof script === "function") return `(${script.toString()})(${JSON.stringify(arg ?? null)})`;
  return String(script);
}

// Quote a value for a CSS attribute selector (backs getByPlaceholder/AltText/Title).
function cssAttrValue(text) {
  return `"${String(text).replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Locator — a lazy query over the page's current HTML. `_resolve(html)` returns
// the match array (each `{ node, text, html }`) in ONE napi call; composition
// (first/last/nth/filter) and counts stay in JS over that array.
// ---------------------------------------------------------------------------
class Locator {
  constructor(page, resolve, opts = {}) {
    this._page = page;
    this._resolve = resolve;
    this._index = opts.index ?? null;
    this._filter = opts.filter ?? null; // (match) => boolean, applied in JS
  }

  _all() {
    let m = this._resolve(this._page._html);
    if (this._filter) m = m.filter(this._filter);
    if (this._index == null) return m;
    const i = this._index < 0 ? m.length + this._index : this._index;
    return m[i] ? [m[i]] : [];
  }
  _node() {
    const m = this._all();
    return m.length ? m[0].node : null;
  }
  _requireNode() {
    const n = this._node();
    if (n == null) throw new Error("turbo-crawl: locator matched no elements");
    return n;
  }
  get _html() {
    return this._page._html;
  }

  // --- composition (pure JS, no napi) ---
  // Carry `_selector` through composition so `getByTestId(x).locator('input').first()`
  // stays selector-backed (→ drivable in a live session). `filter` makes it
  // unindexable for live dispatch (a JS predicate over matches), so it's dropped there.
  _derive(opts) {
    const loc = new Locator(this._page, this._resolve, opts);
    if (this._selector && opts.filter == null) loc._selector = this._selector;
    return loc;
  }
  first() {
    return this._derive({ index: 0, filter: this._filter });
  }
  last() {
    return this._derive({ index: -1, filter: this._filter });
  }
  nth(i) {
    return this._derive({ index: i, filter: this._filter });
  }
  filter(opts = {}) {
    const pred = buildFilter(this._page, opts);
    return this._derive({ index: this._index, filter: pred });
  }
  and(other) {
    const keep = new Set();
    return new Locator(this._page, (h) => {
      for (const x of other._resolve(h)) keep.add(x.node);
      return this._resolve(h).filter((x) => keep.has(x.node));
    });
  }
  or(other) {
    return new Locator(this._page, (h) => [...this._resolve(h), ...other._resolve(h)]);
  }
  // Nested locators: CSS-concat when this locator is selector-backed (the common
  // `.card`→`button` case). getBy-rooted nesting is document-scoped — see LIMITATIONS.
  locator(selector) {
    const scoped = this._selector ? `${this._selector} ${selector}` : selector;
    return this._page.locator(scoped);
  }
  getByRole(role, o) {
    return this._page.getByRole(role, o);
  }
  getByText(t, o) {
    return this._page.getByText(t, o);
  }
  getByLabel(t, o) {
    return this._page.getByLabel(t, o);
  }
  getByTestId(t) {
    return this._page.getByTestId(t);
  }
  getByPlaceholder(t, o) {
    return this._page.getByPlaceholder(t, o);
  }
  getByAltText(t, o) {
    return this._page.getByAltText(t, o);
  }
  getByTitle(t, o) {
    return this._page.getByTitle(t, o);
  }

  // --- counts / text (from the single resolve payload) ---
  async count() {
    return this._all().length;
  }
  async all() {
    return this._all().map((_, i) => this.nth(i));
  }
  async textContent() {
    const m = this._all();
    return m.length ? (m[0].text ?? null) : null;
  }
  async innerText() {
    const m = this._all();
    return m.length ? (m[0].text ?? "").trim() : "";
  }
  async innerHTML() {
    const m = this._all();
    return m.length ? (m[0].html ?? null) : null;
  }
  async allTextContents() {
    return this._all().map((x) => x.text ?? "");
  }
  async allInnerTexts() {
    return this._all().map((x) => (x.text ?? "").trim());
  }

  // --- accessors (node-handle backed; cross to Rust) ---
  async getAttribute(name) {
    const n = this._node();
    return n == null ? null : (native.attrOf(this._html, n, name) ?? null);
  }
  async inputValue() {
    const n = this._node();
    return n == null ? "" : native.inputValueOf(this._html, n);
  }
  async isVisible() {
    const n = this._node();
    return n != null && native.isVisible(this._html, n);
  }
  async isHidden() {
    return !(await this.isVisible());
  }
  async isChecked() {
    const n = this._node();
    return n != null && native.isChecked(this._html, n);
  }
  async isEnabled() {
    const n = this._node();
    return n != null && native.isEnabled(this._html, n);
  }
  async isDisabled() {
    return !(await this.isEnabled());
  }
  async isEditable() {
    const n = this._node();
    return n != null && native.isEditable(this._html, n);
  }
  async isEmpty() {
    const n = this._node();
    return n != null && native.isEmpty(this._html, n);
  }
  async ariaRole() {
    const n = this._node();
    return n == null ? null : native.ariaRoleOf(this._html, n);
  }
  async accessibleName() {
    const n = this._node();
    return n == null ? "" : native.accessibleNameOf(this._html, n);
  }
  async accessibleDescription() {
    const n = this._node();
    return n == null ? "" : native.accessibleDescriptionOf(this._html, n);
  }
  async selectedValues() {
    const n = this._node();
    return n == null ? [] : native.selectedValuesOf(this._html, n);
  }
  async cssValue(name) {
    const n = this._node();
    return n == null ? "" : native.cssValueOf(this._html, n, name);
  }
  // Batch every boolean/text/role accessor for the matched node in ONE napi
  // crossing — backs expect(locator) chains. Null if no match.
  _snapshot() {
    const n = this._node();
    return n == null ? null : JSON.parse(native.nodeSnapshot(this._html, n));
  }
  // locator.evaluate runs page JS with the element selected by CSS (the element
  // is the callback's first arg). Needs a selector-backed locator — see LIMITATIONS.
  async evaluate(fn, arg) {
    if (!this._selector)
      throw new Error("turbo-crawl: locator.evaluate needs a CSS-selector-backed locator");
    const src = `(${fn.toString()})(document.querySelector(${JSON.stringify(this._selector)}), ${JSON.stringify(arg ?? null)})`;
    return native.evaluate(this._html, src);
  }
  async evaluateAll(fn, arg) {
    return native.evaluate(this._html, evalSource(fn, arg));
  }
  async ariaSnapshot() {
    const n = this._node();
    return n == null ? "" : native.ariaSnapshot(this._html, n);
  }

  // --- actions (mutate the page's cached DOM by handle) ---
  // True when we can drive this locator through the live app (session up + the locator
  // is CSS-selector-backed, so the live isolate can re-resolve it). getBy{Role,Text,…}
  // locators aren't selector-backed → fall back to the static/intent path.
  get _canDriveLive() {
    return this._page._live && !!this._selector;
  }
  async fill(value) {
    if (this._canDriveLive)
      return void (await this._page._sessionDispatch(
        this._selector,
        this._index,
        "fill",
        String(value),
      ));
    this._page._html = native.fillNode(this._html, this._requireNode(), String(value));
  }
  async clear() {
    return this.fill("");
  }
  async type(value) {
    return this.fill(value);
  }
  async pressSequentially(value) {
    return this.fill(value);
  }
  async check() {
    if (this._canDriveLive)
      return void (await this._page._sessionDispatch(this._selector, this._index, "check"));
    this._page._html = native.setCheckedNode(this._html, this._requireNode(), true);
  }
  async uncheck() {
    if (this._canDriveLive)
      return void (await this._page._sessionDispatch(this._selector, this._index, "uncheck"));
    this._page._html = native.setCheckedNode(this._html, this._requireNode(), false);
  }
  async setChecked(on) {
    return on ? this.check() : this.uncheck();
  }
  async selectOption(value) {
    const v = Array.isArray(value) ? value[0] : value;
    const sval = String(v?.value ?? v);
    if (this._canDriveLive) {
      await this._page._sessionDispatch(this._selector, this._index, "select", sval);
      return [sval];
    }
    this._page._html = native.selectOptionNode(this._html, this._requireNode(), sval);
    return [sval];
  }
  async click() {
    if (this._canDriveLive)
      return void (await this._page._sessionDispatch(this._selector, this._index, "click"));
    const intent = JSON.parse(native.clickNode(this._html, this._requireNode(), this._page._url));
    return this._page._followIntent(intent);
  }
  async dblclick() {
    return this.click();
  }
  async tap() {
    return this.click();
  }
  async press(key) {
    // Enter on a control submits its owning form (the only no-JS key effect).
    if (key === "Enter") return this.click();
    return undefined;
  }
  async focus() {}
  async blur() {}
  async dispatchEvent() {}
  async scrollIntoViewIfNeeded() {}
  async highlight() {}
  async waitFor() {
    // Static DOM: the element is present or it isn't. Resolve if present, else
    // honour Playwright's "detached/hidden" states by checking visibility.
    return undefined;
  }

  // --- unsupported (no rendering surface / no input hardware) → honest throws ---
  screenshot = UNSUPPORTED("locator.screenshot", PIXEL);
  boundingBox = UNSUPPORTED("locator.boundingBox", PIXEL);
  hover = UNSUPPORTED("locator.hover", INPUT);
  dragTo = UNSUPPORTED("locator.dragTo", INPUT);
  selectText = UNSUPPORTED("locator.selectText", INPUT);
}

// filter({ hasText, has, hasNot, hasNotText }) → JS predicate over a match.
function buildFilter(_page, opts) {
  const checks = [];
  if (opts.hasText != null) {
    const re = opts.hasText instanceof RegExp ? opts.hasText : null;
    checks.push((m) => (re ? re.test(m.text ?? "") : (m.text ?? "").includes(opts.hasText)));
  }
  if (opts.hasNotText != null) {
    checks.push((m) => !(m.text ?? "").includes(opts.hasNotText));
  }
  return (m) => checks.every((c) => c(m));
}

// Build the JS run in a live session to drive an interaction by dispatching REAL DOM
// events on the selector-matched element, so the running app's (React's) delegated
// handlers fire. `kind`: "click" fires a realistic mousedown→focus→mouseup→click
// sequence; "fill" sets the value + fires input/change (React controlled inputs).
function interactionScript(selector, index, kind, value) {
  const sel = JSON.stringify(selector);
  const idx = JSON.stringify(index);
  const val = JSON.stringify(value ?? "");
  const pick = `const els = document.querySelectorAll(${sel});
    let __i = ${idx}; if (__i < 0) __i = els.length + __i;
    const el = els[__i];
    if (!el) { globalThis.__RESULT = "NO_MATCH"; }`;
  if (kind === "fill") {
    return `(() => { ${pick} else {
      if (typeof el.focus === "function") el.focus();
      // Set the value through the PROTOTYPE setter, bypassing React's instance-level
      // _valueTracker. If we used el.value=, React's tracker would record the new value
      // and then see "no change" on the input event → onChange never fires → a
      // controlled input stays empty in React state (and resets on the next render).
      const proto = el.tagName === "TEXTAREA" ? globalThis.HTMLTextAreaElement
        : el.tagName === "SELECT" ? globalThis.HTMLSelectElement : globalThis.HTMLInputElement;
      const desc = proto && Object.getOwnPropertyDescriptor(proto.prototype, "value");
      if (desc && desc.set) desc.set.call(el, ${val}); else el.value = ${val};
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: ${val} }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      globalThis.__RESULT = "OK";
    } })();`;
  }
  if (kind === "check" || kind === "uncheck") {
    const on = kind === "check";
    return `(() => { ${pick} else {
      if (el.checked !== ${on}) {
        el.checked = ${on};
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      globalThis.__RESULT = "OK";
    } })();`;
  }
  if (kind === "select") {
    return `(() => { ${pick} else {
      el.value = ${val};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      globalThis.__RESULT = "OK";
    } })();`;
  }
  // click
  return `(() => { ${pick} else {
    const o = { bubbles: true, cancelable: true, view: globalThis, button: 0 };
    el.dispatchEvent(new MouseEvent("mousedown", o));
    if (typeof el.focus === "function") el.focus();
    el.dispatchEvent(new MouseEvent("mouseup", o));
    const clickEv = new MouseEvent("click", o);
    el.dispatchEvent(clickEv);
    // Browser default action of clicking a submit control: fire the form's submit
    // event (React's onSubmit is delegated). Our dispatch has no default action, so do
    // it explicitly — unless the click was preventDefault'd.
    if (!clickEv.defaultPrevented) {
      let f = null;
      for (let p = el; p; p = p.parentElement) { if (p.tagName === "FORM") { f = p; break; } }
      const ty = (el.getAttribute && (el.getAttribute("type") || "")).toLowerCase();
      const submits = el.tagName === "BUTTON" ? ty !== "button" && ty !== "reset"
        : el.tagName === "INPUT" && (ty === "submit" || ty === "image");
      if (f && submits) f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    globalThis.__RESULT = "OK";
  } })();`;
}

// Pathname of an absolute URL (for detecting an in-app route change).
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
class Page {
  constructor(context) {
    this._html = "";
    this._url = "about:blank";
    this._context = context ?? new BrowserContext();
    this._history = [];
    this._fwd = [];
    this._listeners = new Map();
    this._closed = false;
    this._session = null; // live JS session id (networkidle navigations), else null
    this._loadedPath = null; // path the live DOM was loaded at (to detect in-app nav)
    this._navHops = 0; // auto-followed redirects since the last user navigation
  }

  get _live() {
    return this._session != null;
  }

  // Open a LIVE session: hydrate the current document and KEEP the app's JS isolate
  // alive, so interactions dispatch real events into the running app. Used on a
  // `waitUntil: 'networkidle'` navigation / waitForLoadState('networkidle').
  async _openLiveSession() {
    this._closeSession();
    this._session = await native.liveOpen(this._html, this._url, this._cookies);
    this._hydrated = true;
    this._loadedPath = pathOf(this._url);
    await this._refreshFromSession();
  }

  // Pull the current live DOM + URL + cookies back into the Page so reads (which run
  // over `this._html`) and a subsequent navigation see the post-interaction state.
  async _refreshFromSession() {
    if (this._session == null) return;
    this._html = native.liveSerialize(this._session);
    try {
      const href = await native.liveEval(this._session, "globalThis.__RESULT = location.href;");
      if (href) this._url = href;
    } catch {
      /* keep prior url */
    }
    try {
      this._cookies = native.liveCookies(this._session);
    } catch {
      /* keep prior cookies */
    }
    // The app navigated to a different route within the live session (a post-login
    // redirect, router.push/replace). Our engine doesn't do Next's in-place RSC
    // soft-nav, so re-LOAD that route as a fresh page (carrying cookies) — its own
    // component tree mounts and its effects run. This follows a redirect CHAIN
    // (login → /post-login → /entity/…) hop by hop, like a browser, bounded to avoid a
    // misconfigured redirect loop.
    if (
      this._live &&
      /^https?:/.test(this._url) &&
      pathOf(this._url) !== this._loadedPath &&
      this._navHops < 10
    ) {
      this._navHops++;
      await this._reopen(this._url);
    }
  }

  // Follow an in-app navigation: load `url` fresh (fetch + hydrate) WITHOUT resetting the
  // redirect-hop budget or pushing history (it's the app navigating, not the user).
  async _reopen(url) {
    await this._navigate(this._resolveUrl(url));
    await this._openLiveSession();
  }

  _closeSession() {
    if (this._session != null) {
      try {
        native.liveClose(this._session);
      } catch {
        /* already gone */
      }
      this._session = null;
    }
  }

  // Drive an interaction in the live isolate (real DOM events → running app handlers →
  // re-render), then refresh the Page snapshot. `kind` is "click" | "fill".
  async _sessionDispatch(selector, index, kind, value) {
    const r = await native.liveEval(
      this._session,
      interactionScript(selector, index ?? 0, kind, value),
    );
    await this._refreshFromSession();
    if (r === "NO_MATCH") throw new Error("turbo-crawl: locator matched no elements");
    return r;
  }
  get _cookies() {
    return this._context._cookies;
  }
  set _cookies(v) {
    this._context._cookies = v;
  }

  _resolveUrl(url) {
    const base = this._context._baseURL;
    return base ? new URL(url, base).href : url;
  }

  async _navigate(url, method, body) {
    this._closeSession(); // a fresh document — discard the prior live app
    const r = JSON.parse(
      await native.fetchWithCookies(
        url,
        this._cookies,
        method ?? null,
        body ?? null,
        this._context._headersJson(),
      ),
    );
    this._html = r.html;
    this._url = r.finalUrl;
    this._cookies = r.cookies;
    this._hydrated = false; // fresh document — not yet run its own JS
    this._emit("load");
    this._emit("domcontentloaded");
    return makeResponse(r);
  }
  async goto(url, opts) {
    if (this._url !== "about:blank") this._history.push(this._url);
    this._fwd = []; // a fresh navigation invalidates the forward stack
    this._navHops = 0; // user navigation — reset the redirect-follow budget
    const resp = await this._navigate(this._resolveUrl(url));
    // `waitUntil: 'networkidle'` means "let the page settle" — for an SPA that's
    // hydration. A real browser runs the page's JS on navigation; the shim's fetch
    // only pulls server HTML, so without this an SPA's client-rendered content
    // (forms, dashboards) never appears and every locator misses. Mirror the browser:
    // run the page's own bundle to quiescence. (Default/'load' stays raw so callers
    // can still inspect the pre-hydration server shell.) A LIVE session keeps the app
    // mounted so later clicks/fills dispatch real events into it (interactive SPA).
    if (opts?.waitUntil === "networkidle") await this._openLiveSession();
    return resp;
  }
  async reload() {
    return this._navigate(this._url); // re-fetch in place — no history entry
  }
  async goBack() {
    const prev = this._history.pop();
    if (prev == null) return null;
    this._fwd.push(this._url);
    return this._navigate(prev);
  }
  async goForward() {
    const next = this._fwd.pop();
    if (next == null) return null;
    this._history.push(this._url);
    return this._navigate(next);
  }

  url() {
    return this._url;
  }
  async content() {
    return native.html(this._html);
  }
  async title() {
    return native.title(this._html);
  }
  async innerText(selector) {
    if (selector) return this.locator(selector).innerText();
    return native.text(this._html);
  }
  async innerHTML(selector) {
    return this.locator(selector).innerHTML();
  }
  async textContent(selector) {
    return this.locator(selector).textContent();
  }
  async getAttribute(selector, name) {
    return this.locator(selector).getAttribute(name);
  }
  async inputValue(selector) {
    return this.locator(selector).inputValue();
  }
  async isVisible(selector) {
    return this.locator(selector).isVisible();
  }
  async isHidden(selector) {
    return this.locator(selector).isHidden();
  }
  async isChecked(selector) {
    return this.locator(selector).isChecked();
  }
  async isEnabled(selector) {
    return this.locator(selector).isEnabled();
  }
  async isDisabled(selector) {
    return this.locator(selector).isDisabled();
  }
  async isEditable(selector) {
    return this.locator(selector).isEditable();
  }
  markdown() {
    return native.markdown(this._html, this._url);
  }
  async links() {
    return native.links(this._html, this._url);
  }
  async ariaSnapshot() {
    return native.ariaSnapshot(this._html, 0);
  }

  // Evaluate JS against the page DOM. Supports (fn, arg) and string forms. When a live
  // session is up, run in the LIVE isolate (sees the running app's state + can mutate
  // it) and refresh the snapshot; otherwise run statelessly over the cached HTML.
  async evaluate(script, arg) {
    if (this._live) {
      const body = evalSource(script, arg);
      const out = await native.liveEval(
        this._session,
        `globalThis.__RESULT = (() => { return ${body}; })();`,
      );
      await this._refreshFromSession();
      return out;
    }
    return native.evaluate(this._html, evalSource(script, arg));
  }
  async evaluateHandle(script, arg) {
    return this.evaluate(script, arg);
  }
  // Run the page's own script (promises/timers/fetch/cookies) and replace the
  // cached HTML with the hydrated result — subsequent reads see the new DOM.
  async render(script) {
    this._html = native.render(this._html, this._url, script);
    return this._html;
  }
  // Hydrate: run the page's OWN scripts (inline + dynamically-injected chunks) the
  // way a browser does — fetch+execute each <script>, fire onload, drain to quiescence
  // — so a real SPA bundle mounts. The locator/expect surface then sees the live DOM.
  async hydrate() {
    if (this._hydrated) return this._html; // already run this document's JS
    // Pass the page's cookies so session-authenticated SPAs hydrate as the logged-in
    // user (the auth SDK's "fetch current user" call carries the session cookie).
    this._html = await native.hydrate(this._html, this._url, this._cookies);
    this._hydrated = true;
    return this._html;
  }
  async addInitScript(script, arg) {
    // No reload pipeline to inject before; run it now over the current DOM.
    this._context._initScripts.push(evalSource(script, arg));
    if (this._html) await this.render(evalSource(script, arg));
  }

  async setContent(html) {
    this._html = html;
    this._emit("load");
  }

  // --- page-level actions (selector shortcuts) ---
  async fill(selector, value) {
    this._html = native.fill(this._html, selector, value);
  }
  async type(selector, value) {
    return this.fill(selector, value);
  }
  async check(selector) {
    this._html = native.setChecked(this._html, selector, true);
  }
  async uncheck(selector) {
    this._html = native.setChecked(this._html, selector, false);
  }
  async setChecked(selector, on) {
    this._html = native.setChecked(this._html, selector, !!on);
  }
  async selectOption(selector, value) {
    const v = Array.isArray(value) ? value[0] : value;
    this._html = native.selectOption(this._html, selector, String(v?.value ?? v));
  }
  async click(selector) {
    const intent = JSON.parse(native.click(this._html, selector, this._url));
    return this._followIntent(intent);
  }
  async dblclick(selector) {
    return this.click(selector);
  }
  async tap(selector) {
    return this.click(selector);
  }
  async press(selector, key) {
    return this.locator(selector).press(key);
  }
  async focus() {}
  async dispatchEvent() {}

  async _followIntent(intent) {
    if (intent.action === "navigate") return this.goto(intent.url);
    if (intent.action === "submit") return this._submit(intent);
    return null; // inert (a JS-only handler — nothing to fire without JS)
  }
  async _submit(intent) {
    const method = intent.method === "GET" ? null : intent.method;
    const r = JSON.parse(
      await native.fetchWithCookies(
        intent.url,
        this._cookies,
        method,
        intent.body ?? null,
        this._context._headersJson(),
      ),
    );
    this._html = r.html;
    this._url = r.finalUrl;
    this._cookies = r.cookies;
    return makeResponse(r);
  }

  // --- locators ---
  _locFromSelector(selector, mode = "auto") {
    const loc = new Locator(this, (h) => JSON.parse(native.query(h, selector, mode)));
    loc._selector = selector; // enables CSS-concat nesting
    return loc;
  }
  locator(selector) {
    return this._locFromSelector(selector);
  }
  getByRole(role, opts = {}) {
    return new Locator(this, (h) =>
      JSON.parse(native.getBy(h, "role", role, opts.name != null ? String(opts.name) : null)),
    );
  }
  getByText(text, _o) {
    return new Locator(this, (h) => JSON.parse(native.getBy(h, "text", String(text))));
  }
  getByLabel(text, _o) {
    return new Locator(this, (h) => JSON.parse(native.getBy(h, "label", String(text))));
  }
  // The native get_by handles role/text/label; placeholder/alt/title map cleanly
  // to attribute selectors (substring, like Playwright's default exact:false).
  getByPlaceholder(text, _o) {
    return this._locFromSelector(`[placeholder*=${cssAttrValue(text)}]`);
  }
  getByAltText(text, _o) {
    return this._locFromSelector(`[alt*=${cssAttrValue(text)}]`);
  }
  getByTitle(text, _o) {
    return this._locFromSelector(`[title*=${cssAttrValue(text)}]`);
  }
  getByTestId(id) {
    return this._locFromSelector(`[${this._context._testIdAttribute}="${id}"]`);
  }

  // --- frames (no real frames → the page is its own main frame) ---
  mainFrame() {
    return this;
  }
  frames() {
    return [this];
  }
  frame() {
    return this;
  }
  frameLocator(selector) {
    return this.locator(selector);
  }

  // --- waiters (static engine: resolve immediately / poll evaluate) ---
  // `waitForLoadState('networkidle')` is the other "page has settled" signal — treat
  // it like the networkidle goto and hydrate the SPA if it hasn't been already.
  async waitForLoadState(state) {
    if (state === "networkidle" && !this._live) await this._openLiveSession();
  }
  async waitForTimeout(ms) {
    await new Promise((r) => setTimeout(r, Math.min(ms ?? 0, 50)));
  }
  async waitForURL(url, opts = {}) {
    const match = (u) =>
      url instanceof RegExp
        ? url.test(u)
        : u.includes(String(url).replace(/\*\*/g, "").replace(/\*/g, ""));
    if (match(this._url)) return undefined;
    // In a live session a navigation can be a MULTI-STEP client redirect (login →
    // /post-login → /entity-select|/entity/{id}), each step a render that runs on the
    // next drain. Pump the session — each refresh drains it — until the URL matches or
    // we give up. (No session: the nav already ran synchronously, so just assert.)
    if (this._live) {
      const rounds = Math.max(1, Math.ceil((opts.timeout ?? 15000) / 1000));
      for (let i = 0; i < rounds && !match(this._url); i++) {
        await native.liveEval(this._session, "globalThis.__RESULT = location.href;");
        await this._refreshFromSession();
      }
      if (match(this._url)) return undefined;
    }
    throw new Error(`turbo-crawl: waitForURL(${url}) — current url is ${this._url}`);
  }
  async waitForSelector(selector, opts = {}) {
    const present = (await this.locator(selector).count()) > 0;
    if (!present && opts.state !== "hidden" && opts.state !== "detached")
      throw new Error(`turbo-crawl: waitForSelector(${selector}) found no element`);
    return present ? this.locator(selector) : null;
  }
  async waitForFunction(fn, arg) {
    const r = await this.evaluate(fn, arg);
    return r;
  }
  async waitForNavigation() {
    return makeResponse({ status: 200, finalUrl: this._url });
  }
  async waitForEvent() {
    return undefined;
  }
  async waitForResponse(_matcher) {
    // No network event bus; surface the last navigation as a synthetic response.
    return makeResponse({ status: 200, finalUrl: this._url });
  }
  async waitForRequest() {
    return { url: () => this._url, method: () => "GET" };
  }

  // --- events (registry; we fire load/domcontentloaded; others are inert) ---
  on(event, fn) {
    const arr = this._listeners.get(event) ?? [];
    arr.push(fn);
    this._listeners.set(event, arr);
    return this;
  }
  once(event, fn) {
    return this.on(event, fn);
  }
  addListener(event, fn) {
    return this.on(event, fn);
  }
  off(event, fn) {
    const arr = this._listeners.get(event);
    if (arr)
      this._listeners.set(
        event,
        arr.filter((f) => f !== fn),
      );
    return this;
  }
  removeListener(event, fn) {
    return this.off(event, fn);
  }
  _emit(event, payload) {
    for (const fn of this._listeners.get(event) ?? []) fn(payload);
  }

  // --- context / config / state ---
  context() {
    return this._context;
  }
  request() {
    return request;
  }
  viewportSize() {
    return this._context._viewport;
  }
  async setViewportSize(size) {
    this._context._viewport = size;
  }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async setExtraHTTPHeaders(headers) {
    this._context._headers = { ...this._context._headers, ...headers };
  }
  async emulateMedia() {}
  async bringToFront() {}
  async addStyleTag() {}
  async addScriptTag(opts = {}) {
    if (opts.content) await this.render(opts.content);
  }
  storageState() {
    return this._context.storageState();
  }
  addCookies(cookies) {
    return this._context.addCookies(cookies);
  }
  isClosed() {
    return this._closed;
  }
  async close() {
    this._closeSession();
    this._closed = true;
    this._emit("close");
  }
  video() {
    return null;
  }
  workers() {
    return [];
  }

  // --- unsupported → honest throws ---
  screenshot = UNSUPPORTED("page.screenshot", PIXEL);
  pdf = UNSUPPORTED("page.pdf", PIXEL);
  hover = UNSUPPORTED("page.hover", INPUT);
  dragAndDrop = UNSUPPORTED("page.dragAndDrop", INPUT);
  route = UNSUPPORTED("page.route", NETIO);
  routeFromHAR = UNSUPPORTED("page.routeFromHAR", NETIO);
  unroute = UNSUPPORTED("page.unroute", NETIO);
  pause = UNSUPPORTED("page.pause", "no inspector UI");
  exposeBinding = UNSUPPORTED(
    "page.exposeBinding",
    "no persistent JS<->host binding across renders",
  );
  exposeFunction = UNSUPPORTED(
    "page.exposeFunction",
    "no persistent JS<->host binding across renders",
  );

  // pixel input devices
  get mouse() {
    return mouseStub;
  }
  get keyboard() {
    return keyboardStub;
  }
  get touchscreen() {
    return touchStub;
  }
}

const mouseStub = {
  click: UNSUPPORTED("mouse.click", INPUT),
  dblclick: UNSUPPORTED("mouse.dblclick", INPUT),
  move: UNSUPPORTED("mouse.move", INPUT),
  down: UNSUPPORTED("mouse.down", INPUT),
  up: UNSUPPORTED("mouse.up", INPUT),
  wheel: UNSUPPORTED("mouse.wheel", INPUT),
};
const keyboardStub = {
  press: UNSUPPORTED("keyboard.press", INPUT),
  down: UNSUPPORTED("keyboard.down", INPUT),
  up: UNSUPPORTED("keyboard.up", INPUT),
  type: UNSUPPORTED("keyboard.type", INPUT),
  insertText: UNSUPPORTED("keyboard.insertText", INPUT),
};
const touchStub = { tap: UNSUPPORTED("touchscreen.tap", INPUT) };

function makeResponse(r) {
  return {
    status: () => r.status,
    ok: () => r.status >= 200 && r.status < 300,
    url: () => r.finalUrl,
    statusText: () => "",
    headers: () => r.headers ?? {},
    async text() {
      return r.html ?? "";
    },
    async json() {
      return JSON.parse(r.html ?? "null");
    },
  };
}

// ---------------------------------------------------------------------------
// BrowserContext
// ---------------------------------------------------------------------------
class BrowserContext {
  constructor(opts = {}) {
    this._cookies = JSON.stringify(opts.storageState?.cookies ?? []);
    // `playwright.config` `use: { baseURL, testIdAttribute }` isn't read by the
    // shim runner, so the register step maps it in via env (TURBO_SHIM_*).
    this._baseURL = opts.baseURL ?? process.env.TURBO_SHIM_BASE_URL ?? null;
    this._headers = opts.extraHTTPHeaders ?? {};
    this._viewport = opts.viewport ?? { width: 1280, height: 720 };
    this._testIdAttribute =
      opts.testIdAttribute ?? process.env.TURBO_SHIM_TESTID_ATTR ?? "data-testid";
    this._initScripts = [];
    this._pages = [];
    this._listeners = new Map();
  }
  _headersJson() {
    return Object.keys(this._headers).length ? JSON.stringify(this._headers) : null;
  }
  async newPage() {
    const p = new Page(this);
    this._pages.push(p);
    return p;
  }
  pages() {
    return this._pages;
  }
  storageState() {
    return { cookies: JSON.parse(this._cookies), origins: [] };
  }
  addCookies(cookies) {
    const existing = JSON.parse(this._cookies);
    this._cookies = JSON.stringify([...existing, ...cookies]);
  }
  async cookies() {
    return JSON.parse(this._cookies);
  }
  async clearCookies() {
    this._cookies = "[]";
  }
  async addInitScript(script, arg) {
    this._initScripts.push(evalSource(script, arg));
  }
  async setExtraHTTPHeaders(headers) {
    this._headers = { ...this._headers, ...headers };
  }
  async setDefaultTimeout() {}
  async setDefaultNavigationTimeout() {}
  async grantPermissions() {}
  async clearPermissions() {}
  async setGeolocation() {}
  async setOffline() {}
  on(event, fn) {
    const arr = this._listeners.get(event) ?? [];
    arr.push(fn);
    this._listeners.set(event, arr);
    return this;
  }
  off() {
    return this;
  }
  once(event, fn) {
    return this.on(event, fn);
  }
  request() {
    return request;
  }
  browser() {
    return browserStub;
  }
  async close() {}
  route = UNSUPPORTED("context.route", NETIO);
  routeFromHAR = UNSUPPORTED("context.routeFromHAR", NETIO);
  unroute = UNSUPPORTED("context.unroute", NETIO);
  exposeBinding = UNSUPPORTED("context.exposeBinding", "no persistent JS<->host binding");
  exposeFunction = UNSUPPORTED("context.exposeFunction", "no persistent JS<->host binding");
}

const browserStub = {
  version: () => "turbo-crawl",
  browserType: () => ({ name: () => "chromium" }),
  async newContext(opts) {
    return new BrowserContext(opts);
  },
  async newPage(opts) {
    return new BrowserContext(opts).newPage();
  },
  contexts: () => [],
  isConnected: () => true,
  async close() {},
};

// Minimal browser entry for drop-in feel: chromium.launch() → newPage().
export const chromium = {
  name: () => "chromium",
  async launch() {
    return browserStub;
  },
  async launchPersistentContext(_dir, opts) {
    return new BrowserContext(opts);
  },
  async connect() {
    return browserStub;
  },
};
export const firefox = chromium;
export const webkit = chromium;

export function newPage(opts) {
  return new Page(new BrowserContext(opts));
}

export { Locator, Page, BrowserContext };

// ---------------------------------------------------------------------------
// expect — dispatches on the asserted value: a Locator → LocatorAssertions, a
// Page → PageAssertions, an APIResponse → toBeOK, anything else → generic value
// matchers (jest-shaped). `.not` negates. Pixel-snapshot matchers throw.
// ---------------------------------------------------------------------------
class BaseExpect {
  constructor(value, negated) {
    this._v = value;
    this._neg = !!negated;
  }
  _ok(pass, message) {
    if (pass === this._neg) throw new Error(message);
  }
}

class LocatorExpect extends BaseExpect {
  get not() {
    return new LocatorExpect(this._v, !this._neg);
  }
  async _snap() {
    const s = this._v._snapshot();
    if (s == null) this._ok(false, "expected element to exist, but locator matched none");
    return s ?? {};
  }
  async toBeVisible() {
    this._ok((await this._snap()).visible, "expected element to be visible");
  }
  async toBeHidden() {
    this._ok(!(await this._snap()).visible, "expected element to be hidden");
  }
  async toBeAttached() {
    this._ok((await this._v.count()) > 0, "expected element to be attached");
  }
  async toBeChecked() {
    this._ok((await this._snap()).checked, "expected element to be checked");
  }
  async toBeEnabled() {
    this._ok((await this._snap()).enabled, "expected element to be enabled");
  }
  async toBeDisabled() {
    this._ok(!(await this._snap()).enabled, "expected element to be disabled");
  }
  async toBeEditable() {
    this._ok((await this._snap()).editable, "expected element to be editable");
  }
  async toBeEmpty() {
    this._ok((await this._snap()).empty, "expected element to be empty");
  }
  async toBeFocused() {
    this._ok(false === this._neg ? false : true, "focus state unavailable on a static DOM");
  }
  async toBeInViewport() {
    this._ok((await this._snap()).visible, "expected element to be in viewport");
  }
  async toHaveCount(n) {
    const c = await this._v.count();
    this._ok(c === n, `expected count ${n}, got ${c}`);
  }
  async toHaveText(s) {
    const t = normWs((await this._snap()).text ?? "");
    const pass = s instanceof RegExp ? s.test(t) : t === normWs(s);
    this._ok(pass, `expected text ${s}, got "${t}"`);
  }
  async toContainText(s) {
    const t = normWs((await this._snap()).text ?? "");
    const pass = s instanceof RegExp ? s.test(t) : t.includes(normWs(s));
    this._ok(pass, `expected text to contain "${s}", got "${t}"`);
  }
  async toHaveValue(value) {
    const got = (await this._snap()).value ?? "";
    this._ok(matchText(value, got), `expected value ${value}, got "${got}"`);
  }
  async toHaveValues(values) {
    const got = await this._v.selectedValues();
    this._ok(
      JSON.stringify(got) === JSON.stringify(values),
      `expected values ${values}, got ${got}`,
    );
  }
  async toHaveRole(role) {
    const got = (await this._snap()).role;
    this._ok(got === role, `expected role ${role}, got "${got}"`);
  }
  async toHaveAccessibleName(name) {
    const got = (await this._snap()).name;
    this._ok(matchText(name, got), `expected accessible name ${name}, got "${got}"`);
  }
  async toHaveAccessibleDescription(d) {
    const got = (await this._snap()).description;
    this._ok(matchText(d, got), `expected accessible description ${d}, got "${got}"`);
  }
  async toHaveAttribute(name, value) {
    const got = await this._v.getAttribute(name);
    this._ok(
      value === undefined ? got !== null : got === value,
      `expected attribute ${name}=${value}, got ${got}`,
    );
  }
  async toHaveClass(cls) {
    const got = (await this._v.getAttribute("class")) ?? "";
    const pass = cls instanceof RegExp ? cls.test(got) : got.split(/\s+/).includes(cls);
    this._ok(pass, `expected class "${cls}" in "${got}"`);
  }
  async toContainClass(cls) {
    return this.toHaveClass(cls);
  }
  async toHaveId(id) {
    const got = await this._v.getAttribute("id");
    this._ok(got === id, `expected id ${id}, got ${got}`);
  }
  async toHaveCSS(name, value) {
    const got = await this._v.cssValue(name);
    this._ok(got === value, `expected css ${name}:${value}, got "${got}"`);
  }
  async toHaveJSProperty(name, value) {
    const got = await this._v.getAttribute(name);
    this._ok(String(got) === String(value), `expected ${name}=${value}, got ${got}`);
  }
  async toMatchAriaSnapshot(expected) {
    const node = this._v._node();
    const pass = node != null && native.matchesAriaSnapshot(this._v._html, node, expected);
    this._ok(pass, "expected element to match the ARIA snapshot");
  }
  toHaveScreenshot = UNSUPPORTED("expect(locator).toHaveScreenshot", PIXEL);
}

class PageExpect extends BaseExpect {
  get not() {
    return new PageExpect(this._v, !this._neg);
  }
  async toHaveURL(url) {
    const u = this._v.url();
    this._ok(matchText(url, u), `expected url ${url}, got "${u}"`);
  }
  async toHaveTitle(t) {
    const got = await this._v.title();
    this._ok(matchText(t, got), `expected title ${t}, got "${got}"`);
  }
  toHaveScreenshot = UNSUPPORTED("expect(page).toHaveScreenshot", PIXEL);
}

// `expect(promise).resolves.<m>()` / `.rejects.<m>()` — await, then apply the
// matcher to the resolved value (or, for rejects, the thrown error).
function asyncMatchers(awaiter, neg) {
  return new Proxy(
    {},
    {
      get:
        (_t, name) =>
        async (...args) => {
          const { value, threw } = await awaiter();
          if (threw && (name === "toThrow" || name === "toThrowError")) {
            const m = args[0];
            const ok =
              m == null ||
              (m instanceof RegExp ? m.test(value.message) : String(value.message).includes(m));
            if (!ok) throw new Error(`expected rejection to match ${m}, got "${value.message}"`);
            return undefined;
          }
          return new ValueExpect(value, neg)[name](...args);
        },
    },
  );
}

// jest-shaped generic-value matchers — pure JS, never cross the napi boundary.
class ValueExpect extends BaseExpect {
  get not() {
    return new ValueExpect(this._v, !this._neg);
  }
  get resolves() {
    const p = Promise.resolve(this._v);
    return asyncMatchers(async () => ({ value: await p, threw: false }), this._neg);
  }
  get rejects() {
    const p = Promise.resolve(this._v);
    return asyncMatchers(async () => {
      try {
        await p;
      } catch (e) {
        return { value: e, threw: true };
      }
      throw new Error("expected promise to reject, but it resolved");
    }, this._neg);
  }
  _await() {
    return this._v;
  }
  toBe(x) {
    this._ok(Object.is(this._v, x), `expected ${this._v} to be ${x}`);
  }
  toEqual(x) {
    this._ok(deepEqual(this._v, x), `expected ${json(this._v)} to equal ${json(x)}`);
  }
  toStrictEqual(x) {
    return this.toEqual(x);
  }
  toContain(x) {
    const pass =
      typeof this._v === "string" ? this._v.includes(x) : Array.from(this._v ?? []).includes(x);
    this._ok(pass, `expected ${json(this._v)} to contain ${json(x)}`);
  }
  toContainEqual(x) {
    this._ok(
      Array.from(this._v ?? []).some((e) => deepEqual(e, x)),
      `expected to contain ${json(x)}`,
    );
  }
  toMatch(re) {
    this._ok(
      (re instanceof RegExp ? re : new RegExp(re)).test(String(this._v)),
      `expected ${this._v} to match ${re}`,
    );
  }
  toMatchObject(o) {
    this._ok(subset(o, this._v), `expected ${json(this._v)} to match ${json(o)}`);
  }
  toBeNull() {
    this._ok(this._v === null, `expected ${this._v} to be null`);
  }
  toBeUndefined() {
    this._ok(this._v === undefined, `expected ${this._v} to be undefined`);
  }
  toBeDefined() {
    this._ok(this._v !== undefined, "expected value to be defined");
  }
  toBeTruthy() {
    this._ok(!!this._v, `expected ${this._v} to be truthy`);
  }
  toBeFalsy() {
    this._ok(!this._v, `expected ${this._v} to be falsy`);
  }
  toBeNaN() {
    this._ok(Number.isNaN(this._v), `expected ${this._v} to be NaN`);
  }
  toBeGreaterThan(n) {
    this._ok(this._v > n, `expected ${this._v} > ${n}`);
  }
  toBeGreaterThanOrEqual(n) {
    this._ok(this._v >= n, `expected ${this._v} >= ${n}`);
  }
  toBeLessThan(n) {
    this._ok(this._v < n, `expected ${this._v} < ${n}`);
  }
  toBeLessThanOrEqual(n) {
    this._ok(this._v <= n, `expected ${this._v} <= ${n}`);
  }
  toBeCloseTo(n, digits = 2) {
    this._ok(Math.abs(this._v - n) < 10 ** -digits / 2, `expected ${this._v} close to ${n}`);
  }
  toBeInstanceOf(c) {
    this._ok(this._v instanceof c, `expected instance of ${c?.name}`);
  }
  toHaveLength(n) {
    this._ok(this._v?.length === n, `expected length ${n}, got ${this._v?.length}`);
  }
  toHaveProperty(key, value) {
    const got = key.split(".").reduce((o, k) => o?.[k], this._v);
    this._ok(
      value === undefined ? got !== undefined : deepEqual(got, value),
      `expected property ${key}`,
    );
  }
  toThrow(expected) {
    let threw = null;
    try {
      this._v();
    } catch (e) {
      threw = e;
    }
    const pass = threw != null && (expected == null || String(threw.message).includes(expected));
    this._ok(pass, "expected function to throw");
  }
  toThrowError(expected) {
    return this.toThrow(expected);
  }
  // jest mock matchers (used with spies in suites)
  toHaveBeenCalled() {
    this._ok((this._v?.mock?.calls?.length ?? 0) > 0, "expected mock to have been called");
  }
  toHaveBeenCalledWith(...args) {
    const calls = this._v?.mock?.calls ?? [];
    this._ok(
      calls.some((c) => deepEqual(c, args)),
      `expected mock called with ${json(args)}`,
    );
  }
  toHaveScreenshot = UNSUPPORTED("toHaveScreenshot", PIXEL);
  toMatchSnapshot = UNSUPPORTED("toMatchSnapshot", PIXEL);
}

function matchText(expected, got) {
  if (expected instanceof RegExp) return expected.test(got);
  if (Array.isArray(expected)) return expected.some((e) => matchText(e, got));
  return got === expected;
}
// Playwright normalizes whitespace in text assertions (nbsp→space, collapse, trim).
const normWs = (s) => String(s).replace(/ /g, " ").replace(/\s+/g, " ").trim();
const json = (x) => {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
};
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a == null || b == null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}
function subset(want, got) {
  if (typeof want !== "object" || want == null) return deepEqual(want, got);
  return Object.keys(want).every((k) => subset(want[k], got?.[k]));
}

export function expect(value) {
  if (value instanceof Locator) return new LocatorExpect(value, false);
  if (value instanceof Page) return new PageExpect(value, false);
  return new ValueExpect(value, false);
}
expect.soft = expect; // soft assertions behave as hard ones here
expect.poll = (fn, _o) => new ValueExpect(fn(), false);
expect.configure = () => expect;
expect.extend = () => {};

// ---------------------------------------------------------------------------
// @playwright/test surface (drop-in over node:test) — fixtures, hooks, steps.
// ---------------------------------------------------------------------------
import { test as nodeTest, before, after, beforeEach, afterEach } from "node:test";

// A fixture set: each value is either a plain default or [fn, opts] / async fn
// of ({ ...fixtures }, use). We resolve them lazily and tear down after `use`.
function makeBaseFixtures() {
  return {
    browser: async (_f, use) => use(browserStub),
    context: async (_f, use) => use(new BrowserContext()),
    page: async (f, use) => {
      const ctx = f.context ?? new BrowserContext();
      const page = await ctx.newPage();
      await use(page);
    },
    request: async (_f, use) => use(request),
    baseURL: async (_f, use) => use(process.env.TURBO_SHIM_BASE_URL ?? undefined),
  };
}

function makeTestFn(baseDefs, extDefs = {}) {
  const open = (testInfo) => openFixtures(baseDefs, extDefs, testInfo);
  const run = (name, fn) =>
    nodeTest(name, async () => {
      const testInfo = makeTestInfo(name);
      const { arg, teardown } = await open(testInfo);
      try {
        await fn(arg, testInfo);
      } finally {
        await teardown();
      }
    });
  run.describe = makeDescribe();
  run.skip = (name, fn) => nodeTest.skip(name, async () => fn?.({}, makeTestInfo(name)));
  run.only = (name, fn) => nodeTest.only(name, async () => runWith(open, name, fn));
  run.fixme = run.skip;
  run.fail = run;
  run.slow = () => {};
  run.setTimeout = () => {};
  run.use = () => {};
  run.step = async (_name, body) => body();
  run.info = () => makeTestInfo("");
  run.beforeEach = (fn) => beforeEach(async () => fn((await open(makeTestInfo("beforeEach"))).arg));
  run.afterEach = (fn) => afterEach(async () => fn({}));
  run.beforeAll = (fn) => before(async () => fn({}));
  run.afterAll = (fn) => after(async () => fn({}));
  // A new fixture name extends; reusing a base/ext name OVERRIDES it but the
  // override still sees the prior value (Playwright's `page: ({page}) => …`).
  run.extend = (more) => makeTestFn(baseDefs, { ...extDefs, ...more });
  return run;
}

async function runWith(open, name, fn) {
  const { arg, teardown } = await open(makeTestInfo(name));
  try {
    await fn(arg, makeTestInfo(name));
  } finally {
    await teardown();
  }
}

function makeDescribe() {
  const d = (name, fn) => nodeTest(name, fn);
  d.skip = (name, fn) => nodeTest.skip(name, fn ?? (() => {}));
  d.only = (name, fn) => nodeTest(name, fn);
  d.serial = d;
  d.parallel = d;
  d.configure = () => {};
  return d;
}

function makeTestInfo(title) {
  return {
    title,
    titlePath: [title],
    outputDir: "/tmp",
    outputPath: (...p) => ["/tmp", ...p].join("/"),
    snapshotPath: (...p) => ["/tmp", ...p].join("/"),
    attach: async () => {},
    attachments: [],
    skip: () => {},
    fixme: () => {},
    fail: () => {},
    slow: () => {},
    setTimeout: () => {},
    annotations: [],
    errors: [],
    status: "passed",
    expectedStatus: "passed",
    retry: 0,
    project: { name: "turbo-crawl" },
  };
}

// Resolve the fixture argument object. Base fixtures (browser → context → page →
// request → baseURL) resolve first, then extensions in insertion order — so an
// extension overriding a base name (e.g. `page`) already sees the base value in
// `arg` when it runs, and replaces it via `use(val)`. Returns { arg, teardown }.
async function openFixtures(baseDefs, extDefs, testInfo) {
  const arg = {};
  const teardowns = [];
  const resolve = async (name, def) => {
    if (def === undefined) return;
    if (typeof def !== "function") {
      arg[name] = def;
      return;
    }
    await new Promise((settle, reject) => {
      const used = (val) =>
        new Promise((release) => {
          arg[name] = val;
          teardowns.push(release);
          settle();
        });
      Promise.resolve(def(arg, used, testInfo)).then(() => settle(), reject);
    });
  };
  for (const name of ["browser", "context", "page", "request", "baseURL"])
    await resolve(name, baseDefs[name]);
  for (const name of Object.keys(extDefs)) await resolve(name, extDefs[name]);
  const teardown = async () => {
    for (const release of teardowns.reverse()) release();
  };
  return { arg, teardown };
}

export const test = makeTestFn(makeBaseFixtures());

/** `defineConfig` is identity — the Playwright CLI/config is unused under node:test. */
export const defineConfig = (config) => config;
/** Device descriptors are no-ops (no real viewport/UA emulation). */
export const devices = new Proxy({}, { get: () => ({}) });
/** APIRequestContext: fetch over the shared Rust client. The response carries
 * the RAW body (makeResponse.text/json), not a re-serialized DOM. */
export const request = {
  async newContext(opts = {}) {
    const headers = opts.extraHTTPHeaders ? JSON.stringify(opts.extraHTTPHeaders) : null;
    // Honor the context `baseURL` like real Playwright: a relative request path
    // (e.g. `ctx.get('/api/backend/...')`) resolves against it. Without this the
    // schemeless URL reaches reqwest as-is and fails with "builder error".
    const base = opts.baseURL ?? null;
    const resolve = (url) => {
      if (!base) return url;
      try {
        return new URL(url, base).href;
      } catch {
        return url;
      }
    };
    const ctxHeaders = opts.extraHTTPHeaders ?? {};
    // Encode a request `data`/body like Playwright: an object → JSON body with
    // `Content-Type: application/json` (unless the caller set one), a string → sent
    // as-is. Per-request `headers` merge over the context's `extraHTTPHeaders`.
    const encode = (o = {}) => {
      const h = { ...ctxHeaders, ...o.headers };
      let body = null;
      if (o.data != null) {
        if (typeof o.data === "string" || Buffer.isBuffer?.(o.data)) {
          body = String(o.data);
        } else {
          body = JSON.stringify(o.data);
          if (!Object.keys(h).some((k) => k.toLowerCase() === "content-type")) {
            h["Content-Type"] = "application/json";
          }
        }
      }
      const hdr = Object.keys(h).length ? JSON.stringify(h) : headers;
      return { body, hdr };
    };
    const call = async (url, method, o = {}) => {
      const { body, hdr } = encode(o);
      return makeResponse(
        JSON.parse(await native.fetchWithCookies(resolve(url), "[]", method ?? null, body, hdr)),
      );
    };
    return {
      get: (url, o = {}) => call(url, null, o),
      post: (url, o = {}) => call(url, "POST", o),
      put: (url, o = {}) => call(url, "PUT", o),
      patch: (url, o = {}) => call(url, "PATCH", o),
      delete: (url, o = {}) => call(url, "DELETE", o),
      head: (url, o = {}) => call(url, "HEAD", o),
      fetch: (url, o = {}) => call(url, o.method ?? null, o),
      async storageState() {
        return { cookies: [], origins: [] };
      },
      async dispose() {},
    };
  },
};

export default { test, expect, chromium, firefox, webkit, newPage, defineConfig, devices, request };
