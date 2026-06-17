// Page — a single navigable context. Owns ONE turbo-dom env for its lifetime and
// resets it per hop (SPEC §3.2: navigation = re-parse, not re-render). The unit an
// agent drives.

import vm from "node:vm";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { buildSubmission, fillValue } from "./actions.mjs";
import { accessibilityTree } from "./ax.mjs";
import { CookieJar } from "./cookies.mjs";
import { interactiveElements, links } from "./extract.mjs";
import { extractHydrationState } from "./hydration.mjs";
import { byAttrText, byCss, byLabel, byRole, byText, Locator } from "./locator.mjs";
import { markdown } from "./markdown.mjs";
import { fetchHtml } from "./net.mjs";
import { query } from "./query.mjs";
import { extractSchema } from "./schema.mjs";
import { text } from "./text.mjs";
import { isHttpUrl, resolve } from "./url.mjs";

// Resolved href of an <a> element against the current page, or null.
function anchorHref(el, base) {
  if (el.tagName.toLowerCase() !== "a") return null;
  const raw = el.getAttribute("href");
  return raw ? (resolve(base, raw) ?? raw) : null;
}

// A click activates a form submit when the element is a submit input or a
// <button> that is not an explicit type="button".
function isSubmitControl(el) {
  const type = el.getAttribute("type")?.toLowerCase();
  const tag = el.tagName.toLowerCase();
  return type === "submit" || (tag === "button" && type !== "button");
}

// Collect navigator overrides from constructor opts (userAgent is a shorthand for
// navigator.userAgent). Returns null when nothing is overridden.
function normalizeNavigator(opts) {
  const nav = { ...opts.navigator };
  if (opts.userAgent) nav.userAgent = opts.userAgent;
  return Object.keys(nav).length ? nav : null;
}

export class Page {
  #env = null;
  #fetchHtml;
  #jar;
  #nav; // navigator property overrides (also drives the HTTP User-Agent), or null
  #url = null;
  #status = 0;
  #snapshot = null; // last interactiveElements() result: index → record (with .ref)
  #history = []; // visited URLs for back/forward
  #histIndex = -1;
  #requests = []; // URLs the page fetched during render (JS tier), for crawl discovery

  /**
   * @param {object} [opts]
   * @param {typeof fetchHtml} [opts.fetchHtml]  injectable fetcher (tests / Lane B)
   * @param {CookieJar} [opts.jar]               shared cookie jar (default: fresh)
   * @param {string} [opts.userAgent]            UA for both navigator.userAgent and the HTTP header
   * @param {object} [opts.navigator]            navigator property overrides (platform, language, …)
   */
  constructor(opts = {}) {
    this.#fetchHtml = opts.fetchHtml ?? fetchHtml;
    this.#jar = opts.jar ?? new CookieJar();
    this.#nav = normalizeNavigator(opts);
  }

  /** The Page's cookie jar (session state across hops). */
  get cookies() {
    return this.#jar;
  }

  /** The live navigator object (with any overrides applied). Throws before goto. */
  get navigator() {
    return this.window.navigator;
  }

  /**
   * Override navigator properties (and the HTTP User-Agent, if `userAgent` is
   * among them). Persists across navigations; applied to the current page too.
   */
  setNavigator(props) {
    this.#nav = { ...this.#nav, ...props };
    if (this.#env) Object.assign(this.#env.window.navigator, props);
    return this;
  }

  /** Shorthand for setNavigator({ userAgent }). */
  setUserAgent(userAgent) {
    return this.setNavigator({ userAgent });
  }

  #uaHeader() {
    return this.#nav?.userAgent ? { "user-agent": this.#nav.userAgent } : {};
  }

  // Fetch with the session jar + configured User-Agent; per-call headers win.
  #fetch(url, opts = {}) {
    const headers = { ...this.#uaHeader(), ...opts.headers };
    return this.#fetchHtml(url, { jar: this.#jar, ...opts, headers });
  }

  /** Absolute URL of the currently-loaded page (after redirects), or null. */
  get url() {
    return this.#url;
  }

  /** HTTP status of the last navigation. */
  get status() {
    return this.#status;
  }

