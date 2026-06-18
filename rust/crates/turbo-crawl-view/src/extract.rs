//! Extraction passes (port of `src/extract.mjs`, SPEC §3.1/§7.1). Hot-path
//! discipline: one index loop over the query result, no per-node allocation
//! beyond the record. `interactive_elements` indexes the page's interactive
//! controls into stable `[i]`-addressable records; `links` collects absolute
//! http(s) targets.
//!
//! Visibility is cascade-derived in the JS impl (`visible.mjs` / getComputedStyle).
//! That cascade port is a separate task; until it lands every record reports
//! `visible: true` (mirrors the JS `options.visibility:false` fast path).

use crate::aria::{accessible_name, implicit_role};
use std::collections::HashSet;
use turbo_crawl_core::url::{is_http_url, resolve};
use turbo_dom_parser::rtdom::Tree;

const INTERACTIVE_SELECTOR: &str = "a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable],[tabindex],[onclick]";

/// One `[i]`-addressable interactive element. `node` is the turbo-dom handle (the
/// JS impl uses a `WeakRef`; here the handle is the stable identity).
#[derive(Debug, Clone, PartialEq)]
pub struct Interactive {
    pub i: usize,
    pub tag: String,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub href: Option<String>,
    pub r#type: Option<String>,
    pub visible: bool,
    pub js_handler: bool,
    pub node: u32,
}

// Absolute href for an <a>; None for non-anchors or unresolvable targets.
fn href_for(tree: &Tree, h: u32, tag: &str, base: &str) -> Option<String> {
    if tag != "a" {
        return None;
    }
    tree.get_attribute(h, "href")
        .and_then(|raw| resolve(base, raw))
}

// Native nav = <a href> or a submit control; otherwise an onclick is a JS
// handler we can't fire in Lane A → flag it (don't drop the element).
fn js_handler_for(tree: &Tree, h: u32, href: &Option<String>, ty: &Option<String>) -> bool {
    let native_nav = href.is_some() || ty.as_deref() == Some("submit");
    !native_nav && tree.get_attribute(h, "onclick").is_some()
}

fn role_for(tree: &Tree, h: u32, tag: &str, ty: &Option<String>) -> String {
    match tree.get_attribute(h, "role") {
        Some(r) => r.to_string(),
        None => implicit_role(tag, ty.as_deref()).to_string(),
    }
}

fn to_record(tree: &Tree, h: u32, i: usize, base: &str) -> Interactive {
    let tag = tree.tag_name(h).unwrap_or_default().to_ascii_lowercase();
    let ty = tree
        .get_attribute(h, "type")
        .map(|s| s.to_ascii_lowercase());
    let href = href_for(tree, h, &tag, base);
    let js_handler = js_handler_for(tree, h, &href, &ty);
    Interactive {
        i,
        role: role_for(tree, h, &tag, &ty),
        name: accessible_name(tree, h),
        value: tree.get_attribute(h, "value").map(str::to_string),
        href,
        r#type: ty,
        visible: true, // cascade visibility pending (see module docs)
        js_handler,
        node: h,
        tag,
    }
}

/// Index interactive elements into `[i]`-addressable records (document order).
pub fn interactive_elements(tree: &Tree, base: &str) -> Vec<Interactive> {
    let nodes = tree.query_selector_all(INTERACTIVE_SELECTOR);
    let mut out = Vec::with_capacity(nodes.len());
    for &h in nodes.iter() {
        let i = out.len();
        out.push(to_record(tree, h, i, base));
    }
    out
}

/// All absolute, navigable http(s) link targets (deduped, in document order).
pub fn links(tree: &Tree, base: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for &h in tree.query_selector_all("a[href]").iter() {
        // The `a[href]` selector guarantees the attribute is present; the else is
        // a defensive total.
        let Some(href) = tree.get_attribute(h, "href") else {
            continue;
        };
        if let Some(abs) = resolve(base, href) {
            if is_http_url(&abs) && seen.insert(abs.clone()) {
                out.push(abs);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://x.test/";

    #[test]
    fn indexes_interactive_elements() {
        let tree = Tree::parse(
            "<a href='/p'>link</a><button>Go</button><input type='checkbox'><div role='tab'>T</div>",
        );
        let els = interactive_elements(&tree, BASE);
        assert_eq!(els.len(), 4);
        assert_eq!(els[0].tag, "a");
        assert_eq!(els[0].role, "link");
        assert_eq!(els[0].href.as_deref(), Some("https://x.test/p"));
        assert_eq!(els[0].name, "link");
        assert_eq!(els[1].role, "button");
        assert_eq!(els[2].role, "checkbox");
        assert_eq!(els[3].role, "tab");
        assert!(els.iter().all(|e| e.visible));
        // indices are sequential
        assert_eq!(
            els.iter().map(|e| e.i).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn flags_js_handler_without_native_nav() {
        let tree = Tree::parse("<button onclick='x()'>Go</button><a href='/p' onclick='y()'>L</a>");
        let els = interactive_elements(&tree, BASE);
        assert!(els[0].js_handler); // button + onclick, no nav
        assert!(!els[1].js_handler); // anchor has href → native nav
    }

    #[test]
    fn submit_input_is_native_nav() {
        let tree = Tree::parse("<input type='submit' onclick='x()'>");
        let els = interactive_elements(&tree, BASE);
        assert!(!els[0].js_handler);
        assert_eq!(els[0].role, "button");
    }

    #[test]
    fn value_captured() {
        let tree = Tree::parse("<input value='hi'>");
        let els = interactive_elements(&tree, BASE);
        assert_eq!(els[0].value.as_deref(), Some("hi"));
    }

    #[test]
    fn links_absolute_deduped_http_only() {
        let tree = Tree::parse(
            "<a href='/a'>a</a><a href='/a'>dup</a><a href='mailto:x@y.test'>m</a><a href='https://o.test/b'>o</a>",
        );
        assert_eq!(
            links(&tree, BASE),
            vec![
                "https://x.test/a".to_string(),
                "https://o.test/b".to_string()
            ]
        );
    }
}
