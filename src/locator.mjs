// Locators (Playwright-style addressing) over a turbo-dom document. A Locator is
// lazy: it resolves against the page's *current* document at call time, so it
// survives re-navigation. Resolvers below build the element set; the Locator wraps
// it with chaining + accessors + actions. No JS execution — pure DOM.

import { fillValue } from "./actions.mjs";
import { accessibleName, roleOf } from "./aria.mjs";
import {
  attrOf,
  innerHTMLOf,
  inputValueOf,
  isCheckedEl,
  isEnabledEl,
  isVisibleEl,
  selectOption,
  setChecked,
  textOf,
} from "./dom-ops.mjs";

// --- text matching ---------------------------------------------------------

function textMatch(value, want, exact) {
  const v = (value ?? "").trim();
  return exact ? v === want : v.toLowerCase().includes(String(want).toLowerCase());
}

// --- resolvers (root) => Element[] -----------------------------------------

export function byCss(selector) {
  return (root) => [...root.querySelectorAll(selector)];
}

function roleMatches(el, role, opts) {
  if (roleOf(el) !== role) return false;
  return opts.name == null || textMatch(accessibleName(el), opts.name, opts.exact);
}

export function byRole(role, opts = {}) {
  return (root) => collect(root.querySelectorAll("*"), (el) => roleMatches(el, role, opts));
}

function hasMatchingChild(el, want, exact) {
  const kids = el.querySelectorAll("*");
  for (let i = 0; i < kids.length; i++) {
    if (textMatch(textOf(kids[i]), want, exact)) return true;
  }
  return false;
}

export function byText(want, opts = {}) {
  // Innermost element whose text matches (no matching descendant).
  return (root) =>
    collect(
      root.querySelectorAll("*"),
      (el) => textMatch(textOf(el), want, opts.exact) && !hasMatchingChild(el, want, opts.exact),
    );
}

function labelTarget(label, root) {
  const forId = label.getAttribute("for");
  if (forId) return root.querySelector(`#${forId}`);
  return label.querySelector("input,select,textarea");
}

export function byLabel(want, opts = {}) {
  return (root) => {
    const out = [];
    const labels = root.querySelectorAll("label");
    for (let i = 0; i < labels.length; i++) {
      if (!textMatch(labels[i].textContent, want, opts.exact)) continue;
      const target = labelTarget(labels[i], root);
      if (target) out.push(target);
    }
    return out;
  };
}

export function byAttrText(attr, want, opts = {}) {
  return (root) =>
    collect(root.querySelectorAll(`[${attr}]`), (el) =>
      textMatch(attrOf(el, attr), want, opts.exact),
    );
}

// Shared filtered-collect over a NodeList.
function collect(nodes, pred) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    if (pred(nodes[i])) out.push(nodes[i]);
  }
  return out;
}

// --- Locator ---------------------------------------------------------------

export class Locator {
  #page;
  #resolve;

  constructor(page, resolve) {
    this.#page = page;
    this.#resolve = resolve;
  }

  /** All currently-matching elements (re-resolved against the live document). */
  elements() {
    return this.#resolve(this.#page.document);
  }

  count() {
    return this.elements().length;
  }

  #firstEl() {
    const els = this.elements();
    if (!els.length) throw new Error("turbo-crawl: locator matched no elements");
    return els[0];
  }

  #derive(transform) {
    return new Locator(this.#page, (root) => transform(this.#resolve(root)));
  }

  first() {
    return this.#derive((els) => els.slice(0, 1));
  }
  last() {
    return this.#derive((els) => els.slice(-1));
  }
  nth(n) {
    return this.#derive((els) => (els[n] ? [els[n]] : []));
  }
  filter({ hasText } = {}) {
    return this.#derive((els) => els.filter((el) => textOf(el).includes(hasText)));
  }
  locator(selector) {
    return new Locator(this.#page, () =>
      this.elements().flatMap((el) => [...el.querySelectorAll(selector)]),
    );
  }

  // accessors (first match)
  textContent() {
    return textOf(this.#firstEl());
  }
  innerText() {
    return textOf(this.#firstEl());
  }
  innerHTML() {
    return innerHTMLOf(this.#firstEl());
  }
  getAttribute(name) {
    return attrOf(this.#firstEl(), name);
  }
  inputValue() {
    return inputValueOf(this.#firstEl());
  }
  isVisible() {
    // An absent element is "not visible" (matches Playwright toBeHidden), so this
    // returns false on a zero-match locator rather than throwing.
    const els = this.elements();
    return els.length > 0 && isVisibleEl(els[0], this.#page.window);
  }
  isEnabled() {
    return isEnabledEl(this.#firstEl());
  }
  isChecked() {
    return isCheckedEl(this.#firstEl());
  }

  // actions
  click(opts) {
    return this.#page.clickElement(this.#firstEl(), opts);
  }
  fill(value) {
    fillValue(this.#firstEl(), value);
    return this;
  }
  type(value) {
    fillValue(this.#firstEl(), value);
    return this;
  }
  check() {
    setChecked(this.#firstEl(), true);
    return this;
  }
  uncheck() {
    setChecked(this.#firstEl(), false);
    return this;
  }
  selectOption(value) {
    selectOption(this.#firstEl(), value);
    return this;
  }
  press() {
    // Enter on a control → submit its owning form (the only no-JS key effect).
    return this.#page.submitFromElement(this.#firstEl());
  }
}
