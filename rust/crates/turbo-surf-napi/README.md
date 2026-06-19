# turbo-surf-napi

The turbo-surf Rust engine exposed to Node as a napi-rs addon — the in-process
bridge from the Rust core to JavaScript.

**Not published.** This is a **dev/harness-only** crate. The shipped npm package
(`turbo-surf`) is a thin launcher that spawns the standalone
`turbo-surf-mcp` **binary** — it does not host Rust in Node. This addon exists so
the JS code that genuinely needs an in-process DOM can run:

- the **Playwright shim** (`rust/playwright-shim/`) — Page/Locator/expect over the
  engine, and
- the **benchmark harnesses** (`harness/`) — driving the engine from Node.

## Surface

`require('./index.js')` loads the addon; the full typed surface is in
[`index.d.ts`](./index.d.ts). Grouped:

- **async net/crawl:** `fetchHtml`, `request`, `fetchWithCookies` (cookies +
  extra headers in, updated cookies out), `crawl`.
- **view passes** (HTML string in): `markdown`, `text`, `html`, `links`,
  `interactiveElements`, `accessibilityTree`, `ariaSnapshot`, `hydrationState`,
  `detect`, `query`, `getBy`, `extract`.
- **per-node accessors** (by handle): `attrOf`, `inputValueOf`, `is{Visible,
  Checked,Enabled,Editable,Empty}`, `ariaRoleOf`, `accessibleNameOf`,
  `accessibleDescriptionOf`, `selectedValuesOf`, `cssValueOf`,
  `matchesAriaSnapshot`, and `nodeSnapshot` (one-crossing batch of the boolean/
  text/role reads — backs `expect(locator)` chains).
- **actions:** `fill`/`setChecked`/`selectOption`/`click` (by selector) and the
  `*Node` variants (by handle).
- **JS tier:** `evaluate`, `render`, `transform`.

Stateless by design: Node passes the HTML, each call parses with turbo-dom and
runs the Rust pass. The most recent parse is cached per thread (`PARSE_CACHE`), so a
same-HTML follow-up is a string-compare + `Rc` clone, not a re-parse; mutating
actions own their own tree. Nothing holds a (non-`Send`) DOM tree across the FFI.

## Build

```sh
cargo build --release -p turbo-surf-napi
```

`index.js` resolves a packaged `turbo-surf.<triple>.node` if present, else falls
back to the locally-built cdylib (`target/{release,debug}/libturbo_surf_napi.*`):
it copies the cdylib to a sibling `.node` and `require`s it. On macOS the copy
invalidates the Mach-O code signature (→ `SIGKILL` on load), so the loader re-signs
it ad-hoc (`codesign --force -s -`) after copying. The Playwright shim + harnesses
auto-skip if no addon is built.
