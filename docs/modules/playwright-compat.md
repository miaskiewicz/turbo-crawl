# `playwright/index.mjs` + `playwright/expect.mjs` — Playwright-compatibility façade

## Responsibility
Lets an existing Playwright script run on turbo-crawl's no-JS engine — with **NO
playwright or chromium loaded at runtime**. `chromium`/`firefox`/`webkit` all
launch the **same** turbo-crawl-backed pseudo-browser (there is no real browser).
JS-only / pixel APIs throw a clear error pointing at the JS-execution tier.
- `index.mjs` — the browser/context/page shims + the three launcher aliases.
- `expect.mjs` — a web-first assertions subset over a turbo-crawl Locator.

## Exports / API
- `chromium`, `firefox`, `webkit` — all the same `browserType =
  { launch: async (opts) => new Browser(opts) }`.
- `expect(locator) → LocatorAssertions` (re-exported from `expect.mjs`).
- `PWPage`, `Browser`, `BrowserContext` (classes, for advanced use).
- Usage:
  ```js
  import { chromium, expect } from "@miaskiewicz/turbo-crawl/playwright";
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Go" }).click();
  ```

### `Browser` / `BrowserContext`
- `Browser.newPage()` / `BrowserContext.newPage()` → `new PWPage(new Page(...))`.
- `Browser.newContext(opts)` → `BrowserContext` merging launch + context opts.
- `close()` on all is a no-op.
- `toPageOptions(opts)` maps only `{ userAgent, navigator, fetchHtml }` to the
  turbo-crawl Page.

### `PWPage` (wraps a turbo-crawl `Page`)
- `get tcPage` — escape hatch to the underlying Page.
- Navigation: `goto` (returns `PWResponse`), `goBack`/`goForward` (→ `PWResponse`
  or `null` via `wrapNav`), `reload`, `url()`, `title()`, `content()` (→
  `page.html()`).
- Locators (delegate to the Page): `locator`, `getByRole`, `getByText`,
  `getByLabel`, `getByPlaceholder`, `getByTestId`, `getByAltText`, `getByTitle`.
- Selector-string shorthands (via `#first(sel) = locator(sel).first()`): `click`,
  `fill`, `type`, `check`, `uncheck`, `selectOption`, `press`.
- Accessors: `textContent`, `innerText`, `innerHTML`, `getAttribute`,
  `inputValue`, `isVisible`, `isEnabled`, `isChecked`.
- Evaluate over the rendered DOM: `evaluate`, `$eval`, `$$eval` (delegate to
  Page).
- `PWResponse` (page.goto return shim): `status()`, `url()`, `ok()`
  (`status ∈ [200,300)`).

### `expect()` web-first assertions subset (expect.mjs)
- `LocatorAssertions` with `.not` (returns a negated clone). `#check(ok, message)`
  throws `expect(locator)[.not].<message> failed` when the outcome doesn't match.
- Supported: `toBeVisible`, `toBeHidden`, `toBeChecked`, `toBeEnabled`,
  `toBeDisabled`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveCount`,
  `toHaveAttribute(name, value)`.
- All evaluate **synchronously** against the static DOM (no auto-retry — nothing
  changes without JS), though the methods are `async` for API parity.

## Key internals
- `jsTier(name)` — builds the standard error: `<name>() needs
  JavaScript/rendering — not available in the no-JS engine. See
  docs/js-execution-tier.md.`
- Waiting no-ops: `waitForLoadState`, `waitForTimeout`, `waitForURL` resolve
  immediately (the DOM is static per navigation). `waitForSelector(selector)` is
  special — it returns the first locator if it matches, but **throws `jsTier`** if
  the selector has no matches (a wait for something that would only appear after
  JS).
- JS-only / pixel APIs throw `jsTier`: `screenshot`, `pdf`, `route`, `hover`.
  `close()` is a no-op.

## Depends on / used by
- `index.mjs` depends on: `../src/page.mjs` (`Page`), `./expect.mjs` (`expect`).
- `expect.mjs` depends on: nothing (operates on a turbo-crawl Locator's
  `isVisible`/`isChecked`/`isEnabled`/`textContent`/`inputValue`/`count`/
  `getAttribute`).
- Used by: existing Playwright scripts importing from
  `@miaskiewicz/turbo-crawl/playwright`.

## Invariants & gotchas
- **No browser, no playwright dependency at runtime** — `chromium`, `firefox`,
  `webkit` are identical and back onto the no-JS Page.
- **No auto-retry / no waiting semantics.** The DOM is static per navigation; wait
  helpers resolve instantly. `waitForSelector` throws (jsTier) when nothing
  matches rather than polling.
- Assertions are evaluated once against the current DOM; `.not` flips the
  expectation; mismatches throw like Playwright's `expect`.
- Genuinely JS/pixel APIs (`screenshot`/`pdf`/`route`/`hover`, function-only
  evaluate paths) throw a clear jsTier error pointing at
  `docs/js-execution-tier.md` — they aren't silently faked.
- Only `userAgent`, `navigator`, `fetchHtml` from launch/context options reach the
  Page; other Playwright options are ignored.

## Example
```js
import { chromium, expect } from "@miaskiewicz/turbo-crawl/playwright";

const browser = await chromium.launch();          // turbo-crawl pseudo-browser
const page = await browser.newPage();
await page.goto("https://example.com");
await page.fill("#q", "turbo");                    // locator(sel).first().fill()
await expect(page.getByRole("heading")).toBeVisible();
// await page.screenshot();  // throws jsTier — needs the JS-execution tier
await browser.close();                             // no-op
```
