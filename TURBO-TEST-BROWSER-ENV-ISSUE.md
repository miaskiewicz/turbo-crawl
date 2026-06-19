# turbo-test browser_env: missing HTML*Element constructors + constructable stylesheets

**Repo:** `../turbo-test` (source of the vendored `browser_env.js` that turbo-crawl
re-vendors via `rust/crates/turbo-crawl-render/scripts/vendor-browser-env.sh`).

**Why:** turbo-crawl runs real app JS (Next.js 15 App Router + MUI/emotion) over the
rtdom↔V8 binding. App chunks reference DOM globals that browser_env's constructor
list omits; an undefined reference (`X is not defined`) aborts the chunk
mid-hydration and blanks the whole React tree on authed surfaces.

Currently patched defensively in turbo-crawl's `runtime.rs` prelude (commit
`f36b1c1`), guarded by `if (typeof globalThis[name] === "undefined")` so it's a
no-op once browser_env provides them. Proper home is browser_env itself.

## Change 1 — extend the `ctors` list

In `browser_env.js`, the `ctors` array (around the line that begins
`var ctors = ['Node','Element','HTMLElement','HTMLDivElement',...`) is missing many
HTML element classes. Add at least:

```
HTMLDialogElement, HTMLDataListElement, HTMLFieldSetElement, HTMLLegendElement,
HTMLOListElement, HTMLDListElement, HTMLPreElement, HTMLTableRowElement,
HTMLTableCellElement, HTMLTableSectionElement, HTMLTableColElement,
HTMLTableCaptionElement, HTMLProgressElement, HTMLMeterElement, HTMLDetailsElement,
HTMLPictureElement, HTMLSourceElement, HTMLMediaElement, HTMLVideoElement,
HTMLAudioElement, HTMLTemplateElement, HTMLSlotElement, HTMLBodyElement,
HTMLHtmlElement, HTMLHeadElement, HTMLMetaElement, HTMLLinkElement,
HTMLTitleElement, HTMLBaseElement, HTMLBRElement, HTMLHRElement,
HTMLOptGroupElement, HTMLMapElement, HTMLAreaElement, HTMLObjectElement,
HTMLEmbedElement, HTMLOutputElement, HTMLQuoteElement, HTMLMenuElement,
HTMLDataElement, HTMLTimeElement, HTMLUnknownElement
```

The existing loop (`ctors.forEach(... if undefined, create a named stub)`) already
handles construction. For the tag-mappable ones, also add a tag-keyed
`Symbol.hasInstance` next to the existing `iface('HTMLInputElement', ...)` block so
`node instanceof HTMLDialogElement` works on a real `<dialog>` node, e.g.:

```js
iface('HTMLDialogElement', function(o){ return isNode(o) && o.nodeType === 1 && String(o.tagName).toUpperCase() === 'DIALOG'; });
```
(repeat for the single-tag classes: dialog, fieldset, legend, progress, meter,
details, video, audio, template, slot, output, map, area, object, embed, etc.)

## Change 2 — CSSStyleSheet + document.adoptedStyleSheets

emotion/MUI do `new CSSStyleSheet()` then `document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]`.
Add a `CSSStyleSheet` global (inert rule store: `cssRules`/`rules`, `insertRule`,
`deleteRule`, `replace`→Promise, `replaceSync`) and ensure
`document.adoptedStyleSheets` is a real, settable **array** (a non-iterable
getter breaks the spread).

## Verification

After re-vendoring into turbo-crawl, this test must stay green:
`cargo test -p turbo-crawl-render --test render constructable_stylesheet_and_extra_html_element_ctors`
and the turbo-crawl prelude stubs in `runtime.rs` become dead no-ops (can be
removed in a follow-up once browser_env ships them).
