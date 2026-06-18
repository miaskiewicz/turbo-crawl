//! turbo-crawl render-tier DOM = the turbo-test browser binding + a thin extension.
//!
//! `browser_env_upstream.rs` (in this dir) is a **VERBATIM** copy of
//! `../turbo-test/src/browser_env.rs` (turbo-test @ b3fb989) and `browser_env.js`
//! likewise. ⚠️ DO NOT EDIT either of those — turbo-test owns the canonical,
//! battle-tested rtdom↔V8 binding (it runs React + Testing Library on it). We reuse
//! it for the render tier. There is intentionally **no cross-repo crate dependency**
//! (turbo-test is a test runner, not a published lib); the copy is kept in sync
//! **manually** via `scripts/vendor-browser-env.sh` (one command). That script is
//! the whole sync story — it `cp`s the `.js` verbatim and copies the `.rs` with a
//! single mechanical transform: leading inner-doc lines `//!` → `//`, because
//! `include!` (below) forbids a file that starts with inner attributes. No logic is
//! touched; nothing in THIS file changes (it only adds; it never patches upstream).
//!
//! We `include!` the upstream file so this module gains its private items
//! (`DOM`/`wrap`/`build_el_template`/`BOOTSTRAP`/the `doc_*` callbacks) without
//! exposing them, then add the two entry points the render runtime in `dom.rs`
//! needs but upstream (a test env) doesn't have: seed the DOM from a fetched page
//! (`install_html`) and serialize it back out (`document_html`).
//!
//! The upstream file references the `v8` crate by its bare name and ships its own
//! `#[cfg(test)]` smoke test that boots a standalone V8 platform; that test runs in
//! the lib unit-test binary (which never touches deno_core), while the render tests
//! that DO use deno_core live in `tests/render.rs` (a separate test process), so the
//! two V8-platform initializations never collide.

// This module is a verbatim vendor (`include!`d below) plus a thin extension. We do
// not lint upstream code we don't own: silence dead-code/unused-import (helpers the
// crawler doesn't call) and clippy style/complexity nits that belong to turbo-test.
#![allow(unused)]
#![allow(clippy::all)]

include!("browser_env_upstream.rs");

/// Install `window`/`document` + the DOM onto `globalThis`, seeded from the fetched
/// page `html`. This is a near-mirror of upstream `install` (which starts from a
/// blank document) — the ONLY difference is `Tree::parse(html)`. If upstream
/// `install` gains document bindings, re-apply them here (search "// SYNC:").
pub fn install_html(scope: &mut v8::PinScope, html: &str) {
    let tree = Tree::parse(html); // SYNC: upstream parses a fixed blank document instead
    let el_template = {
        let t = build_el_template(scope);
        v8::Global::new(scope, t)
    };
    DOM.with(|d| {
        *d.borrow_mut() = Some(DomState {
            tree,
            cache: HashMap::new(),
            el_template,
        });
    });

    let root = with_tree(|t| t.root()).unwrap();
    let body_h = with_tree(|t| t.query_selector("body")).flatten();
    let html_h = with_tree(|t| t.query_selector("html")).flatten();

    // SYNC: keep the document bindings below identical to upstream `install`.
    let document = wrap(scope, root);
    bind_method(scope, document, "createElement", doc_create_element);
    bind_method(scope, document, "createTextNode", doc_create_text_node);
    bind_method(scope, document, "getElementById", doc_get_element_by_id);
    bind_method(scope, document, "querySelector", doc_query_selector);
    bind_method(scope, document, "querySelectorAll", doc_query_selector_all);
    bind_method(scope, document, "createElementNS", doc_create_element_ns);
    bind_method(
        scope,
        document,
        "createDocumentFragment",
        doc_create_fragment,
    );
    bind_method(scope, document, "createComment", doc_create_comment);
    if let Some(b) = body_h {
        let body = wrap(scope, b);
        let key = v8::String::new(scope, "body").unwrap();
        document.set(scope, key.into(), body.into());
    }
    if let Some(html_node) = html_h {
        let de = wrap(scope, html_node);
        let key = v8::String::new(scope, "documentElement").unwrap();
        document.set(scope, key.into(), de.into());
    }

    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "document").unwrap();
    global.set(scope, key.into(), document.into());
    let key = v8::String::new(scope, "window").unwrap();
    global.set(scope, key.into(), global.into());

    run_js(scope, BOOTSTRAP);
}

/// Serialize the live tree back to HTML — the render result. Empty if no DOM is
/// installed. (turbo-crawl addition; upstream is a test env that never serializes.)
pub fn document_html() -> String {
    DOM.with(|d| {
        d.borrow().as_ref().map(|s| {
            let root = s.tree.root();
            turbo_dom_parser::rtdom::serialize::serialize_inner(&s.tree, root)
        })
    })
    .unwrap_or_default()
}
