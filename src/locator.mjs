// Locators (Playwright-style addressing) over a turbo-dom document. A Locator is
// lazy: it resolves against the page's *current* document at call time, so it
// survives re-navigation. Resolvers below build the element set; the Locator wraps
// it with chaining + accessors + actions. No JS execution — pure DOM.

import { fillValue } from "./actions.mjs";
import { accessibleDescription, accessibleErrorMessage, accessibleName, roleOf } from "./aria.mjs";
import {
  attrOf,
  cssValueOf,
  innerHTMLOf,
  inputValueOf,
  isCheckedEl,
  isEditableEl,
  isEmptyEl,
  isEnabledEl,
  isVisibleEl,
  jsPropOf,
  selectOption,
  selectedValuesOf,
  setChecked,
  textOf,
  viewportRatioOf,
} from "./dom-ops.mjs";

// --- text matching ---------------------------------------------------------

function textMatch(value, want, exact) {
  const v = (value ?? "").trim();
  if (want instanceof RegExp) return want.test(v);
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

// Resolve by id without a CSS selector: `useId()` ids like ":r0:" contain colons
// that are invalid in a `#id` selector (querySelector throws). Prefer the DOM's
// own getElementById (handles any id); fall back to an attribute scan.
function scanById(root, id) {
  const withId = root.querySelectorAll("[id]");
  for (let i = 0; i < withId.length; i++) {
    if (withId[i].getAttribute("id") === id) return withId[i];
  }
  return null;
}

function byId(root, id) {
  return root.getElementById ? root.getElementById(id) : scanById(root, id);
}

function pushUnique(out, el) {
  if (el && !out.includes(el)) out.push(el);
}

// Controls referencing `id` via aria-labelledby (a space-separated id list, so
// `~=` matches one token). The value is quoted, so colon `useId()` ids are safe
// here even though `#:r0:` is not a valid id selector.
function byAriaLabelledBy(root, id) {
  return [...root.querySelectorAll(`[aria-labelledby~="${id}"]`)];
}

// Every control a matching <label> labels: `for=`/id, aria-labelledby back-refs
// (MUI/React), and a wrapped input. Playwright's getByLabel covers all of these.
function collectLabelTargets(label, root, out) {
  const forId = label.getAttribute("for");
  if (forId) pushUnique(out, byId(root, forId));
  const id = label.getAttribute("id");
  if (id) for (const el of byAriaLabelledBy(root, id)) pushUnique(out, el);
  pushUnique(out, label.querySelector("input,select,textarea"));
}

function addLabelMatches(root, want, opts, out) {
  const labels = root.querySelectorAll("label");
  for (let i = 0; i < labels.length; i++) {
    if (textMatch(labels[i].textContent, want, opts.exact))
      collectLabelTargets(labels[i], root, out);
  }
}

// A control's own aria-label is a label too (no <label> element involved).
function addAriaLabelMatches(root, want, opts, out) {
  const els = root.querySelectorAll("[aria-label]");
  for (let i = 0; i < els.length; i++) {
    if (textMatch(els[i].getAttribute("aria-label"), want, opts.exact)) pushUnique(out, els[i]);
  }
}

export function byLabel(want, opts = {}) {
  return (root) => {
    const out = [];
    addLabelMatches(root, want, opts, out);
    addAriaLabelMatches(root, want, opts, out);
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
  isEditable() {
    return isEditableEl(this.#firstEl());
  }
  isEmpty() {
    return isEmptyEl(this.#firstEl());
  }
  isFocused() {
    const els = this.elements();
    return els.length > 0 && this.#page.document.activeElement === els[0];
  }
  ariaRole() {
    return roleOf(this.#firstEl());
  }
  accessibleName() {
    return accessibleName(this.#firstEl());
  }
  accessibleDescription() {
    return accessibleDescription(this.#firstEl());
  }
  accessibleErrorMessage() {
    return accessibleErrorMessage(this.#firstEl());
  }
  selectedValues() {
    return selectedValuesOf(this.#firstEl());
  }
  jsProperty(name) {
    return jsPropOf(this.#firstEl(), name);
  }
  cssValue(name) {
    return cssValueOf(this.#firstEl(), this.#page.window, name);
  }
  viewportRatio() {
    return viewportRatioOf(this.#firstEl(), this.#page.window);
  }
  allTextContents() {
    return this.elements().map((el) => textOf(el));
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

  // The DOM is static per render: a state either already holds (resolve now) or
  // never will without JS (throw — there's nothing to wait for). Mirrors the
  // Playwright states; timeout/polling are no-ops here.
  async waitFor(opts = {}) {
    const state = opts.state ?? "visible";
    const holds = WAIT_STATES[state] ?? WAIT_STATES.visible;
    if (holds(this)) return;
    throw new Error(`turbo-crawl: locator.waitFor(state=${state}) not satisfied (static DOM)`);
  }
}

const WAIT_STATES = {
  attached: (loc) => loc.count() > 0,
  detached: (loc) => loc.count() === 0,
  hidden: (loc) => !loc.isVisible(),
  visible: (loc) => loc.isVisible(),
};
