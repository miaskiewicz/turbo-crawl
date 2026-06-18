//! Locator resolvers (port of the resolver core of `src/locator.mjs`) — the
//! Playwright-style getByRole / getByText / getByLabel / getByAttr matching
//! engine, over the turbo-dom `Tree`, returning matched node handles. Pure DOM,
//! no JS. (The `Locator` wrapper class — chaining, accessors, actions — is
//! Playwright-shim glue and lands with the napi tier, not here.)

use crate::aria::{accessible_name, role_of, text_of};
use std::collections::HashSet;
use turbo_dom_parser::rtdom::Tree;

const ELEMENT_NODE: u8 = 1;

/// Text match mode. `Exact` compares trimmed strings; `Substring` is a
/// case-insensitive `contains` (the Playwright default).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TextMode {
    Exact,
    Substring,
}

/// Does `value` match `want` under `mode` (after trimming)?
pub fn text_match(value: &str, want: &str, mode: TextMode) -> bool {
    let v = value.trim();
    match mode {
        TextMode::Exact => v == want,
        TextMode::Substring => v.to_lowercase().contains(&want.to_lowercase()),
    }
}

fn all_elements(tree: &Tree) -> Vec<u32> {
    tree.query_selector_all("*").iter().copied().collect()
}

fn push_unique(out: &mut Vec<u32>, seen: &mut HashSet<u32>, h: u32) {
    if seen.insert(h) {
        out.push(h);
    }
}

/// `getByRole(role, name?)` — elements whose resolved ARIA role equals `role`,
/// optionally filtered by accessible-name match.
pub fn by_role(tree: &Tree, role: &str, name: Option<(&str, TextMode)>) -> Vec<u32> {
    all_elements(tree)
        .into_iter()
        .filter(|&h| role_of(tree, h) == role)
        .filter(|&h| match name {
            Some((want, mode)) => text_match(&accessible_name(tree, h), want, mode),
            None => true,
        })
        .collect()
}

fn has_matching_child(tree: &Tree, h: u32, want: &str, mode: TextMode) -> bool {
    tree.descendants(h)
        .into_iter()
        .filter(|&c| tree.node_type(c) == ELEMENT_NODE)
        .any(|c| text_match(&text_of(tree, c), want, mode))
}

/// `getByText(want)` — innermost elements whose text matches and which have no
/// matching descendant (so the deepest holder wins).
pub fn by_text(tree: &Tree, want: &str, mode: TextMode) -> Vec<u32> {
    all_elements(tree)
        .into_iter()
        .filter(|&h| {
            text_match(&text_of(tree, h), want, mode) && !has_matching_child(tree, h, want, mode)
        })
        .collect()
}

/// `getByAttr(attr, want)` — elements with `attr` whose value matches.
pub fn by_attr_text(tree: &Tree, attr: &str, want: &str, mode: TextMode) -> Vec<u32> {
    tree.query_selector_all(&format!("[{attr}]"))
        .iter()
        .copied()
        .filter(|&h| match tree.get_attribute(h, attr) {
            Some(v) => text_match(v, want, mode),
            None => false, // unreachable: the [attr] selector guarantees presence
        })
        .collect()
}

// Controls a <label> labels: for=/id, aria-labelledby back-refs, wrapped input.
fn collect_label_targets(tree: &Tree, label: u32, out: &mut Vec<u32>, seen: &mut HashSet<u32>) {
    if let Some(for_id) = tree.get_attribute(label, "for") {
        if let Some(t) = tree.get_element_by_id(for_id) {
            push_unique(out, seen, t);
        }
    }
    if let Some(id) = tree.get_attribute(label, "id") {
        for h in tree
            .query_selector_all(&format!("[aria-labelledby~=\"{id}\"]"))
            .iter()
        {
            push_unique(out, seen, *h);
        }
    }
    if let Some(input) = first_descendant_control(tree, label) {
        push_unique(out, seen, input);
    }
}

