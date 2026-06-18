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
        // turbo-dom returns an Rc<[Handle]> (zero-copy from its query cache).
        for h in tree.query_selector_all(selector).iter() {
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
    use crate::dom::render_page_with_budget;
    use crate::{render_html, render_html_async, render_page, run_with_dom};
    use std::rc::Rc;

    #[tokio::test]
    async fn mock_spa_hydrates_into_root() {
        // A framework-shaped bundle: mounts into #root, holds state, and re-renders
        // after an effect (setTimeout) — the SPA hydration path end to end.
        let dom = Rc::new(TreeDom::parse(
            "<html><body><div id='root'></div></body></html>",
        ));
        let bundle = r#"
            const root = document.getElementById('root');
            let state = { count: 0, items: ['a', 'b'] };
            function render() {
              root.innerHTML = '';
              const app = document.createElement('div');
              app.setAttribute('class', 'app');
              const h = document.createElement('h1');
              h.textContent = 'Count: ' + state.count;
              app.appendChild(h);
              const ul = document.createElement('ul');
              for (const it of state.items) {
                const li = document.createElement('li');
                li.textContent = it;
                ul.appendChild(li);
              }
              app.appendChild(ul);
              root.appendChild(app);
            }
            render();                                   // initial mount
            setTimeout(() => {                          // effect → setState → re-render
              state.count = 5;
              state.items.push('c');
              render();
            }, 10);
        "#;
        // turbo-dom serializes spaces as &nbsp; — normalize for the assertions.
        let html = render_page(dom, "https://x.test/", bundle)
            .await
            .unwrap()
            .replace("&nbsp;", " ");
        assert!(html.contains(r#"<div class="app">"#), "got: {html}");
        assert!(html.contains("<h1>Count: 5</h1>"), "got: {html}");
        assert!(html.contains("<li>c</li>"), "got: {html}");
    }

    #[tokio::test]
    async fn mock_spa_fetches_data_via_xhr() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let mut b = [0u8; 512];
                let _ = s.read(&mut b).await;
                let body = r#"{"title":"From XHR"}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.flush().await;
            }
        });
        let dom = Rc::new(TreeDom::parse("<body><div id='root'>loading</div></body>"));
        let bundle = r#"
            const xhr = new XMLHttpRequest();
            xhr.open('GET', '/data.json');
            xhr.onload = () => {
              const d = JSON.parse(xhr.responseText);
              document.getElementById('root').textContent = d.title;
            };
            xhr.send();
        "#;
        let html = render_page(dom, &format!("http://127.0.0.1:{port}/"), bundle)
            .await
            .unwrap()
            .replace("&nbsp;", " ");
        assert!(html.contains("From XHR"), "got: {html}");
    }

    #[tokio::test]
    async fn runaway_script_hits_render_budget() {
        // A synchronous infinite loop must be terminated by the watchdog, not hang.
        let dom = Rc::new(TreeDom::parse("<body><div id='app'></div></body>"));
        let err = render_page_with_budget(dom, "https://x.test/", "while (true) {}", 200)
            .await
            .unwrap_err();
        assert!(err.contains("budget exceeded"), "got: {err}");
    }

    #[tokio::test]
    async fn fetch_over_net_hydrates_from_localhost() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        // Localhost server returns JSON the page fetches and renders (offline).
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let mut b = [0u8; 512];
                let _ = s.read(&mut b).await;
                let body = r#"{"msg":"from-fetch"}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.flush().await;
            }
        });
        let dom = Rc::new(TreeDom::parse(
            "<html><body><div id='app'></div></body></html>",
        ));
        let html = render_page(
            dom,
            &format!("http://127.0.0.1:{port}/"),
            r#"
            (async () => {
              const r = await fetch('/data.json');
              const j = await r.json();
              document.getElementById('app').textContent = j.msg + ':' + r.status;
            })();
            "#,
        )
        .await
        .unwrap();
        assert!(html.contains("from-fetch:200"), "got: {html}");
    }

    #[tokio::test]
    async fn fetch_failure_surfaces_as_failed_response() {
        let dom = Rc::new(TreeDom::parse(
            "<html><body><div id='app'></div></body></html>",
        ));
        // Nothing listening → fetch resolves to a failed Response (no throw).
        let html = render_page(
            dom,
            "http://127.0.0.1:1/",
            r#"
            (async () => {
              const r = await fetch('/x');
              document.getElementById('app').textContent = 'ok=' + r.ok + '/st=' + r.status;
            })();
            "#,
        )
        .await
        .unwrap();
        assert!(html.contains("ok=false/st=0"), "got: {html}");
    }

    #[tokio::test]
    async fn async_promise_hydration_resolves() {
        let dom = Rc::new(TreeDom::parse(
            "<html><body><div id='app'></div></body></html>",
        ));
        // Hydrate via a microtask + an awaited timer — both must resolve before
        // serialization (the event-loop-driven path).
        let html = render_html_async(
            dom,
            r#"
            Promise.resolve().then(() => {
              document.getElementById('app').innerHTML = '<p>micro</p>';
            });
            (async () => {
              await new Promise((r) => setTimeout(r, 5));
              const s = document.createElement('span');
              s.textContent = 'awaited';
              document.getElementById('app').appendChild(s);
            })();
            "#,
        )
        .await
        .unwrap();
        assert!(html.contains("<p>micro</p>"), "got: {html}");
        assert!(html.contains("<span>awaited</span>"), "got: {html}");
    }

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
    fn element_api_surface() {
        let dom = Rc::new(TreeDom::parse(
            "<html><body><div id='a' class='c'>hi</div></body></html>",
        ));
        // tagName / innerHTML getter / outerHTML / document.body
        assert_eq!(
            run_with_dom(dom.clone(), "document.querySelector('#a').tagName").unwrap(),
            "DIV"
        );
        assert!(
            run_with_dom(dom.clone(), "document.querySelector('#a').innerHTML")
                .unwrap()
                .contains("hi")
        );
        assert!(
            run_with_dom(dom.clone(), "document.querySelector('#a').outerHTML")
                .unwrap()
                .contains("class=\"c\"")
        );
        assert_eq!(
            run_with_dom(dom.clone(), "String(document.body !== null)").unwrap(),
            "true"
        );
        // setAttribute + id setter mutate; the shared backend persists across runs
        run_with_dom(
            dom.clone(),
            "document.querySelector('#a').setAttribute('data-x','1')",
        )
        .unwrap();
        assert_eq!(
            run_with_dom(
                dom.clone(),
                "document.querySelector('#a').getAttribute('data-x')"
            )
            .unwrap(),
            "1"
        );
        run_with_dom(dom.clone(), "document.querySelector('#a').id = 'b'").unwrap();
        assert_eq!(
            run_with_dom(dom.clone(), "String(document.getElementById('b') !== null)").unwrap(),
            "true"
        );
        // TreeDom::html() convenience serializes the (mutated) document
        assert!(dom.html().contains("data-x=\"1\""));
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
