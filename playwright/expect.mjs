// Web-first assertions subset (Playwright `expect(locator)`), evaluated against
// turbo-crawl's static DOM — no auto-retry (nothing changes without JS). Supports
// `.not`. Throws on mismatch like Playwright's expect.

class LocatorAssertions {
  #loc;
  #neg;

  constructor(loc, neg = false) {
    this.#loc = loc;
    this.#neg = neg;
  }

  /** Negated assertions: expect(loc).not.toBeVisible(). */
  get not() {
    return new LocatorAssertions(this.#loc, !this.#neg);
  }

  // Fail when the outcome doesn't match the (possibly negated) expectation.
  #check(ok, message) {
    if (ok === this.#neg) {
      throw new Error(`expect(locator)${this.#neg ? ".not" : ""}.${message} failed`);
    }
  }

  async toBeVisible() {
    this.#check(this.#loc.isVisible(), "toBeVisible()");
  }
  async toBeHidden() {
    this.#check(!this.#loc.isVisible(), "toBeHidden()");
  }
  async toBeChecked() {
    this.#check(this.#loc.isChecked(), "toBeChecked()");
  }
  async toBeEnabled() {
    this.#check(this.#loc.isEnabled(), "toBeEnabled()");
  }
  async toBeDisabled() {
    this.#check(!this.#loc.isEnabled(), "toBeDisabled()");
  }
  async toHaveText(text) {
    this.#check(this.#loc.textContent() === text, `toHaveText(${text})`);
  }
  async toContainText(text) {
    this.#check(this.#loc.textContent().includes(text), `toContainText(${text})`);
  }
  async toHaveValue(value) {
    this.#check(this.#loc.inputValue() === value, `toHaveValue(${value})`);
  }
  async toHaveCount(n) {
    this.#check(this.#loc.count() === n, `toHaveCount(${n})`);
  }
  async toHaveAttribute(name, value) {
    this.#check(this.#loc.getAttribute(name) === value, `toHaveAttribute(${name})`);
  }
}

/** Playwright-style web-first assertions over a turbo-crawl Locator. */
export function expect(locator) {
  return new LocatorAssertions(locator);
}
