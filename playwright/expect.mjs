// Web-first assertions (`expect(...)`), a drop-in for `@playwright/test`'s expect
// evaluated against turbo-crawl's static DOM. `expect(x)` dispatches by argument:
//   Locator      → LocatorAssertions     (toBeVisible, toHaveText, …)
//   PWResponse   → APIResponseAssertions  (toBeOK)
//   PWPage       → PageAssertions         (toHaveTitle, toHaveURL, …)
//   anything else → generic value matchers (toBe, toEqual, …)
// Every class supports `.not`. No auto-retry — nothing changes without JS, so a
// matcher is evaluated once. Matchers needing a real rendering engine (geometry,
// computed style, pixels) throw a clear error — see README "Unsupported
// Playwright assertions".

import { isDeepStrictEqual } from "node:util";

import { matchesAriaSnapshot } from "../src/aria-snapshot.mjs";
import { Locator } from "../src/locator.mjs";
import { PWResponse } from "./net-events.mjs";

// --- shared matching helpers ------------------------------------------------

function eqOrRe(actual, expected) {
  return expected instanceof RegExp ? expected.test(actual) : actual === expected;
}

function containsOrRe(actual, expected) {
  return expected instanceof RegExp ? expected.test(actual) : actual.includes(expected);
}

function listEvery(actuals, expected, fn) {
  if (actuals.length !== expected.length) return false;
  return expected.every((e, i) => fn(actuals[i], e));
}

function matchTextual(loc, expected, fn) {
  if (Array.isArray(expected)) return listEvery(loc.allTextContents(), expected, fn);
  return fn(loc.textContent(), expected);
}

function classesOf(loc) {
  return loc.elements().map((el) => el.getAttribute("class") ?? "");
}

function classOf(loc) {
  return loc.getAttribute("class") ?? "";
}

function tokens(s) {
  return new Set(s.split(/\s+/).filter(Boolean));
}

function classHasAll(classAttr, wanted) {
  const have = tokens(classAttr);
  return [...tokens(wanted)].every((t) => have.has(t));
}

function matchClass(loc, expected) {
  if (Array.isArray(expected)) return listEvery(classesOf(loc), expected, eqOrRe);
  return eqOrRe(classOf(loc), expected);
}

function matchContainClass(loc, expected) {
  if (Array.isArray(expected)) return listEvery(classesOf(loc), expected, classHasAll);
  return classHasAll(classOf(loc), expected);
}

function matchUrl(actual, expected) {
  if (typeof expected === "function") return Boolean(expected(new URL(actual)));
  return eqOrRe(actual, expected);
}

function renderOnly(name) {
  return new Error(
    `turbo-crawl: expect(...).${name}() needs a pixel renderer to rasterize the ` +
      "page, which the no-Chromium DOM engine does not have — see " +
      'README "Unsupported Playwright assertions".',
  );
}

// --- locator assertions -----------------------------------------------------

class LocatorAssertions {
  #loc;
  #neg;

  constructor(loc, neg = false) {
    this.#loc = loc;
    this.#neg = neg;
  }

  get not() {
    return new LocatorAssertions(this.#loc, !this.#neg);
  }

  _received() {
    return this.#loc;
  }
  _neg() {
    return this.#neg;
  }

  #check(ok, message) {
    if (ok === this.#neg) {
      throw new Error(`expect(locator)${this.#neg ? ".not" : ""}.${message} failed`);
    }
  }

