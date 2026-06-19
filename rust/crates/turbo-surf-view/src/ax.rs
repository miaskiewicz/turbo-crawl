//! Accessibility tree (port of `src/ax.mjs`, SPEC §7.2): a compact structural
//! view for agent reasoning, computed from semantics + ARIA. Geometry-free;
//! presentational/skipped subtrees are pruned, roleless wrappers collapsed.
//!
//! `value` is IDL-derived in the JS impl (`el.value`); over the static Tree it
//! is approximated from attributes/content (input `value`, textarea text,
//! selected `<option>`).

use serde::Serialize;
use turbo_dom_parser::rtdom::Tree;

const ELEMENT_NODE: u8 = 1;
const SKIP: &[&str] = &[
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK",
];
const VALUE_TAGS: &[&str] = &["INPUT", "TEXTAREA", "SELECT"];

/// One accessibility node. `role` is `"generic"` for a kept roleless wrapper.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AxNode {
    pub role: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<AxNode>,
}

fn implicit_role(tag: &str) -> Option<&'static str> {
    let role = match tag {
        "A" => "link",
        "BUTTON" => "button",
        "NAV" => "navigation",
        "MAIN" => "main",
        "HEADER" => "banner",
        "FOOTER" => "contentinfo",
        "ASIDE" => "complementary",
        "UL" | "OL" => "list",
        "LI" => "listitem",
        "H1" | "H2" | "H3" | "H4" | "H5" | "H6" => "heading",
        "IMG" => "img",
        "SELECT" => "combobox",
        "TEXTAREA" => "textbox",
        "FORM" => "form",
        "TABLE" => "table",
        "P" => "paragraph",
        "SECTION" => "region",
        "ARTICLE" => "article",
        _ => return None,
    };
    Some(role)
}

// <input> role by type; `hidden` → None (skipped), unknown → textbox.
fn input_role(ty: Option<&str>) -> Option<&'static str> {
    match ty {
        Some("checkbox") => Some("checkbox"),
        Some("radio") => Some("radio"),
        Some("button") | Some("submit") | Some("reset") => Some("button"),
        Some("hidden") => None,
        _ => Some("textbox"),
    }
}

