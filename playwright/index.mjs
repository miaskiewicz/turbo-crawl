// Playwright-compatibility façade. Lets an existing Playwright script run on
// turbo-crawl's engine — with NO playwright or chromium loaded. The
// chromium/firefox/webkit launchers all return the same turbo-crawl-backed
// pseudo-browser (there is no real browser).
//
//   import { chromium, expect } from "@miaskiewicz/turbo-crawl/playwright";
//   const browser = await chromium.launch({ mode: "fast" });
//   const page = await browser.newPage();
//   await page.goto(url); await page.getByRole("button", { name: "Go" }).click();
//
// With `mode: "fast" | "secure"` the page runs the JS-execution tier, so
// page-initiated fetch/XHR surface as `request`/`response` events, `console`/
// `pageerror` fire, and localStorage/cookies persist across navigations within a
// context (Playwright's storageState auth-reuse). Without a mode it stays Lane A
// (static, no page JS) but still emits navigation request/response events.
//
// Genuinely pixel/render-only APIs (screenshot/pdf/hover) throw a clear error
// pointing at the JS-execution tier (docs/js-execution-tier.md).

import { EventEmitter } from "node:events";

import { fetchHtml as netFetchHtml } from "../src/net.mjs";
import { Page } from "../src/page.mjs";
import { jsRenderer } from "../src/render/index.mjs";
import { ContextState, runRoutes } from "./context-state.mjs";
import { expect } from "./expect.mjs";
import {
  documentRequest,
  emitNetResponse,
  PWConsoleMessage,
  PWRequest,
  PWResponse,
  urlMatcher,
} from "./net-events.mjs";

function jsTier(name) {
  return new Error(
    `turbo-crawl/playwright: ${name}() needs pixel rendering — not available in the no-browser engine. ` +
      `See docs/js-execution-tier.md.`,
  );
}

const wrapNav = (nav) => (nav ? new PWResponse({ url: nav.url, status: nav.status }) : null);
const useRender = (opts) => !!opts.mode || !!opts.render;

// Wrap a fetcher so every request carries the page/context extra HTTP headers.
function withExtraHeaders(base, getHeaders) {
  return (url, o = {}) => base(url, { ...o, headers: { ...getHeaders(), ...o.headers } });
}

// Lane-A (no-JS) fetch wrapper: emit navigation request/response events (there are
// no page-initiated requests without the render tier).
function wrapLaneA(base, netHooks) {
  return async (url, o = {}) => {
    const req = documentRequest(url, o);
    netHooks.onRequest?.(req);
    const res = await base(url, o);
    emitNetResponse(netHooks, req, res, res.finalUrl);
    return res;
  };
}

// Resolve a Playwright url-or-predicate for an EVENT carrying an object with .url().
function eventPredicate(urlOrPred) {
  if (typeof urlOrPred === "function") return urlOrPred;
  const m = urlMatcher(urlOrPred);
  return (ev) => m(ev.url());
}

// One-shot wait for a matching emitter event, with a timeout.
function waitEvent(emitter, event, predicate, timeout) {
  return new Promise((resolve, reject) => {
    const onEvent = (arg) => {
      if (predicate && !predicate(arg)) return;
      cleanup();
      resolve(arg);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`turbo-crawl/playwright: waitForEvent(${event}) timed out after ${timeout}ms`),
      );
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      emitter.off(event, onEvent);
    }
    emitter.on(event, onEvent);
  });
}

// Normalize addInitScript(fn|string|{content}) to runnable classic code.
const fnInit = (fn, arg) => `(${fn})(${JSON.stringify(arg ?? null)});`;

function toInitCode(script, arg) {
  if (typeof script === "function") return fnInit(script, arg);
  if (script && typeof script === "object") return script.content ?? "";
  return String(script);
}

class PWPage {
  #page;
  #state;
  #emitter = new EventEmitter();
  #ctxEmitter;
  #pageRoutes = [];
  #pageInit = [];
  #headers = {};
  #renderer = null;

