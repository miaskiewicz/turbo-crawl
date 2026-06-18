//! Real `DomBackend` over turbo-dom's `rtdom::Tree`. Node ids ARE turbo-dom
//! handles (`u32`), so the bridge is zero-translation. The `Tree` lives behind a
//! `RefCell` because page JS mutates it (create/append/setAttribute/...) and the
//! ops hold the backend through a shared `Rc`; the isolate is single-threaded so
//! a `RefCell` is sufficient (and avoids lock overhead on the hot path).

use crate::dom::DomBackend;
use std::cell::RefCell;
use turbo_dom_parser::rtdom::serialize::{serialize_inner, serialize_outer};
use turbo_dom_parser::rtdom::Tree;

pub struct TreeDom {
    tree: RefCell<Tree>,
}

impl TreeDom {
    pub fn parse(html: &str) -> Self {
        Self {
            tree: RefCell::new(Tree::parse(html)),
        }
    }

    /// Serialize the whole document (after JS) to HTML.
    pub fn html(&self) -> String {
        self.document_html()
    }
}

// First descendant of `node` matching `selector` (element.querySelector scope).
fn first_matching(tree: &Tree, node: u32, selector: &str) -> Option<u32> {
    tree.descendants(node)
        .into_iter()
        .find(|&h| tree.matches(h, selector))
}

impl DomBackend for TreeDom {
    fn query_selector(&self, selector: &str) -> Option<u32> {
        self.tree.borrow().query_selector(selector)
    }

    fn query_selector_all(&self, selector: &str) -> String {
        let tree = self.tree.borrow();
        let mut s = String::new();
        for h in tree.query_selector_all(selector) {
            if !s.is_empty() {
                s.push(' ');
            }
            s.push_str(&h.to_string());
        }
        s
    }

    fn query_within(&self, node: u32, selector: &str) -> Option<u32> {
        first_matching(&self.tree.borrow(), node, selector)
    }

    fn get_element_by_id(&self, id: &str) -> Option<u32> {
        self.tree.borrow().get_element_by_id(id)
    }

    fn text_content(&self, node: u32) -> Option<String> {
        Some(self.tree.borrow().text_content(node))
    }

    fn get_attribute(&self, node: u32, name: &str) -> Option<String> {
        self.tree
            .borrow()
            .get_attribute(node, name)
            .map(str::to_string)
    }

    fn tag_name(&self, node: u32) -> Option<String> {
        self.tree.borrow().tag_name(node)
    }

    fn inner_html(&self, node: u32) -> String {
        serialize_inner(&self.tree.borrow(), node)
    }

    fn outer_html(&self, node: u32) -> String {
        serialize_outer(&self.tree.borrow(), node)
    }

    fn document_html(&self) -> String {
        let tree = self.tree.borrow();
        serialize_inner(&tree, tree.root())
    }

    fn body(&self) -> Option<u32> {
        self.tree.borrow().query_selector("body")
    }

    fn set_text_content(&self, node: u32, text: &str) {
        self.tree.borrow_mut().set_text_content(node, text);
    }

    fn set_attribute(&self, node: u32, name: &str, value: &str) {
        self.tree.borrow_mut().set_attribute(node, name, value);
    }

    fn create_element(&self, tag: &str) -> u32 {
        self.tree.borrow_mut().create_element(tag)
    }

    fn append_child(&self, parent: u32, child: u32) {
        self.tree.borrow_mut().append_child(parent, child);
    }

    fn set_inner_html(&self, node: u32, html: &str) {
        self.tree.borrow_mut().set_inner_html(node, html);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{render_html, run_with_dom};
    use std::rc::Rc;

    #[test]
    fn reads_real_parsed_dom() {
        let dom = Rc::new(TreeDom::parse(
            "<html><body><h1 id='title'>Hello</h1></body></html>",
        ));
        assert_eq!(
            run_with_dom(dom.clone(), "document.querySelector('h1').textContent").unwrap(),
            "Hello"
        );
        assert_eq!(
            run_with_dom(dom, "document.getElementById('title').getAttribute('id')").unwrap(),
            "title"
        );
    }

    #[test]
    fn query_selector_all_returns_list() {
        let dom = Rc::new(TreeDom::parse("<ul><li>a</li><li>b</li><li>c</li></ul>"));
        let n = run_with_dom(dom, "String(document.querySelectorAll('li').length)").unwrap();
        assert_eq!(n, "3");
    }

    // The headline tier-3 capability: a JS-gated page renders to hydrated HTML.
    #[test]
    fn page_script_hydrates_then_serializes() {
        let dom = Rc::new(TreeDom::parse(
            "<html><body><div id='app'></div></body></html>",
        ));
        let html = render_html(
            dom,
            r#"
            const app = document.getElementById('app');
            app.innerHTML = '<p class="msg">hydrated</p>';
            setTimeout(() => {
              const span = document.createElement('span');
              span.textContent = 'fromtimer';
              app.appendChild(span);
            }, 10);
            "#,
        )
        .unwrap();
        assert!(
            html.contains(r#"<p class="msg">hydrated</p>"#),
            "got: {html}"
        );
        assert!(html.contains("<span>fromtimer</span>"), "got: {html}");
    }

    #[test]
    fn scoped_query_within_element() {
        let dom = Rc::new(TreeDom::parse(
            "<div id='a'><span class='x'>1</span></div><span class='x'>2</span>",
        ));
        let txt = run_with_dom(
            dom,
            "document.getElementById('a').querySelector('.x').textContent",
        )
        .unwrap();
        assert_eq!(txt, "1");
    }
}