fn role_of(tree: &Tree, h: u32) -> Option<String> {
    if let Some(explicit) = tree.get_attribute(h, "role") {
        return Some(explicit.to_string());
    }
    let tag = tree.tag_name(h).unwrap_or_default();
    if tag == "INPUT" {
        let ty = tree
            .get_attribute(h, "type")
            .map(|t| t.to_ascii_lowercase());
        return input_role(ty.as_deref()).map(str::to_string);
    }
    implicit_role(&tag).map(str::to_string)
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

// aria-label > img alt > collapsed direct text.
fn name_of(tree: &Tree, h: u32) -> String {
    if let Some(aria) = tree.get_attribute(h, "aria-label") {
        return aria.trim().to_string();
    }
    if tree.tag_name(h).as_deref() == Some("IMG") {
        return tree
            .get_attribute(h, "alt")
            .unwrap_or("")
            .trim()
            .to_string();
    }
    collapse(&tree.text_content(h))
}

fn selected_option_value(tree: &Tree, h: u32) -> Option<String> {
    let opt = tree
        .query_selector_all("option")
        .iter()
        .copied()
        .find(|&o| is_descendant(tree, h, o) && tree.get_attribute(o, "selected").is_some())?;
    Some(
        tree.get_attribute(opt, "value")
            .map_or_else(|| collapse(&tree.text_content(opt)), str::to_string),
    )
}

fn is_descendant(tree: &Tree, ancestor: u32, h: u32) -> bool {
    let mut cur = tree.parent(h);
    while let Some(p) = cur {
        if p == ancestor {
            return true;
        }
        cur = tree.parent(p);
    }
    false
}

fn value_of(tree: &Tree, h: u32) -> Option<String> {
    let tag = tree.tag_name(h).unwrap_or_default();
    if !VALUE_TAGS.contains(&tag.as_str()) {
        return None;
    }
    let v = match tag.as_str() {
        "INPUT" => tree.get_attribute(h, "value").map(str::to_string),
        "TEXTAREA" => Some(tree.text_content(h)),
        _ => selected_option_value(tree, h),
    };
    v.filter(|s| !s.is_empty())
}

fn is_skipped(tree: &Tree, h: u32) -> bool {
    if tree.node_type(h) != ELEMENT_NODE {
        return true;
    }
    if SKIP.contains(&tree.tag_name(h).unwrap_or_default().as_str()) {
        return true;
    }
    tree.get_attribute(h, "aria-hidden") == Some("true")
}

fn build_children(tree: &Tree, h: u32) -> Vec<AxNode> {
    tree.children(h)
        .into_iter()
        .filter(|&c| tree.node_type(c) == ELEMENT_NODE)
        .filter_map(|c| build(tree, c))
        .collect()
}

// Collapse a roleless wrapper to its single child, drop if empty, else generic.
fn prune_roleless(mut children: Vec<AxNode>) -> Option<AxNode> {
    match children.len() {
        0 => None,
        1 => Some(children.remove(0)),
        _ => Some(AxNode {
            role: "generic".into(),
            name: String::new(),
            value: None,
            children,
        }),
    }
}

fn node_for(tree: &Tree, h: u32, role: String, children: Vec<AxNode>) -> AxNode {
    AxNode {
        role,
        name: name_of(tree, h),
        value: value_of(tree, h),
        children,
    }
}

fn build(tree: &Tree, h: u32) -> Option<AxNode> {
    if is_skipped(tree, h) {
        return None;
    }
    let role = role_of(tree, h);
    let children = build_children(tree, h);
    match role {
        Some(r) => Some(node_for(tree, h, r, children)),
        None => prune_roleless(children),
    }
}

/// Accessibility tree for the document (`<body>` → `<html>` root).
pub fn accessibility_tree(tree: &Tree) -> AxNode {
    let root = tree
        .query_selector("body")
        .or_else(|| tree.query_selector("html"))
        .unwrap_or_else(|| tree.root());
    build(tree, root).unwrap_or(AxNode {
        role: "document".into(),
        name: String::new(),
        value: None,
        children: Vec::new(),
    })
}

/// Accessibility subtree rooted at `h` (None if it contributes nothing).
pub fn ax_subtree(tree: &Tree, h: u32) -> Option<AxNode> {
    build(tree, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first(tree: &Tree, sel: &str) -> u32 {
        tree.query_selector(sel).unwrap()
    }

    #[test]
    fn roles_names_and_nesting() {
        let tree = Tree::parse("<nav><a href='/'>Home</a><a href='/x'>X</a></nav>");
        // roleless <body> with a single roled child collapses to that child (nav)
        let nav = accessibility_tree(&tree);
        assert_eq!(nav.role, "navigation");
        assert_eq!(nav.children.len(), 2);
        assert_eq!(nav.children[0].role, "link");
        assert_eq!(nav.children[0].name, "Home");
    }

    #[test]
    fn explicit_role_and_aria_label() {
        let tree = Tree::parse("<div role='alert' aria-label='Boom'>x</div>");
        let n = ax_subtree(&tree, first(&tree, "div")).unwrap();
        assert_eq!(n.role, "alert");
        assert_eq!(n.name, "Boom");
    }

    #[test]
    fn input_roles_and_value() {
        let tree = Tree::parse("<input type='checkbox'><input value='hi'><input type='hidden'>");
        assert_eq!(
            ax_subtree(&tree, first(&tree, "[type=checkbox]"))
                .unwrap()
                .role,
            "checkbox"
        );
        let text = ax_subtree(&tree, first(&tree, "[value=hi]")).unwrap();
        assert_eq!(text.role, "textbox");
        assert_eq!(text.value.as_deref(), Some("hi"));
        // hidden input → skipped entirely
        assert!(ax_subtree(&tree, first(&tree, "[type=hidden]")).is_none());
    }

    #[test]
    fn img_name_from_alt() {
        let tree = Tree::parse("<img alt='A cat' src='/c.png'>");
        assert_eq!(
            ax_subtree(&tree, first(&tree, "img")).unwrap().name,
            "A cat"
        );
    }

    #[test]
    fn aria_hidden_and_skip_tags_pruned() {
        let tree = Tree::parse(
            "<main><p>keep</p><script>x</script><div aria-hidden='true'>no</div></main>",
        );
        let main = ax_subtree(&tree, first(&tree, "main")).unwrap();
        assert_eq!(main.role, "main");
        // only the paragraph survives
        assert_eq!(main.children.len(), 1);
        assert_eq!(main.children[0].role, "paragraph");
    }

    #[test]
    fn roleless_single_child_collapses() {
        let tree = Tree::parse("<div><span><a href='/'>L</a></span></div>");
        // div + span are roleless → collapse to the single link
        let n = ax_subtree(&tree, first(&tree, "div")).unwrap();
        assert_eq!(n.role, "link");
    }

    #[test]
    fn roleless_multi_child_becomes_generic() {
        let tree = Tree::parse("<div><a href='/a'>A</a><a href='/b'>B</a></div>");
        let n = ax_subtree(&tree, first(&tree, "div")).unwrap();
        assert_eq!(n.role, "generic");
        assert_eq!(n.children.len(), 2);
    }

    #[test]
    fn textarea_and_select_values() {
        let ta = Tree::parse("<textarea>typed</textarea>");
        assert_eq!(
            ax_subtree(&ta, first(&ta, "textarea"))
                .unwrap()
                .value
                .as_deref(),
            Some("typed")
        );
        let sel =
            Tree::parse("<select><option>a</option><option selected value='b'>B</option></select>");
        assert_eq!(
            ax_subtree(&sel, first(&sel, "select"))
                .unwrap()
                .value
                .as_deref(),
            Some("b")
        );
    }

    #[test]
    fn non_element_node_is_skipped() {
        let tree = Tree::parse("<p>hi</p>");
        let text_node = tree.children(first(&tree, "p"))[0];
        assert!(ax_subtree(&tree, text_node).is_none());
    }

    #[test]
    fn foreign_select_options_not_counted() {
        let tree = Tree::parse(
            "<select id='a'><option>x</option></select>\
             <select id='b'><option selected value='v'>V</option></select>",
        );
        // 'a' has no selected option of its own; 'b's selected option (not a's
        // descendant) must not leak across.
        assert_eq!(ax_subtree(&tree, first(&tree, "#a")).unwrap().value, None);
        assert_eq!(
            ax_subtree(&tree, first(&tree, "#b"))
                .unwrap()
                .value
                .as_deref(),
            Some("v")
        );
    }

    #[test]
    fn empty_document_is_document_role() {
        let tree = Tree::parse("<head><title>t</title></head>");
        let ax = accessibility_tree(&tree);
        assert_eq!(ax.role, "document");
    }

    #[test]
    fn serializes_to_json_omitting_empties() {
        let tree = Tree::parse("<button>Go</button>");
        let n = ax_subtree(&tree, first(&tree, "button")).unwrap();
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(v, serde_json::json!({"role": "button", "name": "Go"}));
    }
}
