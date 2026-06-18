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

  // --- counts / text ---
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

  // --- accessors (node-handle backed; work for query AND getBy) ---
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

  // --- actions (mutate the page's cached DOM by handle) ---
  async fill(value) {
    this._page._html = native.fillNode(this._html, this._requireNode(), String(value));
  }
  async check() {
    this._page._html = native.setCheckedNode(this._html, this._requireNode(), true);
  }
  async uncheck() {
    this._page._html = native.setCheckedNode(this._html, this._requireNode(), false);
  }
  async selectOption(value) {
    this._page._html = native.selectOptionNode(this._html, this._requireNode(), String(value));
  }
  async click() {
    const intent = JSON.parse(native.clickNode(this._html, this._requireNode(), this._page._url));
    return this._page._followIntent(intent);
  }
  async press() {
    // Enter on a control submits its owning form (the only no-JS key effect).
    return this.click();
  }

  // --- unsupported (no-render engine) → honest throws (G5) ---
  async screenshot() {
    throw new Error("turbo-crawl: locator.screenshot unavailable — no-JS render engine");
  }
  async boundingBox() {
    throw new Error("turbo-crawl: locator.boundingBox unavailable — no-JS render engine");
  }
  async hover() {
    throw new Error("turbo-crawl: locator.hover unavailable — no synthetic pointer events");
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
    return this._followIntent(intent);
  }

  // Shared by page.click and locator.click.
  async _followIntent(intent) {
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

  // --- unsupported (no-render engine) → honest throws (G5) ---
  async screenshot() {
    throw new Error("turbo-crawl: page.screenshot unavailable — no-JS render engine");
  }
  async pdf() {
    throw new Error("turbo-crawl: page.pdf unavailable — no-JS render engine");
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

  // --- count / text ---
  async toHaveCount(n) {
    const c = await this._loc.count();
    this._assert(c === n, `expected count ${n}, got ${c}`);
  }
  async toHaveText(s) {
    const t = ((await this._loc.textContent()) ?? "").trim();
    const pass = s instanceof RegExp ? s.test(t) : t === s;
    this._assert(pass, `expected text ${s}, got "${t}"`);
  }
  async toContainText(s) {
    const t = (await this._loc.textContent()) ?? "";
    this._assert(t.includes(s), `expected text to contain "${s}", got "${t}"`);
  }

  // --- state ---
  async toBeVisible() {
    this._assert(await this._loc.isVisible(), "expected element to be visible");
  }
  async toBeHidden() {
    this._assert(await this._loc.isHidden(), "expected element to be hidden");
  }
  async toBeChecked() {
    this._assert(await this._loc.isChecked(), "expected element to be checked");
  }
  async toBeEnabled() {
    this._assert(await this._loc.isEnabled(), "expected element to be enabled");
  }
  async toBeDisabled() {
    this._assert(await this._loc.isDisabled(), "expected element to be disabled");
  }
  async toBeEditable() {
    this._assert(await this._loc.isEditable(), "expected element to be editable");
  }
  async toBeEmpty() {
    this._assert(await this._loc.isEmpty(), "expected element to be empty");
  }

  // --- attribute / value / css ---
  async toHaveAttribute(name, value) {
    const got = await this._loc.getAttribute(name);
    const pass = value === undefined ? got !== null : got === value;
    this._assert(pass, `expected attribute ${name}=${value}, got ${got}`);
  }
  async toHaveValue(value) {
    const got = await this._loc.inputValue();
    const pass = value instanceof RegExp ? value.test(got) : got === value;
    this._assert(pass, `expected value ${value}, got "${got}"`);
  }
  async toHaveClass(cls) {
    const got = (await this._loc.getAttribute("class")) ?? "";
    const pass = got.split(/\s+/).includes(cls);
    this._assert(pass, `expected class "${cls}" in "${got}"`);
  }
  async toHaveCSS(name, value) {
    const got = await this._loc.cssValue(name);
    this._assert(got === value, `expected css ${name}:${value}, got "${got}"`);
  }

  // --- aria snapshot ---
  async toMatchAriaSnapshot(expected) {
    const node = this._loc._node();
    const pass = node != null && native.matchesAriaSnapshot(this._loc._html, node, expected);
    this._assert(pass, "expected element to match the ARIA snapshot");
  }
}

export function expect(locator) {
  return new Expectation(locator, false);
}

export { Locator, Page };
