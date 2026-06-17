// Element-level read/write helpers backing the Playwright-style accessors and
// locator actions. Pure DOM (no navigation, no window) except isVisibleEl.

import { isVisible } from "./visible.mjs";

export function textOf(el) {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function innerHTMLOf(el) {
  return el.innerHTML ?? "";
}

export function attrOf(el, name) {
  return el.getAttribute(name);
}

export function inputValueOf(el) {
  const v = el.value;
  return v == null ? "" : String(v);
}

export function isEnabledEl(el) {
  return el.getAttribute("disabled") === null;
}

export function isCheckedEl(el) {
  return Boolean(el.checked);
}

// Tags Playwright treats as editable (when enabled and not readonly).
const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditableEl(el) {
  if (el.isContentEditable) return true;
  if (!EDITABLE_TAGS.has(el.tagName)) return false;
  return isEnabledEl(el) && el.getAttribute("readonly") === null;
}

// Playwright `toBeEmpty`: no text and no element children.
export function isEmptyEl(el) {
  return textOf(el) === "" && (el.children?.length ?? 0) === 0;
}

// An <option>'s submitted value: explicit `value` attr, else its label text.
function optionValue(opt) {
  const v = opt.getAttribute("value");
  return v == null ? textOf(opt) : v;
}

// Selected values of a (possibly multiple) <select>, in document order.
export function selectedValuesOf(el) {
  const out = [];
  const opts = el.querySelectorAll("option");
  for (let i = 0; i < opts.length; i++) {
    if (opts[i].selected) out.push(optionValue(opts[i]));
  }
  return out;
}

// JS/IDL property read backing Playwright `toHaveJSProperty` (DOM IDL props only;
// page-script-assigned expandos aren't present in Lane A).
export function jsPropOf(el, name) {
  return el[name];
}

// Computed CSS value (turbo-dom resolves the real cascade) backing `toHaveCSS`.
export function cssValueOf(el, window, name) {
  return window.getComputedStyle(el).getPropertyValue(name);
}

// Fraction of an element's box inside the viewport (0..1), backing `toBeInViewport`.
// Geometry is turbo-dom's approximate flow (no real paint), good enough for the
// in/out-of-viewport question Playwright's matcher asks.
export function viewportRatioOf(el, window) {
  const r = el.getBoundingClientRect();
  const area = r.width * r.height;
  if (area <= 0) return 0;
  const ix = Math.max(0, Math.min(r.left + r.width, window.innerWidth) - Math.max(r.left, 0));
  const iy = Math.max(0, Math.min(r.top + r.height, window.innerHeight) - Math.max(r.top, 0));
  return (ix * iy) / area;
}

export function isVisibleEl(el, window) {
  return isVisible(el, window);
}

export function setChecked(el, on) {
  el.checked = Boolean(on);
}

/**
 * Select <option>(s) of a <select> by value or visible label. Returns true if
 * any option matched.
 */
export function selectOption(el, value) {
  const opts = el.querySelectorAll("option");
  let matched = false;
  for (let i = 0; i < opts.length; i++) {
    const hit = opts[i].getAttribute("value") === value || opts[i].textContent.trim() === value;
    opts[i].selected = hit;
    if (hit) matched = true;
  }
  return matched;
}