  async toBeAttached(opts = {}) {
    this.#check(this.#loc.count() > 0 === (opts.attached !== false), "toBeAttached()");
  }
  async toBeVisible(opts = {}) {
    this.#check(this.#loc.isVisible() === (opts.visible !== false), "toBeVisible()");
  }
  async toBeHidden() {
    this.#check(!this.#loc.isVisible(), "toBeHidden()");
  }
  async toBeChecked(opts = {}) {
    this.#check(this.#loc.isChecked() === (opts.checked !== false), "toBeChecked()");
  }
  async toBeEnabled(opts = {}) {
    this.#check(this.#loc.isEnabled() === (opts.enabled !== false), "toBeEnabled()");
  }
  async toBeDisabled() {
    this.#check(!this.#loc.isEnabled(), "toBeDisabled()");
  }
  async toBeEditable(opts = {}) {
    this.#check(this.#loc.isEditable() === (opts.editable !== false), "toBeEditable()");
  }
  async toBeEmpty() {
    this.#check(this.#loc.isEmpty(), "toBeEmpty()");
  }
  async toBeFocused() {
    this.#check(this.#loc.isFocused(), "toBeFocused()");
  }
  async toHaveCount(n) {
    this.#check(this.#loc.count() === n, "toHaveCount()");
  }
  async toHaveRole(role) {
    this.#check(this.#loc.ariaRole() === role, "toHaveRole()");
  }
  async toHaveId(expected) {
    this.#check(eqOrRe(this.#loc.getAttribute("id") ?? "", expected), "toHaveId()");
  }
  async toHaveText(expected) {
    this.#check(matchTextual(this.#loc, expected, eqOrRe), "toHaveText()");
  }
  async toContainText(expected) {
    this.#check(matchTextual(this.#loc, expected, containsOrRe), "toContainText()");
  }
  async toHaveValue(expected) {
    this.#check(eqOrRe(this.#loc.inputValue(), expected), "toHaveValue()");
  }
  async toHaveValues(expected) {
    this.#check(listEvery(this.#loc.selectedValues(), expected, eqOrRe), "toHaveValues()");
  }
  async toHaveClass(expected) {
    this.#check(matchClass(this.#loc, expected), "toHaveClass()");
  }
  async toContainClass(expected) {
    this.#check(matchContainClass(this.#loc, expected), "toContainClass()");
  }
  async toHaveAccessibleName(expected) {
    this.#check(eqOrRe(this.#loc.accessibleName(), expected), "toHaveAccessibleName()");
  }
  async toHaveAccessibleDescription(expected) {
    this.#check(
      eqOrRe(this.#loc.accessibleDescription(), expected),
      "toHaveAccessibleDescription()",
    );
  }
  async toHaveAccessibleErrorMessage(expected) {
    this.#check(
      eqOrRe(this.#loc.accessibleErrorMessage(), expected),
      "toHaveAccessibleErrorMessage()",
    );
  }
  async toHaveJSProperty(name, value) {
    this.#check(isDeepStrictEqual(this.#loc.jsProperty(name), value), "toHaveJSProperty()");
  }
  async toHaveAttribute(name, expected) {
    const actual = this.#loc.getAttribute(name);
    const ok =
      expected === undefined ? actual !== null : actual !== null && eqOrRe(actual, expected);
    this.#check(ok, "toHaveAttribute()");
  }
  async toMatchAriaSnapshot(expected) {
    const root = this.#loc.elements()[0];
    this.#check(root != null && matchesAriaSnapshot(root, expected), "toMatchAriaSnapshot()");
  }
  async toBeInViewport(opts = {}) {
    const ratio = opts.ratio ?? 0;
    const frac = this.#loc.viewportRatio();
    this.#check(ratio > 0 ? frac >= ratio : frac > 0, "toBeInViewport()");
  }
  async toHaveCSS(name, expected) {
    this.#check(eqOrRe(this.#loc.cssValue(name), expected), "toHaveCSS()");
  }
  async toHaveScreenshot() {
    throw renderOnly("toHaveScreenshot");
  }
}

// --- page assertions --------------------------------------------------------

class PageAssertions {
  #page;
  #neg;

  constructor(page, neg = false) {
    this.#page = page;
    this.#neg = neg;
  }

  get not() {
    return new PageAssertions(this.#page, !this.#neg);
  }

  _received() {
    return this.#page;
  }
  _neg() {
    return this.#neg;
  }

  #check(ok, message) {
    if (ok === this.#neg) {
      throw new Error(`expect(page)${this.#neg ? ".not" : ""}.${message} failed`);
    }
  }

