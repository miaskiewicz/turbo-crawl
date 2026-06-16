// Page — a single navigable context. Owns ONE turbo-dom env for its lifetime and
// resets it per hop (SPEC §3.2: navigation = re-parse, not re-render). The unit an
// agent drives.

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { buildSubmission, fillValue } from "./actions.mjs";
import { accessibilityTree } from "./ax.mjs";
import { CookieJar } from "./cookies.mjs";
import { interactiveElements, links } from "./extract.mjs";
import { markdown } from "./markdown.mjs";
import { fetchHtml } from "./net.mjs";
import { extractSchema } from "./schema.mjs";
import { text } from "./text.mjs";
import { isHttpUrl, resolve } from "./url.mjs";

export class Page {
  #env = null;
  #fetchHtml;
  #jar;
  #url = null;
  #status = 0;
  #snapshot = null; // last interactiveElements() result: index → record (with .ref)

  /**
   * @param {object} [opts]
   * @param {typeof fetchHtml} [opts.fetchHtml]  injectable fetcher (tests / Lane B)
   * @param {CookieJar} [opts.jar]               shared cookie jar (default: fresh)
   */
  constructor(opts = {}) {
    this.#fetchHtml = opts.fetchHtml ?? fetchHtml;
    this.#jar = opts.jar ?? new CookieJar();
  }

  /** The Page's cookie jar (session state across hops). */
  get cookies() {
    return this.#jar;
  }

  // Fetch with the session jar attached, so cookies round-trip across hops.
  #fetch(url, opts = {}) {
    return this.#fetchHtml(url, { jar: this.#jar, ...opts });
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
  #load({ html, finalUrl, status }) {
    if (this.#env) this.#env.reset(html);
    else this.#env = createEnvironment(html);
    this.#url = finalUrl;
    this.#status = status;
    this.#snapshot = null;
    return { status, url: finalUrl, title: this.title() };
  }

  /** Follow an (absolute or relative) href against the current page. */
  async follow(href, opts = {}) {
    const abs = resolve(this.#url, href);
    if (!abs || !isHttpUrl(abs)) throw new Error(`turbo-crawl: not a navigable URL: ${href}`);
    return this.goto(abs, opts);
  }

  // --- queries --------------------------------------------------------------

  title() {
    const el = this.document.querySelector("title");
    return el ? el.textContent.trim() : "";
  }

  /** Indexed interactive elements (SPEC §7.1); also refreshes the action snapshot. */
  interactiveElements() {
    this.#snapshot = interactiveElements(this.document, this.#url, this.window);
    return this.#snapshot;
  }

  links() {
    return links(this.document, this.#url);
  }

  /**
   * Serialized HTML of the current DOM. In Lane A this is the fetched/parsed
   * markup; behind the Playwright adapter (Lane B) it is the *rendered* DOM after
   * the page's init JS has run — so an SPA shell comes back fully populated.
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

  // --- interaction (SPEC §6) ------------------------------------------------

  #record(i) {
    const snap = this.#snapshot ?? this.interactiveElements();
    const rec = snap[i];
    if (!rec) throw new Error(`turbo-crawl: no interactive element [${i}]`);
    return rec;
  }

  /**
   * Activate element `i`. Links → navigate. Submit controls → submit the owning
   * form. Inert (jsHandler) elements throw — surface honestly (SPEC §6).
   */
  async click(i, opts = {}) {
    const rec = this.#record(i);
    if (rec.href) return this.goto(rec.href, opts);

    const el = rec.ref;
    const type = el.getAttribute("type")?.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (type === "submit" || (tag === "button" && type !== "button")) {
      const form = el.closest("form");
      if (form) return this.#submitForm(form, el, opts);
    }
    throw new Error(
      `turbo-crawl: element [${i}] is inert in Lane A (no native navigation; jsHandler=${rec.jsHandler})`,
    );
  }

  /** Set the value of form control `i` in the COW overlay (no navigation). */
  fill(i, value) {
    fillValue(this.#record(i).ref, value);
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
      const el = this.#record(i).ref;
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