  constructor(opts, state, ctxEmitter) {
    this.#state = state;
    this.#ctxEmitter = ctxEmitter;
    this.#emitter.setMaxListeners(0);
    const fetchHtml = this.#buildFetch(opts);
    this.#page = new Page({
      fetchHtml,
      jar: state.jar,
      userAgent: opts.userAgent,
      navigator: opts.navigator,
    });
  }

  // Compose the effective fetcher: extra headers → (render tier | Lane-A wrapper).
  #buildFetch(opts) {
    const base = withExtraHeaders(opts.fetchHtml ?? netFetchHtml, () => this.#extraHeaders());
    if (!useRender(opts)) return wrapLaneA(base, this.#netHooks());
    this.#renderer = this.#makeRenderer(opts, base);
    return this.#renderer.fetchHtml;
  }

  #makeRenderer(opts, base) {
    const renderOpts = {
      mode: opts.mode ?? "fast",
      fetchHtml: base,
      storageFor: (url) => this.#state.storageFor(url),
      netHooks: this.#netHooks(),
      hooks: { onConsole: this.#onConsole, onPageError: this.#onPageError },
    };
    // initScripts read live (context + page) at each render; enumerable so the
    // render tier's `{ ...opts }` spread carries it through to the backend.
    Object.defineProperty(renderOpts, "initScripts", {
      enumerable: true,
      get: () => this.#initScripts(),
    });
    return jsRenderer(renderOpts);
  }

  #initScripts() {
    return [...this.#state.initScripts, ...this.#pageInit];
  }
  #extraHeaders() {
    return { ...this.#state.extraHeaders, ...this.#headers };
  }

  // --- events ---------------------------------------------------------------

  #emit(event, arg) {
    this.#emitter.emit(event, arg);
    this.#ctxEmitter?.emit(event, arg);
  }
  #netHooks() {
    return {
      onRequest: (r) => this.#emit("request", new PWRequest(r)),
      onResponse: (r) => this.#emit("response", new PWResponse(r)),
      onRequestFinished: (r) => this.#emit("requestfinished", new PWRequest(r)),
      onRequestFailed: (r) => this.#emit("requestfailed", new PWRequest(r)),
      intercept: (req) => this.#intercept(req),
    };
  }
  #onConsole = (type, args) => this.#emit("console", new PWConsoleMessage(type, args));
  #onPageError = (err) => this.#emit("pageerror", err);

  #intercept(req) {
    return runRoutes([...this.#pageRoutes, ...this.#state.routes], req, (r) => new PWRequest(r));
  }

  on(event, cb) {
    this.#emitter.on(event, cb);
    return this;
  }
  once(event, cb) {
    this.#emitter.once(event, cb);
    return this;
  }
  off(event, cb) {
    this.#emitter.off(event, cb);
    return this;
  }
  removeListener(event, cb) {
    return this.off(event, cb);
  }

  waitForEvent(event, optsOrPred = {}) {
    const isFn = typeof optsOrPred === "function";
    const predicate = isFn ? optsOrPred : optsOrPred.predicate;
    const timeout = (isFn ? undefined : optsOrPred.timeout) ?? 30000;
    return waitEvent(this.#emitter, event, predicate, timeout);
  }
  waitForResponse(urlOrPred, opts = {}) {
    return this.waitForEvent("response", {
      predicate: eventPredicate(urlOrPred),
      timeout: opts.timeout,
    });
  }
  waitForRequest(urlOrPred, opts = {}) {
    return this.waitForEvent("request", {
      predicate: eventPredicate(urlOrPred),
      timeout: opts.timeout,
    });
  }

  // --- routing / init / headers --------------------------------------------

  route(pattern, handler) {
    this.#pageRoutes.unshift({ match: urlMatcher(pattern), handler, pattern });
  }
  unroute(pattern, handler) {
    this.#pageRoutes = this.#pageRoutes.filter((r) => keepRoute(r, pattern, handler));
  }
  addInitScript(script, arg) {
    this.#pageInit.push(toInitCode(script, arg));
  }
  async setExtraHTTPHeaders(headers) {
    this.#headers = { ...headers };
  }

  /** Escape hatch to the underlying turbo-crawl Page. */
  get tcPage() {
    return this.#page;
  }
  context() {
    return this.#ctxEmitter?.owner ?? null;
  }

  // --- navigation -----------------------------------------------------------
  async goto(url, opts) {
    const nav = await this.#page.goto(url, opts);
    this.#emit("domcontentloaded", this);
    this.#emit("load", this);
    return new PWResponse({ url: nav.url, status: nav.status });
  }
  async goBack(opts) {
    return wrapNav(await this.#page.goBack(opts));
  }
  async goForward(opts) {
    return wrapNav(await this.#page.goForward(opts));
  }
  async reload(opts) {
    return new PWResponse({ url: (await this.#page.reload(opts)).url, status: this.#page.status });
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

  // no-op emulation (no viewport/media in a no-browser engine)
  async emulateMedia() {}
  async setViewportSize() {}
  async bringToFront() {}

  // genuinely pixel-only — unsupported without a browser
  screenshot() {
    throw jsTier("screenshot");
  }
  pdf() {
    throw jsTier("pdf");
  }
  async hover() {
    throw jsTier("hover");
  }
  async close() {
    this.#emit("close", this);
    await this.#renderer?.close();
  }
}

function keepRoute(r, pattern, handler) {
  if (r.pattern !== pattern) return true;
  return handler ? r.handler !== handler : false;
}

class BrowserContext {
  #opts;
  #state;
  #emitter = new EventEmitter();
  #pages = [];

  constructor(opts = {}, storageState) {
    this.#opts = opts;
    this.#state = new ContextState(storageState ?? opts.storageState);
    this.#emitter.setMaxListeners(0);
    this.#emitter.owner = this;
  }
  async newPage(opts = {}) {
    const page = new PWPage({ ...this.#opts, ...opts }, this.#state, this.#emitter);
    this.#pages.push(page);
    return page;
  }
  pages() {
    return [...this.#pages];
  }
  on(event, cb) {
    this.#emitter.on(event, cb);
    return this;
  }
  off(event, cb) {
    this.#emitter.off(event, cb);
    return this;
  }
  // persistent-state surface (cookies + storage + routes + headers)
  async addCookies(cookies) {
    this.#state.addCookies(cookies);
  }
  async cookies() {
    return this.#state.cookies();
  }
  async storageState() {
    return this.#state.storageState();
  }
  async addInitScript(script, arg) {
    this.#state.addInitScript(toInitCode(script, arg));
  }
  async route(pattern, handler) {
    this.#state.route(pattern, handler);
  }
  async unroute(pattern, handler) {
    this.#state.unroute(pattern, handler);
  }
  async setExtraHTTPHeaders(headers) {
    this.#state.setExtraHTTPHeaders(headers);
  }
  async close() {}
}

class Browser {
  #opts;
  constructor(opts = {}) {
    this.#opts = opts;
  }
  async newPage(opts = {}) {
    const merged = { ...this.#opts, ...opts };
    return new PWPage(merged, new ContextState(merged.storageState), null);
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
