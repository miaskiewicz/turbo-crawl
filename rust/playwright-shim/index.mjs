// A thin, Playwright-shaped façade backed by the turbo-crawl native (Rust) addon
// — task #10. No browser, no JS engine: `goto` fetches + the read surface runs
// over the cached HTML through the napi addon (Rust turbo-dom + view modules).
//
// This is the drop-in seam: agents import a `@playwright/test`-like API; the
// muscle is Rust. Interaction (click/fill/submit) needs the addon's action ops
// (the Rust `actions`/`dom_ops` mutators aren't exposed over napi yet) and lands
// next; this shim covers navigation + the read/locator/expect surface.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../crates/turbo-crawl-napi/index.js");

class Locator {
  constructor(page, resolve, index = null) {
    this._page = page;
    this._resolve = resolve; // (html) => Array<{ node, text, html? }>
    this._index = index;
  }

  _all() {
    const m = this._resolve(this._page._html);
    if (this._index == null) return m;
    return m[this._index] ? [m[this._index]] : [];
  }

  async count() {
    return this._all().length;
  }

  async textContent() {
    const m = this._all();
    return m.length ? (m[0].text ?? null) : null;
  }

  async innerHTML() {
    const m = this._all();
    return m.length ? (m[0].html ?? null) : null;
  }

  async allTextContents() {
    return this._all().map((x) => x.text);
  }

  first() {
    return new Locator(this._page, this._resolve, 0);
  }

  nth(i) {
    return new Locator(this._page, this._resolve, i);
  }
}

class Page {
  _html = "";
  _url = "about:blank";

  async goto(url) {
    const r = JSON.parse(await native.fetchHtml(url));
    this._html = r.html;
    this._url = r.finalUrl;
    return { status: () => r.status, url: () => r.finalUrl };
  }

  // Playwright `setContent` — also the offline test seam.
  async setContent(html) {
    this._html = html;
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

  async innerText() {
    return native.text(this._html);
  }

  markdown() {
    return native.markdown(this._html, this._url);
  }

  // Evaluate JS against the page DOM → result string (Playwright page.evaluate-ish).
  async evaluate(script) {
    return native.evaluate(this._html, script);
  }

  // Run the page's own script (promises/timers/fetch/cookies) and replace the
  // cached HTML with the hydrated result — subsequent reads see the new DOM.
  async render(script) {
    this._html = native.render(this._html, this._url, script);
    return this._html;
  }

  async links() {
    return native.links(this._html, this._url);
  }

  // --- actions (mutate the cached DOM in place) ---
  async fill(selector, value) {
    this._html = native.fill(this._html, selector, value);
  }

  async check(selector) {
    this._html = native.setChecked(this._html, selector, true);
  }

  async uncheck(selector) {
    this._html = native.setChecked(this._html, selector, false);
  }

  async selectOption(selector, value) {
    this._html = native.selectOption(this._html, selector, value);
  }

  // Click = resolve the no-JS intent: navigate (<a>), submit (<form>), or inert.
  async click(selector) {
    const intent = JSON.parse(native.click(this._html, selector, this._url));
    if (intent.action === "navigate") return this.goto(intent.url);
    if (intent.action === "submit") return this._submit(intent);
    return null; // inert (a JS-only handler — nothing to fire without JS)
  }

  async _submit(intent) {
    const r =
      intent.method === "GET"
        ? JSON.parse(await native.fetchHtml(intent.url))
        : JSON.parse(await native.request(intent.url, intent.method, intent.body ?? null));
    this._html = r.html;
    this._url = r.finalUrl;
    return { status: () => r.status, url: () => r.finalUrl };
  }

  locator(selector) {
    return new Locator(this, (h) => JSON.parse(native.query(h, selector, "auto")));
  }

  getByRole(role, opts = {}) {
    return new Locator(this, (h) => JSON.parse(native.getBy(h, "role", role, opts.name ?? null)));
  }

  getByText(text) {
    return new Locator(this, (h) => JSON.parse(native.getBy(h, "text", text)));
  }

  getByLabel(text) {
    return new Locator(this, (h) => JSON.parse(native.getBy(h, "label", text)));
  }
}

// Minimal browser entry for drop-in feel: chromium.launch() → newPage().
export const chromium = {
  async launch() {
    return {
      async newPage() {
        return new Page();
      },
      async close() {},
    };
  },
};

export function newPage() {
  return new Page();
}

class Expectation {
  constructor(loc, negated) {
    this._loc = loc;
    this._neg = negated;
  }

  get not() {
    return new Expectation(this._loc, !this._neg);
  }

  _assert(pass, message) {
    // pass when the condition holds (and not negated) or fails (and negated).
    if (pass === this._neg) throw new Error(message);
  }

  async toHaveCount(n) {
    const c = await this._loc.count();
    this._assert(c === n, `expected count ${n}, got ${c}`);
  }

  async toHaveText(s) {
    const t = ((await this._loc.textContent()) ?? "").trim();
    this._assert(t === s, `expected text "${s}", got "${t}"`);
  }

  async toContainText(s) {
    const t = (await this._loc.textContent()) ?? "";
    this._assert(t.includes(s), `expected text to contain "${s}", got "${t}"`);
  }
}

export function expect(locator) {
  return new Expectation(locator, false);
}

export { Locator, Page };
