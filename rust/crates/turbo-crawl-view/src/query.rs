//! Unified node-query (port of `src/query.mjs`): query by CSS selector OR XPath,
//! get back matches as `{ node, html, text }`. `Auto` treats a selector starting
//! with `/`, `./`, or `(` as XPath, else CSS. Sizzle-only extensions (`:contains`)
//! are NOT supported — use the XPath `text()` predicate.

use crate::text::text;
use crate::xpath::{evaluate, XPath};
use turbo_dom_parser::rtdom::serialize::serialize_outer;
use turbo_dom_parser::rtdom::Tree;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum QueryType {
    Auto,
    Css,
    Xpath,
}

/// One match. `node` is `None` for an XPath trailing-`@attr` value result, where
/// `value` carries the attribute string and `text` mirrors it.
#[derive(Debug, PartialEq)]
pub struct Match {
    pub node: Option<u32>,
    pub html: Option<String>,
    pub text: String,
    pub value: Option<String>,
}

fn looks_like_xpath(selector: &str) -> bool {
    let s = selector.trim_start();
    s.starts_with('/') || s.starts_with('(') || selector.starts_with("./")
}

fn resolve_type(selector: &str, ty: QueryType) -> QueryType {
    match ty {
        QueryType::Css | QueryType::Xpath => ty,
        QueryType::Auto if looks_like_xpath(selector) => QueryType::Xpath,
        QueryType::Auto => QueryType::Css,
    }
}

fn describe(tree: &Tree, h: u32) -> Match {
    Match {
        node: Some(h),
        html: Some(serialize_outer(tree, h)),
        text: text(tree, h),
        value: None,
    }
}

fn css_results(tree: &Tree, root: u32, selector: &str) -> Vec<Match> {
    let _ = root; // turbo-dom query is document-scoped (matches the JS default)
    tree.query_selector_all(selector)
        .iter()
        .map(|&h| describe(tree, h))
        .collect()
}

fn xpath_results(tree: &Tree, root: u32, selector: &str) -> Vec<Match> {
    match evaluate(tree, root, selector) {
        XPath::Values(values) => values
            .into_iter()
            .map(|value| Match {
                node: None,
                html: None,
                text: value.clone(),
                value: Some(value),
            })
            .collect(),
        XPath::Nodes(nodes) => nodes.into_iter().map(|h| describe(tree, h)).collect(),
    }
}

/// Query `tree` (rooted at `root`) by CSS or XPath.
pub fn query(tree: &Tree, root: u32, selector: &str, ty: QueryType) -> Vec<Match> {
    match resolve_type(selector, ty) {
        QueryType::Xpath => xpath_results(tree, root, selector),
        _ => css_results(tree, root, selector),
    }
}

/// First match, or `None`.
pub fn query_first(tree: &Tree, root: u32, selector: &str, ty: QueryType) -> Option<Match> {
    query(tree, root, selector, ty).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_detects_css_vs_xpath() {
        assert_eq!(resolve_type("//a", QueryType::Auto), QueryType::Xpath);
        assert_eq!(resolve_type("(//a)", QueryType::Auto), QueryType::Xpath);
        assert_eq!(resolve_type("./a", QueryType::Auto), QueryType::Xpath);
        assert_eq!(resolve_type(".item", QueryType::Auto), QueryType::Css);
        // explicit override wins
        assert_eq!(resolve_type("//a", QueryType::Css), QueryType::Css);
    }

    #[test]
    fn css_query_returns_html_and_text() {
        let tree = Tree::parse("<ul><li class='x'>one</li><li class='x'>two</li></ul>");
        let r = query(&tree, tree.root(), ".x", QueryType::Auto);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].text, "one");
        assert!(r[0].html.as_deref().unwrap().contains("<li"));
        assert!(r[0].node.is_some());
    }

    #[test]
    fn xpath_nodes_and_first() {
        let tree = Tree::parse("<div><p>a</p><p>b</p></div>");
        let first = query_first(&tree, tree.root(), "//p", QueryType::Auto).unwrap();
        assert_eq!(first.text, "a");
    }

    #[test]
    fn xpath_attribute_values() {
        let tree = Tree::parse("<a href='/x'>x</a><a href='/y'>y</a>");
        let r = query(&tree, tree.root(), "//a/@href", QueryType::Auto);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].value.as_deref(), Some("/x"));
        assert_eq!(r[0].node, None);
        assert_eq!(r[1].text, "/y");
    }

    #[test]
    fn first_on_empty_is_none() {
        let tree = Tree::parse("<p>a</p>");
        assert!(query_first(&tree, tree.root(), ".nope", QueryType::Auto).is_none());
    }

    #[test]
    fn explicit_xpath_type() {
        let tree = Tree::parse("<div><b>x</b></div>");
        let r = query(&tree, tree.root(), "//b", QueryType::Xpath);
        assert_eq!(r.len(), 1);
    }
}
