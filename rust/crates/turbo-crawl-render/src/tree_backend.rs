//! Real `DomBackend` over the turbo-dom `rtdom::Tree`. This is the tier-3 seam
//! made concrete: page JS `document.querySelector(...)` → V8 → op → this →
//! native Rust DOM. Node ids ARE turbo-dom handles (`u32`), so the bridge is
//! zero-translation.

use crate::dom::DomBackend;
use turbo_dom_parser::rtdom::Tree;

/// Wraps a parsed `Tree` and exposes it through `DomBackend`. Construct from
/// HTML with [`TreeDom::parse`], then hand to `run_with_dom`.
pub struct TreeDom {
    tree: Tree,
}

impl TreeDom {
    pub fn parse(html: &str) -> Self {
        Self {
            tree: Tree::parse(html),
        }
    }

    pub fn tree(&self) -> &Tree {
        &self.tree
    }
}

impl DomBackend for TreeDom {
    fn query_selector(&self, selector: &str) -> Option<u32> {
        self.tree.query_selector(selector)
    }

    fn text_content(&self, node: u32) -> Option<String> {
        Some(self.tree.text_content(node))
    }

    fn get_attribute(&self, node: u32, name: &str) -> Option<String> {
        self.tree.get_attribute(node, name).map(str::to_string)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_with_dom;
    use std::rc::Rc;

    #[test]
    fn page_js_reads_real_parsed_dom() {
        let dom = Rc::new(TreeDom::parse(
            "<html><body><h1 id='title'>Hello</h1></body></html>",
        ));
        let text = run_with_dom(dom.clone(), "document.querySelector('h1').textContent").unwrap();
        assert_eq!(text, "Hello");
        let id = run_with_dom(dom, "document.querySelector('h1').getAttribute('id')").unwrap();
        assert_eq!(id, "title");
    }

    #[test]
    fn missing_node_is_null() {
        let dom = Rc::new(TreeDom::parse("<p>x</p>"));
        let out = run_with_dom(dom, "String(document.querySelector('.none'))").unwrap();
        assert_eq!(out, "null");
    }
}
