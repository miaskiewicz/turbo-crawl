# `src/locator.mjs` — lazy Playwright-style locators over a turbo-dom document

## Responsibility
Addressing layer. A `Locator` is **lazy**: it holds a resolver function and runs it
against the page's *current* document at call time, so it survives re-navigation.
Resolvers build the candidate element set; the `Locator` wraps it with chaining,
accessors, and actions. No JS execution — pure DOM.

## Exports

### Resolvers `(root) => Element[]`
- `byCss(selector)` — `[...root.querySelectorAll(selector)]`.
- `byRole(role, opts?)` — elements whose `roleOf(el) === role`; if `opts.name` is
  set, also `textMatch(accessibleName(el), name, opts.exact)`.
- `byText(want, opts?)` — **innermost** matching element: `textOf(el)` matches AND
  no descendant also matches (`hasMatchingChild` returns false). Avoids selecting an
  outer container when a leaf carries the text.
- `byLabel(want, opts?)` — for each `<label>` whose `textContent` matches, resolves
  its target: by id (`for` attribute) via `byId` if set, else the first
  `input,select,textarea` descendant. Skips labels with no resolvable target.
- `byAttrText(attr, want, opts?)` — over `[${attr}]` elements, matches
  `attrOf(el, attr)` against `want`.

`want` may be a **string** or a **RegExp** (Playwright accepts both for
`getByRole({name})`, `getByText`, `getByLabel`, …); `textMatch` tests the RegExp
against the trimmed value. For strings, `opts.exact` selects exact (`===` after
trim) vs substring (case-insensitive `includes`) matching.

`byId(root, id)` resolves a `for=`/id target **without a CSS selector** —
`useId()` ids like `:r0:` contain colons that throw in a `#id` selector. It prefers
the DOM's own `getElementById` (handles any id), falling back to an `[id]`
attribute scan (`scanById`) when the root lacks `getElementById`.

### `class Locator`
Constructed `new Locator(page, resolve)`; private `#page`, `#resolve`.

**Set / chaining** (all chainers return a new lazy `Locator`):
- `elements()` — re-resolves `#resolve(#page.document)` → live `Element[]`.
- `count()` — `elements().length`.
- `first()` / `last()` / `nth(n)` — slice the resolved set (empty if out of range).
- `filter({ hasText })` — keeps elements whose `textOf(el).includes(hasText)`.
- `locator(selector)` — descends: `flatMap` of `querySelectorAll(selector)` over the
  current matches.

**Accessors** (operate on the **first** match; throw `"turbo-crawl: locator matched
no elements"` if empty, except `isVisible`):
- `textContent()` / `innerText()` → `textOf` (both collapse whitespace).
- `innerHTML()`, `getAttribute(name)`, `inputValue()`.
- `isVisible()` — `false` on a **zero-match** locator (Playwright `toBeHidden`
  semantics), else `isVisibleEl(first, page.window)`.
- `isEnabled()`, `isChecked()`, `isEditable()`, `isEmpty()`.
- `isFocused()` — `false` on a zero-match locator, else
  `page.document.activeElement === first`.
- `ariaRole()`, `accessibleName()`, `accessibleDescription()`,
  `accessibleErrorMessage()` — ARIA reads (back the `toHaveRole`/`toHaveAccessible*`
  assertions).
- `selectedValues()` — selected `<option>` values of a (multi-)`<select>`.
- `jsProperty(name)` — a DOM IDL property read (`toHaveJSProperty`).
- `cssValue(name)` — computed CSS value from turbo-dom's real cascade (`toHaveCSS`).
- `viewportRatio()` — fraction of the element's box inside the viewport, from
  turbo-dom's approximate geometry (`toBeInViewport`).
- `allTextContents()` — `textOf` of **every** match (array text assertions).

**Actions** (operate on the first match):
- `click(opts)` → `page.clickElement(first, opts)`.
- `fill(value)` / `type(value)` → `fillValue(first, value)`, return `this`.
- `check()` / `uncheck()` → `setChecked(first, true|false)`, return `this`.
- `selectOption(value)` → `selectOption(first, value)`, return `this`.
- `press()` — Enter on a control → `page.submitFromElement(first)` (the only no-JS
  key effect).

## Key internals
`textMatch` (RegExp `.test`, else exact vs substring), `collect` (filtered
NodeList → array), `roleMatches`, `hasMatchingChild`, `labelTarget`, `byId` /
`scanById` (colon-safe id resolution); `#firstEl` (throws on empty), `#derive`
(wraps a transform of the resolved set into a new lazy `Locator`).

## Depends on / used by
- Depends on `actions.mjs` (`fillValue`), `aria.mjs` (`accessibleName`, `roleOf`),
  `dom-ops.mjs` (all accessors), and the `page` object (`document`, `window`,
  `clickElement`, `submitFromElement`).
- Used by `Page.getBy*` factory methods to expose locators to callers.

## Invariants & gotchas
- **Laziness**: every chainer captures a resolver closure; nothing is evaluated
  until an accessor/action calls `elements()` — so locators are navigation-safe.
- `getByText` returns the **innermost** match (no matching descendant).
- `isVisible()` on an **empty** locator → `false` (does not throw); all other
  first-match accessors/actions throw on empty.
- `filter`/`first`/`last`/`nth` derive new Locators; mutating actions return `this`
  for chaining but accessors return plain values.

## Example
```js
import { byRole } from "./src/locator.mjs";

const btn = new Locator(page, byRole("button", { name: "Save" }));
btn.first().click();

page.getByLabel("Email").fill("a@b.test");
page.getByText("Item 3").isVisible(); // false if absent
```
