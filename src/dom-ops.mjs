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
