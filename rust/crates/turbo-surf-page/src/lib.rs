//! Tier 2 — `Page` / `Navigator` over the turbo-dom Rust parser.
//!
//! `TurboNavigator` is the real fetch+parse seam the crawler drives: it fetches
//! over `turbo_surf_core::net`, parses the HTML with `turbo_dom_parser`'s
//! pure-Rust `rtdom::Tree` (no JS↔WASM boundary — every read is a plain Rust
//! call), and projects a [`Nav`]. Implementing `crawl::Navigator` lets the
//! existing tier-1 crawl driver run unchanged.
//!
//! `parse_nav` is pure (HTML in, `Nav` out) so the link/title extraction is
//! unit-tested offline; only `goto` touches the network.

use async_trait::async_trait;
use std::collections::BTreeMap;
use turbo_dom_parser::rtdom::Tree;
use turbo_surf_core::challenge::{self, ChallengeSolver, SolveContext};
use turbo_surf_core::crawl::{Nav, Navigator};
use turbo_surf_core::fingerprint;
use turbo_surf_core::net::{fetch_html, FetchOptions};
use turbo_surf_core::url::{host_of, resolve};

/// Parse a fetched document into a [`Nav`]: title + absolute out-links. Pure —
/// no network. `final_url` is the post-redirect URL (the link-resolution base).
pub fn parse_nav(html: &str, final_url: &str, status: u16) -> Nav {
    parse_nav_with_items(html, final_url, status, None)
}

/// Like [`parse_nav`], but also counts elements matching `item_selector` (the
/// crawl's extraction target) in the SAME parse — so the crawler reports item
/// counts without a second pass. `None` selector → `items = 0`.
pub fn parse_nav_with_items(
    html: &str,
    final_url: &str,
    status: u16,
    item_selector: Option<&str>,
) -> Nav {
    let tree = Tree::parse(html);
    let items = item_selector
        .map(|s| tree.query_selector_all(s).iter().count() as u32)
        .unwrap_or(0);
    Nav {
        url: final_url.to_string(),
        status,
        title: title_of(&tree),
        links: links_of(&tree, final_url),
        error: None,
        items,
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
    /// Optional extraction target counted per page (for the crawl benchmark's
    /// item-parity metric); `None` skips counting.
    pub item_selector: Option<String>,
    /// Optional challenge solver (Hyper/Scrapfly). `None` leaves the solve path
    /// inert; set via [`TurboNavigator::with_solver_from_env`].
    solver: Option<Box<dyn ChallengeSolver>>,
    client: turbo_surf_core::http_backend::Client,
}

impl Default for TurboNavigator {
    fn default() -> Self {
        Self {
            max_bytes: None,
            allow_non_html: false,
            item_selector: None,
            solver: None,
            client: turbo_surf_core::net::build_client(),
        }
    }
}

impl TurboNavigator {
    /// Set the per-page item selector (builder style; `client` stays private).
    pub fn with_item_selector(mut self, selector: Option<String>) -> Self {
        self.item_selector = selector;
        self
    }

    /// Enable challenge solving by reading a solver (Hyper/Scrapfly) from env /
    /// `.env`. No-op when nothing is configured.
    pub fn with_solver_from_env(mut self) -> Self {
        self.solver = challenge::solver_from_env();
        self
    }

    // Per-host Chrome identity from the seed pool: same host → same profile across
    // the crawl (stable), distinct hosts spread across the pool (varied).
    fn profile_for(url: &str) -> fingerprint::Profile {
        let key = host_of(url).unwrap_or_else(|| url.to_string());
        fingerprint::select(&key)
    }
}

#[async_trait]
impl Navigator for TurboNavigator {
    async fn goto(&self, url: &str) -> Result<Nav, String> {
        let profile = Self::profile_for(url);
        let opts = FetchOptions {
            max_bytes: self.max_bytes,
            allow_non_html: self.allow_non_html,
            client: Some(&self.client),
            profile: Some(&profile),
            ..Default::default()
        };
        let res = fetch_html(url, opts).await.map_err(|e| e.to_string())?;
        // Anti-bot wall + solver configured → solve and re-fetch once with the
        // token cookies/headers attached. (No cookie jar here, so detection keys
        // on body markers — the cookie-only Akamai signal is caught in the MCP
        // session path, which has a jar.)
        if let Some(solver) = &self.solver {
            if let Some(ch) = challenge::detect(&res.final_url, res.status, &[], &res.html) {
                let ctx = SolveContext {
                    user_agent: profile.user_agent.clone(),
                    proxy: std::env::var("TURBO_SURF_PROXY")
                        .ok()
                        .filter(|s| !s.is_empty()),
                };
                if let Ok(token) = solver.solve(&ch, &ctx).await {
                    let mut headers = BTreeMap::new();
                    if !token.cookies.is_empty() {
                        let cookie = token
                            .cookies
                            .iter()
                            .map(|(k, v)| format!("{k}={v}"))
                            .collect::<Vec<_>>()
                            .join("; ");
                        headers.insert("cookie".to_string(), cookie);
                    }
                    for (k, v) in &token.headers {
                        headers.insert(k.to_ascii_lowercase(), v.clone());
                    }
                    let retry = FetchOptions {
                        max_bytes: self.max_bytes,
                        allow_non_html: self.allow_non_html,
                        client: Some(&self.client),
                        profile: Some(&profile),
                        headers,
                        ..Default::default()
                    };
                    if let Ok(solved) = fetch_html(url, retry).await {
                        return Ok(parse_nav_with_items(
                            &solved.html,
                            &solved.final_url,
                            solved.status,
                            self.item_selector.as_deref(),
                        ));
                    }
                }
            }
        }
        Ok(parse_nav_with_items(
            &res.html,
            &res.final_url,
            res.status,
            self.item_selector.as_deref(),
        ))
    }
}

/// Batch fetch+parse a list of URLs with bounded concurrency (port of the intent
/// of `src/batch.mjs`). Order-preserving; a per-URL failure is captured as `Err`,
/// never aborting the batch.
pub async fn batch(
    nav: &TurboNavigator,
    urls: Vec<String>,
    concurrency: usize,
) -> Vec<(String, Result<Nav, String>)> {
    use futures_util::stream::{self, StreamExt};
    stream::iter(urls)
        .map(|url| async move {
            let res = nav.goto(&url).await;
            (url, res)
        })
        .buffered(concurrency.max(1))
        .collect()
        .await
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
    use turbo_surf_core::crawl::{crawl, CrawlOptions};

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
    async fn batch_is_ordered_and_captures_failures() {
        let port = spawn_html("<title>OK</title>").await;
        let nav = TurboNavigator::default();
        let urls = vec![
            format!("http://127.0.0.1:{port}/a"),
            format!("http://127.0.0.1:{port}/b"),
            "http://127.0.0.1:1/dead".to_string(),
        ];
        let res = batch(&nav, urls.clone(), 2).await;
        assert_eq!(res.len(), 3);
        // order preserved
        assert_eq!(res[0].0, urls[0]);
        assert_eq!(res[1].0, urls[1]);
        assert_eq!(res[0].1.as_ref().unwrap().title, "OK");
        // the dead URL is captured as Err, not a panic/abort
        assert!(res[2].1.is_err());
    }

    #[tokio::test]
    async fn navigator_goto_surfaces_transport_error() {
        let nav = TurboNavigator::default();
        let err = nav.goto("http://127.0.0.1:1/").await.unwrap_err();
        assert!(!err.is_empty());
    }
}
