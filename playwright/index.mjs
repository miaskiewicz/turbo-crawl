// Playwright-compatibility façade. Lets an existing Playwright script run on
// turbo-crawl's no-JS engine — with NO playwright or chromium loaded. The
// chromium/firefox/webkit launchers all return the same turbo-crawl-backed
// pseudo-browser (there is no real browser).
//
//   import { chromium, expect } from "@miaskiewicz/turbo-crawl/playwright";
//   const browser = await chromium.launch();
//   const page = await browser.newPage();
//   await page.goto(url); await page.getByRole("button", { name: "Go" }).click();
//
// JS-only APIs (evaluate/screenshot/route/hover/…) throw a clear error pointing
// at the JS-execution tier (docs/js-execution-tier.md).

import { Page } from "../src/page.mjs";
import { expect } from "./expect.mjs";

function jsTier(name) {
  return new Error(
    `turbo-crawl/playwright: ${name}() needs JavaScript/rendering — not available in the no-JS engine. ` +
      `See docs/js-execution-tier.md.`,
  );
}

// Map a Playwright context/launch options bag to turbo-crawl Page options.
function toPageOptions(opts = {}) {
  return { userAgent: opts.userAgent, navigator: opts.navigator, fetchHtml: opts.fetchHtml };
}

// Minimal Response shim (page.goto return value).
class PWResponse {
  constructor(nav) {
    this.nav = nav;
  }
  status() {
    return this.nav.status;
  }
  url() {
    return this.nav.url;
  }
  ok() {
    return this.nav.status >= 200 && this.nav.status < 300;
  }
}

const wrapNav = (nav) => (nav ? new PWResponse(nav) : null);

class PWPage {
  #page;

  constructor(page) {
    this.#page = page;
  }

  /** Escape hatch to the underlying turbo-crawl Page. */
  get tcPage() {
    return this.#page;
  }

  // navigation
  async goto(url, opts) {
    return new PWResponse(await this.#page.goto(url, opts));
  }
  async goBack(opts) {
    return wrapNav(await this.#page.goBack(opts));
  }
  async goForward(opts) {
    return wrapNav(await this.#page.goForward(opts));
  }
  async reload(opts) {
    return new PWResponse(await this.#page.reload(opts));
  }
  url() {
    return this.#page.url;
  }
  async title() {
    return this.#page.title();
  }
  async content() {
    return this.#page.html();
  }

  // locators (delegate to the turbo-crawl Page)
  locator(selector) {
    return this.#page.locator(selector);
  }
  getByRole(role, opts) {
    return this.#page.getByRole(role, opts);
  }
  getByText(text, opts) {
    return this.#page.getByText(text, opts);
  }
  getByLabel(text, opts) {
    return this.#page.getByLabel(text, opts);
  }
  getByPlaceholder(text, opts) {
    return this.#page.getByPlaceholder(text, opts);
  }
  getByTestId(id) {
    return this.#page.getByTestId(id);
  }
  getByAltText(text, opts) {
    return this.#page.getByAltText(text, opts);
  }
  getByTitle(text, opts) {
    return this.#page.getByTitle(text, opts);
  }

  // selector-string shorthands (Playwright page.click(selector), etc.)
  #first(selector) {
    return this.#page.locator(selector).first();
  }
  async click(selector, opts) {
    return this.#first(selector).click(opts);
  }
  async fill(selector, value) {
    this.#first(selector).fill(value);
  }
  async type(selector, value) {
    this.#first(selector).type(value);
  }
  async check(selector) {
    this.#first(selector).check();
  }
  async uncheck(selector) {
    this.#first(selector).uncheck();
  }
  async selectOption(selector, value) {
    this.#first(selector).selectOption(value);
  }
  async press(selector) {
    return this.#first(selector).press();
  }

  // accessors
  async textContent(selector) {
    return this.#first(selector).textContent();
  }
  async innerText(selector) {
    return this.#first(selector).innerText();
  }
  async innerHTML(selector) {
    return this.#first(selector).innerHTML();
  }
  async getAttribute(selector, name) {
    return this.#first(selector).getAttribute(name);
  }
  async inputValue(selector) {
    return this.#first(selector).inputValue();
  }
  async isVisible(selector) {
    return this.#first(selector).isVisible();
  }
  async isEnabled(selector) {
    return this.#first(selector).isEnabled();
  }
  async isChecked(selector) {
    return this.#first(selector).isChecked();
  }

  // waiting — the DOM is static per navigation, so these resolve immediately.
  async waitForLoadState() {}
  async waitForTimeout() {}
  async waitForURL() {}
  async waitForSelector(selector) {
    const loc = this.#page.locator(selector);
    if (!loc.count()) throw jsTier(`waitForSelector(${selector})`);
    return loc.first();
  }

  // evaluate runs against the current (already-rendered) DOM — see Page.evaluate.
  async evaluate(pageFunction, ...args) {
    return this.#page.evaluate(pageFunction, ...args);
  }
  async $eval(selector, fn, ...args) {
    return this.#page.$eval(selector, fn, ...args);
  }
  async $$eval(selector, fn, ...args) {
    return this.#page.$$eval(selector, fn, ...args);
  }

  // genuinely JS-render / pixel only — unsupported without a browser
  screenshot() {
    throw jsTier("screenshot");
  }
  pdf() {
    throw jsTier("pdf");
  }
  route() {
    throw jsTier("route");
  }
  async hover() {
    throw jsTier("hover");
  }
  async close() {}
}

class BrowserContext {
  #opts;
  constructor(opts = {}) {
    this.#opts = opts;
  }
  async newPage() {
    return new PWPage(new Page(toPageOptions(this.#opts)));
  }
  async close() {}
}

class Browser {
  #opts;
  constructor(opts = {}) {
    this.#opts = opts;
  }
  async newPage() {
    return new PWPage(new Page(toPageOptions(this.#opts)));
  }
  async newContext(opts) {
    return new BrowserContext({ ...this.#opts, ...opts });
  }
  async close() {}
}

// All three "browser types" resolve to the same engine (there is no browser).
const browserType = { launch: async (opts) => new Browser(opts) };

export const chromium = browserType;
export const firefox = browserType;
export const webkit = browserType;
export { expect };
export { PWPage, Browser, BrowserContext };
