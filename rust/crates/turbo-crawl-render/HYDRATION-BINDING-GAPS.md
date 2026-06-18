# browser_env gaps blocking real-SPA hydration (for turbo-test)

turbo-crawl's render tier vendors turbo-test's `browser_env` (the rtdom↔V8 DOM
binding). Driving a **real production SPA** (Next.js + Turbopack + React + PropelAuth,
payroll's `/login`) through it surfaced DOM-element APIs the binding doesn't implement
yet. The JS-global layer (URL, MessageChannel, performance, TextEncoder, ReadableStream,
AbortController, the script-injection pump, …) lives in turbo-crawl's `ENV_BOOTSTRAP`
and is done. **These remaining gaps are element/document features that belong in the
binding itself** — i.e. turbo-test's `browser_env.{rs,js}`. Adding them upstream + a
re-vendor closes them here.

Probed against the current vendored binding (turbo-test @ b3fb989). Each is a real
property/method a live React/PropelAuth bundle reads during hydration; an `undefined`
read becomes a `TypeError` (`X.classList`/`X.toLowerCase` of undefined) that aborts the
mount.

## STATUS (turbo-test @ 3711533)

✅ **Fixed in the binding** (re-vendored): form-control reflection (`value`/`checked`/
`valueAsNumber`/`select.value`/`selectedIndex`/`option.value`), `getClientRects`,
`document.readyState`/`visibilityState`/`hidden`/`elementFromPoint`/`elementsFromPoint`,
CharacterData, Selection/Range, contentEditable, `link.rel`/`media`/`as`, `script.type`,
`Element.localName`.

🔴 **Still open** (found by driving payroll `/login` deeper — React now reaches the
**commit / layout-effects** phase, much further than before):

- **`Element.removeAttributeNode(attr)`** + **`setAttributeNode(attr)`** — missing.
  React 18/19's `releaseSingletonInstance` (the `<html>`/`<head>`/`<body>` singleton
  cleanup during commit) calls `instance.removeAttributeNode(...)` → crashes. **Current
  blocker.** Needs the Attr-node methods (`getAttributeNode` already exists).
- **`HTMLAnchorElement` URL decomposition**: `a.origin` / `a.pathname` / `a.host`
  (+ likely `.protocol`/`.hostname`/`.port`/`.search`/`.hash`) return `undefined`.
  Reflect them by parsing `href` (the same WHATWG-URL split — `a.href` already works).

(turbo-crawl side, already in ENV_BOOTSTRAP: Shadow-DOM fallback sets `shadowRoot.host`
back to the host — Next devtools' `var e = er.host; e.classList…` was crashing the whole
render before the app could mount. With link.rel fixed, the prior `clearContainerSparingly`
crash is gone.)

## HIGH — form-control reflection (breaks controlled inputs) — ✅ FIXED in 7f63ac1

React controlled components read `el.value`/`el.checked` on every render; reading
`undefined` then doing `.toLowerCase()`/comparisons throws and kills the render.

| API | Current | Expected |
|---|---|---|
| `input.value` (getter) | `undefined` | reflect the live value (the `value` attribute until set, then the set value). NB: the **setter works** (`el.value = x` then get returns `x`) — only the initial getter (no prior set) is missing the attribute fallback. |
| `textarea.value` (getter) | `undefined` | text content / `value` |
| `select.value` | `undefined` | selected option's value |
| `select.options` | `undefined` | HTMLOptionsCollection (or array-like) of `<option>`s |
| `input.checked` (getter) | `undefined` | reflect the `checked` attribute/state |
| `input.selectionStart` / `selectionEnd` | `undefined` | caret offsets (0 ok) |
| `input.setSelectionRange()` | missing | no-op acceptable |

## MEDIUM — DOM insertion / manipulation

Frameworks + their helpers use these to move/replace nodes during hydration.

| API | Current | Expected |
|---|---|---|
| `Element.insertAdjacentHTML(pos, html)` | missing | parse + insert at beforebegin/afterbegin/beforeend/afterend |
| `Element.insertAdjacentElement(pos, el)` | missing | insert node at position |
| `Element.before(...nodes)` / `after(...nodes)` | missing | insert siblings |
| `Element.replaceWith(...nodes)` | missing | replace self |
| `Element.replaceChildren(...nodes)` | missing | replace all children |
| `Element.toggleAttribute(name, force?)` | missing | toggle attribute, return bool |
| `Element.getAttributeNS(ns, name)` | missing | namespaced getAttribute (SVG) |

## MEDIUM — document state

| API | Current | Expected |
|---|---|---|
| `document.readyState` | `undefined` | `"complete"` (the tier runs after parse) |
| `document.visibilityState` | `undefined` | `"visible"` |

## LOW — layout/geometry stubs (no real layout, zero-rects OK)

| API | Current | Expected |
|---|---|---|
| `Element.getClientRects()` | `undefined` | `[]` or `[zeroRect]` (mirrors the existing `getBoundingClientRect` stub) |
| `document.elementFromPoint(x, y)` | `undefined` | `null` |

## Already present (for reference — no action)

`getBoundingClientRect`, `getComputedStyle`, `matchMedia`, `getSelection`,
`createRange`, `classList` (+ `add`/`contains`), `style`(+`setProperty`), `dataset`,
`matches`/`closest`/`contains`, `cloneNode`, `getRootNode`, `attributes`, `children`,
`firstElementChild`/`nextElementSibling`, `addEventListener`/`dispatchEvent`, `click`,
`focus`/`blur`, `append`/`prepend`/`remove`, `hasAttribute`, `document.activeElement`,
`document.head`, `attachShadow` (turbo-crawl provides a light-DOM fallback in
ENV_BOOTSTRAP; a real shadow tree, if turbo-test adds one, would supersede it).

## How this was found

`render_hydrate` runs payroll's `/login` bundle crash-free through Turbopack + React's
scheduler + the RSC flight stream; it then hits the form-control reads above. Real
Chromium renders the same page in ~8s (env is healthy), so closing these gaps should
let the login form mount headlessly. Re-probe after a fix with
`native.hydrate(html, url)` against a live SPA, or extend `tests/render.rs`.
