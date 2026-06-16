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

function implicitRole(tag, type) {
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "textbox";
  }
  return IMPLICIT_ROLE[tag] ?? "generic";
}

// Accessible name, cheap heuristic: aria-label > text > placeholder > value > title.
function accessibleName(el) {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const text = el.textContent;
  if (text) {
    const t = text.trim();
    if (t) return t;
  }
  return (
    el.getAttribute("placeholder")?.trim() ||
    el.getAttribute("value")?.trim() ||
    el.getAttribute("title")?.trim() ||
    ""
  );
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
 *   href?:string,type?:string,visible:boolean,jsHandler:boolean,ref:object}>}
 */
export function interactiveElements(document, baseUrl, window, options) {
  const checkVisible = window != null && options?.visibility !== false;
  const nodes = document.querySelectorAll(INTERACTIVE_SELECTOR);
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type")?.toLowerCase() ?? undefined;

    const rawHref = tag === "a" ? el.getAttribute("href") : null;
    const href = rawHref ? (resolve(baseUrl, rawHref) ?? undefined) : undefined;

    // Native navigation = <a href> or a submit control; anything else carrying an
    // onclick has a JS handler we cannot fire in Lane A → flag it, do not drop it.
    const nativeNav = href !== undefined || type === "submit";
    const jsHandler = !nativeNav && el.getAttribute("onclick") !== null;

    out.push({
      i: out.length,
      tag,
      role: el.getAttribute("role") ?? implicitRole(tag, type),
      name: accessibleName(el),
      value: el.getAttribute("value") ?? undefined,
      href,
      type,
      visible: checkVisible ? isVisible(el, window) : true,
      jsHandler,
      ref: el,
    });
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
