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
    for h in tree.query_selector_all("a[href]") {
        if let Some(href) = tree.get_attribute(h, "href") {
            if let Some(abs) = resolve(base, href) {
                out.push(abs);
            }
        }
    }
    out
}

/// The fetch+parse navigator. Holds fetch defaults; one instance is shared
/// across the crawl (`Arc<dyn Navigator>`).
#[derive(Default)]
pub struct TurboNavigator {
    pub max_bytes: Option<usize>,
    pub allow_non_html: bool,
}

#[async_trait]
impl Navigator for TurboNavigator {
    async fn goto(&self, url: &str) -> Result<Nav, String> {
        let opts = FetchOptions {
            max_bytes: self.max_bytes,
            allow_non_html: self.allow_non_html,
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
}