  async toHaveTitle(expected) {
    this.#check(eqOrRe(await this.#page.title(), expected), "toHaveTitle()");
  }
  async toHaveURL(expected) {
    this.#check(matchUrl(this.#page.url(), expected), "toHaveURL()");
  }
  async toMatchAriaSnapshot(expected) {
    const root = this.#page.locator("body").elements()[0];
    this.#check(root != null && matchesAriaSnapshot(root, expected), "toMatchAriaSnapshot()");
  }
  async toHaveScreenshot() {
    throw renderOnly("toHaveScreenshot");
  }
}

// --- API-response assertions ------------------------------------------------

class APIResponseAssertions {
  #res;
  #neg;

  constructor(res, neg = false) {
    this.#res = res;
    this.#neg = neg;
  }

  get not() {
    return new APIResponseAssertions(this.#res, !this.#neg);
  }

  _received() {
    return this.#res;
  }
  _neg() {
    return this.#neg;
  }

  #check(ok, message) {
    if (ok === this.#neg) {
      throw new Error(`expect(response)${this.#neg ? ".not" : ""}.${message} failed`);
    }
  }

  async toBeOK() {
    this.#check(this.#res.ok(), "toBeOK()");
  }
}

// --- generic value assertions (jest-style) ----------------------------------

function toRegExp(re) {
  return re instanceof RegExp ? re : new RegExp(re);
}

function digPath(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || !(k in Object(cur))) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

function hasProperty(obj, path, rest) {
  const keys = Array.isArray(path) ? path : String(path).split(".");
  const { found, value } = digPath(obj, keys);
  if (!found) return false;
  return rest.length ? isDeepStrictEqual(value, rest[0]) : true;
}

function matchField(a, e) {
  if (e && typeof e === "object" && !Array.isArray(e)) return matchObject(a, e);
  return isDeepStrictEqual(a, e);
}

function matchObject(actual, expected) {
  if (actual == null || typeof actual !== "object") return false;
  return Object.keys(expected).every((k) => matchField(actual[k], expected[k]));
}

