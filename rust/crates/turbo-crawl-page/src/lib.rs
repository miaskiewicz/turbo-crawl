//! Tier 2 — `Page` / `Navigator` over the turbo-dom Rust parser.
//!
//! `TurboNavigator` is the real fetch+parse seam the crawler drives: it fetches
//! over `turbo_crawl_core::net`, parses the HTML with `turbo_dom_parser`'s
//! pure-Rust `rtdom::Tree` (no JS↔WASM boundary — every read is a plain Rust
//! call), and projects a [`Nav`]. Implementing `crawl::Navigator` lets the
//! existing tier-1 crawl driver run unchanged.
//!
//! `parse_nav` is pure (HTML in, `Nav` out) so the link/title extraction is
//! unit-tested offline; only `goto` touches the network.

use async_trait::async_trait;
use turbo_crawl_core::crawl::{Nav, Navigator};
use turbo_crawl_core::net::{fetch_html, FetchOptions};
use turbo_crawl_core::url::resolve;
use turbo_dom_parser::rtdom::Tree;

/// Parse a fetched document into a [`Nav`]: title + absolute out-links. Pure —
/// no network. `final_url` is the post-redirect URL (the link-resolution base).
pub fn parse_nav(html: &str, final_url: &str, status: u16) -> Nav {
    let tree = Tree::parse(html);
    Nav {
        url: final_url.to_string(),
        status,
        title: title_of(&tree),
        links: links_of(&tree, final_url),
        error: None,
    }
}

fn title_of(tree: &Tree) -> String {
    match tree.query_selector("title") {
        Some(h) => tree.text_content(h).trim().to_string(),
        None => String::new(),
    }
}

// Every <a href> resolved to an absolute URL against the page's final URL.
// Unresolvable hrefs (javascript:, malformed) are dropped.
fn links_of(tree: &Tree, base: &str) -> Vec<String> {
    let mut out = Vec::new();
    // turbo-dom returns an Rc<[Handle]> (zero-copy from its query cache).
    for &h in tree.query_selector_all("a[href]").iter() {
        if let Some(href) = tree.get_attribute(h, "href") {
            if let Some(abs) = resolve(base, href) {
                out.push(abs);
            }
        }
    }
    out
}

/// The fetch+parse navigator. Holds fetch defaults + one shared HTTP client so
/// connections (and TLS sessions) are reused across the whole crawl. One
/// instance is shared via `Arc<dyn Navigator>`.
pub struct TurboNavigator {
    pub max_bytes: Option<usize>,
    pub allow_non_html: bool,
    client: reqwest::Client,
}

impl Default for TurboNavigator {
    fn default() -> Self {
        Self {
            max_bytes: None,
            allow_non_html: false,
            client: turbo_crawl_core::net::build_client(),
        }
    }
}

#[async_trait]
impl Navigator for TurboNavigator {
    async fn goto(&self, url: &str) -> Result<Nav, String> {
        let opts = FetchOptions {
            max_bytes: self.max_bytes,
            allow_non_html: self.allow_non_html,
            client: Some(&self.client),
            ..Default::default()
        };
        let res = fetch_html(url, opts).await.map_err(|e| e.to_string())?;
        Ok(parse_nav(&res.html, &res.final_url, res.status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"
        <html><head><title>  Hello World  </title></head>
        <body>
          <a href="/a">A</a>
          <a href="https://other.test/b">B</a>
          <a href="mailto:x@y.test">mail</a>
          <a>no href</a>
        </body></html>"#;

    #[test]
    fn extracts_title_trimmed() {
        let nav = parse_nav(PAGE, "https://x.test/", 200);
        assert_eq!(nav.title, "Hello World");
        assert_eq!(nav.status, 200);
        assert_eq!(nav.url, "https://x.test/");
    }

    #[test]
    fn resolves_links_against_final_url() {
        let nav = parse_nav(PAGE, "https://x.test/dir/", 200);
        assert_eq!(
            nav.links,
            vec![
                "https://x.test/a".to_string(),
                "https://other.test/b".to_string(),
                "mailto:x@y.test".to_string(),
            ]
        );
    }

    #[test]
    fn empty_doc_has_no_title_or_links() {
        let nav = parse_nav("<html></html>", "https://x.test/", 200);
        assert_eq!(nav.title, "");
        assert!(nav.links.is_empty());
    }

    // End-to-end (offline): real turbo-dom parse + link extraction driving the
    // tier-1 crawl scheduler. A fixture navigator stands in for the network.
    use std::collections::HashMap;
    use std::sync::Arc;
    use turbo_crawl_core::crawl::{crawl, CrawlOptions};

    struct Fixture(HashMap<String, String>);

    #[async_trait]
    impl Navigator for Fixture {
        async fn goto(&self, url: &str) -> Result<Nav, String> {
            match self.0.get(url) {
                Some(html) => Ok(parse_nav(html, url, 200)),
                None => Err(format!("404 {url}")),
            }
        }
    }

    #[tokio::test]
    async fn crawl_follows_real_parsed_links() {
        let mut m = HashMap::new();
        m.insert(
            "https://x.test/".to_string(),
            r#"<a href="/a">a</a><a href="https://x.test/b">b</a><a href="https://off.test/c">off</a>"#
                .to_string(),
        );
        m.insert(
            "https://x.test/a".to_string(),
            "<title>A</title>".to_string(),
        );
        m.insert(
            "https://x.test/b".to_string(),
            "<title>B</title>".to_string(),
        );
        let nav = Arc::new(Fixture(m));
        let opts = CrawlOptions {
            start: vec!["https://x.test/".to_string()],
            ..Default::default()
        };
        let mut recs = crawl(opts, nav).await;
        recs.sort_by(|a, b| a.url.cmp(&b.url));
        let urls: Vec<_> = recs.iter().map(|r| r.url.as_str()).collect();
        // off-host link dropped by same-host gate; /a and /b followed
        assert_eq!(
            urls,
            vec!["https://x.test/", "https://x.test/a", "https://x.test/b"]
        );
        let a = recs.iter().find(|r| r.url.ends_with("/a")).unwrap();
        assert_eq!(a.title, "A");
    }

    // Covers TurboNavigator::goto end-to-end over a localhost server (offline).
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn spawn_html(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        port
    }

    #[tokio::test]
    async fn navigator_goto_fetches_and_parses() {
        let port = spawn_html("<title>Live</title><a href='/next'>n</a>").await;
        let nav = TurboNavigator::default();
        let res = nav
            .goto(&format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.title, "Live");
        assert_eq!(res.links, vec![format!("http://127.0.0.1:{port}/next")]);
    }

    #[tokio::test]
    async fn navigator_goto_surfaces_transport_error() {
        let nav = TurboNavigator::default();
        let err = nav.goto("http://127.0.0.1:1/").await.unwrap_err();
        assert!(!err.is_empty());
    }
}
