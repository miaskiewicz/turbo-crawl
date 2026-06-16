// Extraction passes over a turbo-dom Document. Hot-path discipline (SPEC §3.1):
// one index loop over querySelectorAll results, no per-node allocation beyond the
// result record, no classList / regex per node.
//
// Phase 0: interactiveElements() + links(). markdown() / accessibilityTree() and
// cascade-based visibility land in Phase 1.

import { isHttpUrl, resolve } from "./url.mjs";
import { isVisible } from "./visible.mjs";

// Selection set for interactive elements (SPEC §7.1).
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=tab]",
  "[role=menuitem]",
  "[contenteditable]",
  "[tabindex]",
  "[onclick]",
].join(",");

// Implicit ARIA role for the common interactive tags (enough for Phase 0).
const IMPLICIT_ROLE = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
};

// Implicit role for <input> keyed by its `type` (default → textbox).
const INPUT_ROLE = {
  checkbox: "checkbox",
  radio: "radio",
  button: "button",
  submit: "button",
  reset: "button",
};

function implicitRole(tag, type) {
  if (tag === "input") return INPUT_ROLE[type] ?? "textbox";
  return IMPLICIT_ROLE[tag] ?? "generic";
}

// First trimmed, non-empty string produced by one of the candidate getters.
function firstNonEmpty(getters) {
  for (const get of getters) {
    const v = get();
    const t = v == null ? "" : v.trim();
    if (t) return t;
  }
  return "";
}

// Accessible name, cheap heuristic: aria-label > text > placeholder > value > title.
function accessibleName(el) {
  return firstNonEmpty([
    () => el.getAttribute("aria-label"),
    () => el.textContent,
    () => el.getAttribute("placeholder"),
    () => el.getAttribute("value"),
    () => el.getAttribute("title"),
  ]);
}

/**
 * Index the page's interactive elements into stable `[i]`-addressable records.
 *
 * @param {object} document  turbo-dom Document
 * @param {string} [baseUrl] absolute URL of the page, for resolving hrefs
 * @param {object} [window]  turbo-dom window; when given, `visible` is cascade-derived
 * @param {{visibility?:boolean}} [options]  set `visibility:false` to skip the
 *   cascade-based visibility pass (the hot-path cost is getComputedStyle); every
 *   record is then reported `visible:true`. Use when the caller doesn't read it.
 * @returns {Array<{i:number,tag:string,role:string,name:string,value?:string,
 *   href?:string,type?:string,visible:boolean,jsHandler:boolean,ref:WeakRef}>}
 */
// Absolute href for an <a>; undefined for non-anchors or unresolvable targets.
function hrefFor(el, tag, baseUrl) {
  const rawHref = tag === "a" ? el.getAttribute("href") : null;
  if (!rawHref) return undefined;
  return resolve(baseUrl, rawHref) ?? undefined;
}

// Native navigation = <a href> or a submit control; anything else carrying an
// onclick has a JS handler we cannot fire in Lane A → flag it, do not drop it.
function jsHandlerFor(el, href, type) {
  const nativeNav = href !== undefined || type === "submit";
  return !nativeNav && el.getAttribute("onclick") !== null;
}

function nullToUndefined(v) {
  return v ?? undefined;
}

// Build the `[i]`-addressable record for a single interactive element.
function toRecord(el, i, baseUrl, window, checkVisible) {
  const tag = el.tagName.toLowerCase();
  const type = nullToUndefined(el.getAttribute("type")?.toLowerCase());
  const href = hrefFor(el, tag, baseUrl);

  return {
    i,
    tag,
    role: el.getAttribute("role") ?? implicitRole(tag, type),
    name: accessibleName(el),
    value: nullToUndefined(el.getAttribute("value")),
    href,
    type,
    visible: checkVisible ? isVisible(el, window) : true,
    jsHandler: jsHandlerFor(el, href, type),
    // WeakRef (SPEC §7.1): the snapshot doesn't pin DOM nodes; the action layer
    // derefs and errors on a stale handle (e.g. used after a navigation).
    ref: new WeakRef(el),
  };
}

export function interactiveElements(document, baseUrl, window, options) {
  const checkVisible = window != null && options?.visibility !== false;
  const nodes = document.querySelectorAll(INTERACTIVE_SELECTOR);
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    out.push(toRecord(nodes[i], out.length, baseUrl, window, checkVisible));
  }
  return out;
}

/**
 * All absolute, navigable http(s) link targets on the page (deduped, in order).
 *
 * @param {object} document  turbo-dom Document
 * @param {string} [baseUrl]
 * @returns {string[]}
 */
export function links(document, baseUrl) {
  const anchors = document.querySelectorAll("a[href]");
  const seen = new Set();
  const out = [];
  for (let i = 0; i < anchors.length; i++) {
    const abs = resolve(baseUrl, anchors[i].getAttribute("href"));
    if (abs && isHttpUrl(abs) && !seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}
