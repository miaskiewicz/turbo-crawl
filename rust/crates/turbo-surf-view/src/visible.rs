//! Cascade-based visibility (port of `src/visible.mjs`, SPEC §7.3). We can't
//! measure pixels — visibility is approximated from turbo-dom's real CSS cascade
//! (declared, not rendered). Not-visible if: `hidden` attr, `aria-hidden=true`,
//! `<input type=hidden>`, computed `visibility:hidden` (inherits → self check),
//! or self/any ancestor `display:none` (does NOT inherit → walk up).

use turbo_dom_parser::rtdom::cascade::{computed_style, get_property_value};
use turbo_dom_parser::rtdom::Tree;

const ELEMENT_NODE: u8 = 1;

fn is_hidden_input(tree: &Tree, h: u32) -> bool {
    tree.tag_name(h).as_deref() == Some("INPUT")
        && tree
            .get_attribute(h, "type")
            .map(|t| t.to_ascii_lowercase())
            .as_deref()
            == Some("hidden")
}

fn computed(tree: &Tree, h: u32, prop: &str) -> String {
    get_property_value(&computed_style(tree, h), prop)
}

// display does not inherit → walk the ancestor chain.
fn has_display_none_ancestor(tree: &Tree, h: u32) -> bool {
    let mut node = Some(h);
    while let Some(n) = node {
        if tree.node_type(n) != ELEMENT_NODE {
            break;
        }
        if computed(tree, n, "display") == "none" {
            return true;
        }
        node = tree.parent(n);
    }
    false
}

/// Whether element `h` is (declared-)visible. Cheap attribute signals are tested
/// before any cascade work.
pub fn is_visible(tree: &Tree, h: u32) -> bool {
    if tree.get_attribute(h, "hidden").is_some() {
        return false;
    }
    if tree.get_attribute(h, "aria-hidden") == Some("true") {
        return false;
    }
    if is_hidden_input(tree, h) {
        return false;
    }
    // visibility inherits → one read reflects ancestor hidden too.
    if computed(tree, h, "visibility") == "hidden" {
        return false;
    }
    !has_display_none_ancestor(tree, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first(tree: &Tree, sel: &str) -> u32 {
        tree.query_selector(sel).unwrap()
    }

    #[test]
    fn plain_element_is_visible() {
        let tree = Tree::parse("<div id='a'>x</div>");
        assert!(is_visible(&tree, first(&tree, "#a")));
    }

    #[test]
    fn hidden_attr_and_aria_hidden() {
        let t1 = Tree::parse("<div id='a' hidden>x</div>");
        assert!(!is_visible(&t1, first(&t1, "#a")));
        let t2 = Tree::parse("<div id='a' aria-hidden='true'>x</div>");
        assert!(!is_visible(&t2, first(&t2, "#a")));
    }

    #[test]
    fn hidden_input_type() {
        let tree = Tree::parse("<input id='a' type='hidden'>");
        assert!(!is_visible(&tree, first(&tree, "#a")));
    }

    #[test]
    fn display_none_inline_style() {
        let tree = Tree::parse("<div id='a' style='display:none'>x</div>");
        assert!(!is_visible(&tree, first(&tree, "#a")));
    }

    #[test]
    fn display_none_ancestor_hides_descendant() {
        let tree = Tree::parse("<div style='display:none'><span id='a'>x</span></div>");
        assert!(!is_visible(&tree, first(&tree, "#a")));
    }

    #[test]
    fn visibility_hidden_inline_style() {
        let tree = Tree::parse("<div id='a' style='visibility:hidden'>x</div>");
        assert!(!is_visible(&tree, first(&tree, "#a")));
    }

    #[test]
    fn style_block_rule_applies() {
        let tree = Tree::parse("<style>.h{display:none}</style><div id='a' class='h'>x</div>");
        assert!(!is_visible(&tree, first(&tree, "#a")));
    }
}