function catchError(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

function matchThrown(err, expected) {
  if (expected == null) return true;
  if (expected instanceof RegExp) return expected.test(err.message);
  if (typeof expected === "string") return err.message.includes(expected);
  return err instanceof expected;
}

// `received` is either a function to invoke (`expect(fn).toThrow()`) or an already
// thrown/rejected error (`expect(p).rejects.toThrow()`).
function thrownError(received) {
  if (typeof received === "function") return catchError(received);
  return received instanceof Error ? received : null;
}

function throws(received, expected) {
  const err = thrownError(received);
  return err ? matchThrown(err, expected) : false;
}

class ValueAssertions {
  #v;
  #neg;

  constructor(v, neg = false) {
    this.#v = v;
    this.#neg = neg;
  }

  get not() {
    return new ValueAssertions(this.#v, !this.#neg);
  }
  get resolves() {
    return settleProxy(this.#v, this.#neg, false);
  }
  get rejects() {
    return settleProxy(this.#v, this.#neg, true);
  }

  _received() {
    return this.#v;
  }
  _neg() {
    return this.#neg;
  }

  #check(ok, message) {
    if (ok === this.#neg) {
      throw new Error(`expect(received)${this.#neg ? ".not" : ""}.${message} failed`);
    }
  }

  toBe(e) {
    this.#check(Object.is(this.#v, e), "toBe()");
  }
  toEqual(e) {
    this.#check(isDeepStrictEqual(this.#v, e), "toEqual()");
  }
  toStrictEqual(e) {
    this.#check(isDeepStrictEqual(this.#v, e), "toStrictEqual()");
  }
  toBeTruthy() {
    this.#check(Boolean(this.#v), "toBeTruthy()");
  }
  toBeFalsy() {
    this.#check(!this.#v, "toBeFalsy()");
  }
  toBeNull() {
    this.#check(this.#v === null, "toBeNull()");
  }
  toBeDefined() {
    this.#check(this.#v !== undefined, "toBeDefined()");
  }
  toBeUndefined() {
    this.#check(this.#v === undefined, "toBeUndefined()");
  }
  toBeNaN() {
    this.#check(Number.isNaN(this.#v), "toBeNaN()");
  }
  toBeGreaterThan(e) {
    this.#check(this.#v > e, "toBeGreaterThan()");
  }
  toBeGreaterThanOrEqual(e) {
    this.#check(this.#v >= e, "toBeGreaterThanOrEqual()");
  }
  toBeLessThan(e) {
    this.#check(this.#v < e, "toBeLessThan()");
  }
  toBeLessThanOrEqual(e) {
    this.#check(this.#v <= e, "toBeLessThanOrEqual()");
  }
  toBeCloseTo(e, precision = 2) {
    this.#check(Math.abs(this.#v - e) < 10 ** -precision / 2, "toBeCloseTo()");
  }
  toContain(e) {
    this.#check(this.#v.includes(e), "toContain()");
  }
  toContainEqual(e) {
    this.#check(
      this.#v.some((x) => isDeepStrictEqual(x, e)),
      "toContainEqual()",
    );
  }
  toHaveLength(n) {
    this.#check(this.#v.length === n, "toHaveLength()");
  }
  toMatch(re) {
    this.#check(toRegExp(re).test(this.#v), "toMatch()");
  }
  toBeInstanceOf(ctor) {
    this.#check(this.#v instanceof ctor, "toBeInstanceOf()");
  }
  toHaveProperty(path, ...rest) {
    this.#check(hasProperty(this.#v, path, rest), "toHaveProperty()");
  }
  toMatchObject(o) {
    this.#check(matchObject(this.#v, o), "toMatchObject()");
  }
  toThrow(e) {
    this.#check(throws(this.#v, e), "toThrow()");
  }
  toThrowError(e) {
    this.#check(throws(this.#v, e), "toThrowError()");
  }
}

// resolves/rejects: await the promise, then apply any matcher to its outcome.
async function settle(promise, wantReject) {
  try {
    const v = await promise;
    if (wantReject) throw new Error("expected promise to reject");
    return v;
  } catch (e) {
    if (!wantReject) throw e;
    return e;
  }
}

function settleProxy(promise, neg, wantReject) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "not") return settleProxy(promise, !neg, wantReject);
        return async (...args) =>
          new ValueAssertions(await settle(promise, wantReject), neg)[prop](...args);
      },
    },
  );
}

// expect.poll(fn): apply a matcher to fn()'s (awaited) return value.
function pollProxy(produce, neg) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "not") return pollProxy(produce, !neg);
        return async (...args) => new ValueAssertions(await produce(), neg)[prop](...args);
      },
    },
  );
}

// --- dispatch + statics -----------------------------------------------------

function isPage(x) {
  return Boolean(x) && typeof x.title === "function" && typeof x.url === "function";
}

function classify(x) {
  if (x instanceof Locator) return new LocatorAssertions(x);
  if (x instanceof PWResponse) return new APIResponseAssertions(x);
  if (isPage(x)) return new PageAssertions(x);
  return new ValueAssertions(x);
}

const ASSERTION_CLASSES = [
  LocatorAssertions,
  PageAssertions,
  APIResponseAssertions,
  ValueAssertions,
];

function defineCustom(name, fn) {
  function custom(...args) {
    const { pass, message } = fn(this._received(), ...args);
    if (pass === this._neg()) {
      throw new Error(typeof message === "function" ? message() : `${name} failed`);
    }
  }
  for (const Cls of ASSERTION_CLASSES) Cls.prototype[name] = custom;
}

/** Playwright-style web-first assertions over turbo-crawl objects or values. */
export function expect(x) {
  return classify(x);
}

// `expect.soft` has no deferred aggregation without a test runner, so it throws
// like `expect`. `configure` ignores timeout/intervals (matchers run once).
expect.soft = expect;
expect.configure = () => expect;
expect.poll = (fn) => pollProxy(fn, false);
expect.extend = (matchers) => {
  for (const [name, fn] of Object.entries(matchers)) defineCustom(name, fn);
};