fn first_descendant_control(tree: &Tree, h: u32) -> Option<u32> {
    tree.descendants(h).into_iter().find(|&c| {
        matches!(
            tree.tag_name(c).as_deref(),
            Some("INPUT") | Some("SELECT") | Some("TEXTAREA")
        )
    })
}

/// `getByLabel(want)` — controls labelled by a matching `<label>` (for=/wrapped/
/// aria-labelledby), plus controls whose own `aria-label` matches.
pub fn by_label(tree: &Tree, want: &str, mode: TextMode) -> Vec<u32> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for label in tree.query_selector_all("label").iter() {
        if text_match(&tree.text_content(*label), want, mode) {
            collect_label_targets(tree, *label, &mut out, &mut seen);
        }
    }
    for el in tree.query_selector_all("[aria-label]").iter() {
        if let Some(v) = tree.get_attribute(*el, "aria-label") {
            if text_match(v, want, mode) {
                push_unique(&mut out, &mut seen, *el);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use TextMode::{Exact, Substring};

    #[test]
    fn text_match_modes() {
        assert!(text_match("  Hello  ", "Hello", Exact));
        assert!(!text_match("Hello!", "Hello", Exact));
        assert!(text_match("Hello World", "hello", Substring));
        assert!(!text_match("Hello", "bye", Substring));
    }

    #[test]
    fn by_role_with_name() {
        let tree = Tree::parse("<button>Save</button><button>Cancel</button><a href='/x'>Save</a>");
        assert_eq!(by_role(&tree, "button", None).len(), 2);
        assert_eq!(by_role(&tree, "button", Some(("Save", Exact))).len(), 1);
        assert_eq!(by_role(&tree, "link", None).len(), 1);
    }

    #[test]
    fn by_text_picks_innermost() {
        let tree = Tree::parse("<div>wrapper <span>target</span></div>");
        let hits = by_text(&tree, "target", Substring);
        assert_eq!(hits.len(), 1);
        assert_eq!(tree.tag_name(hits[0]).as_deref(), Some("SPAN"));
    }

    #[test]
    fn by_attr_text_matches() {
        let tree = Tree::parse("<div data-test='one'>a</div><div data-test='two'>b</div>");
        assert_eq!(by_attr_text(&tree, "data-test", "one", Exact).len(), 1);
    }

    #[test]
    fn by_label_for_attribute() {
        let tree = Tree::parse("<label for='e'>Email</label><input id='e'>");
        let hits = by_label(&tree, "Email", Substring);
        assert_eq!(hits.len(), 1);
        assert_eq!(tree.tag_name(hits[0]).as_deref(), Some("INPUT"));
    }

    #[test]
    fn by_label_wrapped_input() {
        let tree = Tree::parse("<label>Name <input></label>");
        let hits = by_label(&tree, "Name", Substring);
        assert_eq!(hits.len(), 1);
        assert_eq!(tree.tag_name(hits[0]).as_deref(), Some("INPUT"));
    }

    #[test]
    fn by_label_aria_labelledby_backref() {
        let tree = Tree::parse("<label id='l'>Phone</label><input aria-labelledby='l'>");
        let hits = by_label(&tree, "Phone", Substring);
        assert_eq!(hits.len(), 1);
        assert_eq!(tree.tag_name(hits[0]).as_deref(), Some("INPUT"));
    }

    #[test]
    fn by_label_aria_label_on_control() {
        let tree = Tree::parse("<input aria-label='Search'>");
        assert_eq!(by_label(&tree, "Search", Exact).len(), 1);
    }

    #[test]
    fn by_label_dedupes_multiple_sources() {
        // for= and aria-label both point at the same control → counted once.
        let tree = Tree::parse("<label for='e'>Email</label><input id='e' aria-label='Email'>");
        assert_eq!(by_label(&tree, "Email", Exact).len(), 1);
    }
}