  /** turbo-dom Document of the current page. Throws before the first goto. */
  get document() {
    if (!this.#env) throw new Error("turbo-crawl: no page loaded — call goto() first");
    return this.#env.document;
  }

  /** turbo-dom window of the current page. */
  get window() {
    if (!this.#env) throw new Error("turbo-crawl: no page loaded — call goto() first");
    return this.#env.window;
  }

  // --- navigation -----------------------------------------------------------

  /**
   * Navigate to `url`: fetch HTML, then build (first hop) or reset (subsequent
   * hops) the turbo-dom env over it.
   * @returns {Promise<{ status:number, url:string, title:string }>}
   */
  async goto(url, opts = {}) {
    return this.#load(await this.#fetch(url, opts));
  }

  // Apply a fetched response to the env. Shared by goto/follow/submit.
  // `mode`: "push" (normal nav) | "replace" (reload) | "none" (back/forward).
  #load({ html, finalUrl, status, discovered }, mode = "push") {
    if (this.#env) this.#env.reset(html);
    else this.#env = createEnvironment(html);
    this.#requests = discovered ?? [];
    // Bridge the session jar into the DOM so page-side document.cookie reads are
    // consistent (turbo-dom nulls __cookieJar on reset, so re-attach each hop).
    this.#env.document.__cookieJar = this.#jar.cookieMap(finalUrl);
    // Re-apply navigator overrides (turbo-dom resets globals on reset each hop).
    if (this.#nav) Object.assign(this.#env.window.navigator, this.#nav);
    this.#url = finalUrl;
    this.#status = status;
    this.#snapshot = null;
    this.#recordHistory(finalUrl, mode);
    return { status, url: finalUrl, title: this.title() };
  }

  #recordHistory(url, mode) {
    if (mode === "none") return;
    if (mode === "replace") {
      this.#history[this.#histIndex] = url;
      return;
    }
    this.#history = this.#history.slice(0, this.#histIndex + 1);
    this.#history.push(url);
    this.#histIndex = this.#history.length - 1;
  }

  /** Follow an (absolute or relative) href against the current page. */
  async follow(href, opts = {}) {
    const abs = resolve(this.#url, href);
    if (!abs || !isHttpUrl(abs)) throw new Error(`turbo-crawl: not a navigable URL: ${href}`);
    return this.goto(abs, opts);
  }

  /** Re-fetch the current URL (replaces the history entry). */
  async reload(opts = {}) {
    return this.#load(await this.#fetch(this.#url, opts), "replace");
  }

  /** Navigate to the previous history entry, or null if at the start. */
  async goBack(opts = {}) {
    if (this.#histIndex <= 0) return null;
    this.#histIndex--;
    return this.#load(await this.#fetch(this.#history[this.#histIndex], opts), "none");
  }

  /** Navigate to the next history entry, or null if at the end. */
  async goForward(opts = {}) {
    if (this.#histIndex >= this.#history.length - 1) return null;
    this.#histIndex++;
    return this.#load(await this.#fetch(this.#history[this.#histIndex], opts), "none");
  }

  // --- queries --------------------------------------------------------------

  title() {
    const el = this.document.querySelector("title");
    return el ? el.textContent.trim() : "";
  }

  /**
   * Indexed interactive elements (SPEC §7.1); also refreshes the action snapshot.
   * @param {{visibility?:boolean}} [options] pass `visibility:false` to skip the
   *   cascade-based visibility pass (faster when the caller ignores `visible`).
   */
  interactiveElements(options) {
    this.#snapshot = interactiveElements(this.document, this.#url, this.window, options);
    return this.#snapshot;
  }

  links() {
    return links(this.document, this.#url);
  }

  /** URLs the page fetched during the last render (JS tier); [] in Lane A. */
  requests() {
    return this.#requests;
  }

  /**
   * Serialized HTML of the current DOM (the fetched/parsed markup; once the
   * JS-execution tier lands, the rendered DOM after page scripts run).
   */
  html() {
    const root = this.document.documentElement;
    const markup = root ? root.outerHTML : "";
    return root && root.tagName === "HTML" ? `<!DOCTYPE html>\n${markup}` : markup;
  }

  /**
   * Plain text of the page — no markup — with line breaks inserted at block-level
   * DOM boundaries so structure survives as paragraphs (SPEC §7.2 sibling view).
   */
  text() {
    return text(this.document);
  }

  markdown() {
    return markdown(this.document, this.#url);
  }

  accessibilityTree() {
    return accessibilityTree(this.document);
  }

  /** Structured extraction against a selector-bound schema (SPEC §7.4). */
  extract(schema) {
    return extractSchema(this.document, schema, this.#url);
  }

  // --- in-page evaluation (Playwright Layer-3) ------------------------------
  // Runs the caller's OWN function against the CURRENT (already-rendered) DOM in a
  // node:vm context — not the live render isolate. Enough for DOM reads/measures
  // (document.title, querySelectorAll counts, attribute reads). The page's own JS
  // already ran during render (jsRenderer); this does not re-enter that context.

  #evalContext() {
    const win = this.window;
    const sandbox = { window: win, document: this.document, navigator: win.navigator, console };
    sandbox.globalThis = sandbox;
    return vm.createContext(sandbox);
  }

  #callFn(fn, args) {
    const sandbox = this.#evalContext();
    sandbox.__args = args;
    return vm.runInContext(`(${fn.toString()}).apply(null, __args)`, sandbox);
  }

  /** Evaluate a function (or expression string) against the current DOM. */
  evaluate(pageFunction, ...args) {
    if (typeof pageFunction === "function") return this.#callFn(pageFunction, args);
    return vm.runInContext(String(pageFunction), this.#evalContext());
  }

  /** Evaluate `fn(element, ...args)` against the first match of `selector`. */
  $eval(selector, fn, ...args) {
    const el = this.document.querySelector(selector);
    if (!el) throw new Error(`turbo-crawl: $eval found no element for "${selector}"`);
    return this.#callFn(fn, [el, ...args]);
  }

  /** Evaluate `fn(elements, ...args)` against all matches of `selector`. */
  $$eval(selector, fn, ...args) {
    return this.#callFn(fn, [[...this.document.querySelectorAll(selector)], ...args]);
  }

  /**
   * Mine server-embedded hydration state (Next/Nuxt/Apollo/JSON-LD/…) without
   * executing any JS — recovers most "SPA" data straight from inline scripts.
   */
  hydrationState() {
    return extractHydrationState(this.document);
  }

  /**
   * Query the page by CSS selector or XPath; returns the matched subtree(s) as
   * `{ node, html, text }` (XPath `@attr` steps yield `{ value }`).
   * @param {string} selector  CSS selector or XPath expression
   * @param {{type?:"auto"|"css"|"xpath", first?:boolean}} [opts]
   */
  query(selector, opts) {
    return query(this.document, selector, opts);
  }

  // --- locators (Playwright-style addressing) -------------------------------

  /** Locator for a CSS selector. */
  locator(selector) {
    return new Locator(this, byCss(selector));
  }
  /** Locator by ARIA role, optionally filtered by accessible name. */
  getByRole(role, opts) {
    return new Locator(this, byRole(role, opts));
  }
  /** Locator by (innermost) visible text. */
  getByText(text, opts) {
    return new Locator(this, byText(text, opts));
  }
  /** Locator for the control associated with a <label>. */
  getByLabel(text, opts) {
    return new Locator(this, byLabel(text, opts));
  }
  getByPlaceholder(text, opts) {
    return new Locator(this, byAttrText("placeholder", text, opts));
  }
  getByTestId(testId) {
    return new Locator(this, byCss(`[data-testid="${testId}"]`));
  }
  getByAltText(text, opts) {
    return new Locator(this, byAttrText("alt", text, opts));
  }
  getByTitle(text, opts) {
    return new Locator(this, byAttrText("title", text, opts));
  }

  // --- interaction (SPEC §6) ------------------------------------------------

  #record(i) {
    const snap = this.#snapshot ?? this.interactiveElements();
    const rec = snap[i];
    if (!rec) throw new Error(`turbo-crawl: no interactive element [${i}]`);
    return rec;
  }

  // Deref a record's WeakRef to the live node; throws if it was collected (stale
  // snapshot, e.g. used after a navigation reset the env).
  #node(rec) {
    const el = rec.ref.deref();
    if (!el) throw new Error("turbo-crawl: stale element handle (re-query after navigation)");
    return el;
  }

  /**
   * Activate element `i`. Links → navigate. Submit controls → submit the owning
   * form. Inert (jsHandler) elements throw — surface honestly (SPEC §6).
   */
  async click(i, opts = {}) {
    const rec = this.#record(i);
    if (rec.href) return this.goto(rec.href, opts);
    return this.clickElement(this.#node(rec), opts);
  }

  /**
   * Activate a DOM element (locator-backing): <a href> navigates, submit controls
   * submit their owning form, anything else is inert in Lane A → throws.
   */
  async clickElement(el, opts = {}) {
    const href = anchorHref(el, this.#url);
    if (href) return this.goto(href, opts);
    const form = isSubmitControl(el) ? el.closest("form") : null;
    if (form) return this.#submitForm(form, el, opts);
    throw new Error("turbo-crawl: element is inert in Lane A (no native navigation)");
  }

  /** Submit the form owning `el` (used by click + locator.press). */
  async submitFromElement(el, opts = {}) {
    const form = el.closest("form");
    if (!form) throw new Error("turbo-crawl: element has no owning form");
    const submitter = isSubmitControl(el) ? el : undefined;
    return this.#submitForm(form, submitter, opts);
  }

  /** Set the value of form control `i` in the COW overlay (no navigation). */
  fill(i, value) {
    fillValue(this.#node(this.#record(i)), value);
    return { ok: true };
  }

  /**
   * Submit a form. With no arg, submits the form owning the last filled/first
   * control; pass an element index to submit that control's owning form.
   */
  async submit(i, opts = {}) {
    let form;
    let submitter;
    if (i === undefined) {
      form = this.document.querySelector("form");
    } else {
      const el = this.#node(this.#record(i));
      form = el.closest("form");
      const type = el.getAttribute("type")?.toLowerCase();
      if (type === "submit" || el.tagName.toLowerCase() === "button") submitter = el;
    }
    if (!form) throw new Error("turbo-crawl: no form to submit");
    return this.#submitForm(form, submitter, opts);
  }

  async #submitForm(form, submitter, opts) {
    const sub = buildSubmission(form, this.#url, submitter);
    const fetchOpts = { ...opts };
    if (sub.method === "POST") {
      fetchOpts.method = "POST";
      fetchOpts.body = sub.body;
      fetchOpts.headers = { "content-type": sub.contentType, ...opts.headers };
    }
    return this.#load(await this.#fetch(sub.url, fetchOpts));
  }
}
