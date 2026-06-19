//! Conditional-request cache (port of `src/cache.mjs`): per-URL ETag /
//! Last-Modified validators + body. On recrawl, `net::fetch_html` sends
//! `If-None-Match` / `If-Modified-Since`; a 304 reuses the cached body (no
//! re-download). Share one instance across `Page`/`Crawler` runs to benefit.

use std::collections::HashMap;

struct Entry {
    etag: Option<String>,
    last_modified: Option<String>,
    html: String,
}

#[derive(Default)]
pub struct ResponseCache {
    store: HashMap<String, Entry>,
}

impl ResponseCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Conditional-request headers for `url` (empty if nothing cached).
    pub fn validators(&self, url: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        if let Some(e) = self.store.get(url) {
            if let Some(etag) = &e.etag {
                out.push(("if-none-match".to_string(), etag.clone()));
            }
            if let Some(lm) = &e.last_modified {
                out.push(("if-modified-since".to_string(), lm.clone()));
            }
        }
        out
    }

    /// Record a response's validators + body (only when it carries a validator).
    pub fn store(
        &mut self,
        url: &str,
        etag: Option<String>,
        last_modified: Option<String>,
        html: &str,
    ) {
        if etag.is_some() || last_modified.is_some() {
            self.store.insert(
                url.to_string(),
                Entry {
                    etag,
                    last_modified,
                    html: html.to_string(),
                },
            );
        }
    }

    /// Cached body for `url` (used on a 304), or "".
    pub fn body(&self, url: &str) -> String {
        self.store
            .get(url)
            .map(|e| e.html.clone())
            .unwrap_or_default()
    }

    pub fn size(&self) -> usize {
        self.store.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_only_with_validators_and_serves_body() {
        let mut c = ResponseCache::new();
        // no validator → not stored
        c.store("https://x.test/a", None, None, "body-a");
        assert_eq!(c.size(), 0);
        // etag → stored, validators returned, body served
        c.store("https://x.test/b", Some("\"v1\"".into()), None, "body-b");
        assert_eq!(c.size(), 1);
        assert_eq!(
            c.validators("https://x.test/b"),
            vec![("if-none-match".to_string(), "\"v1\"".to_string())]
        );
        assert_eq!(c.body("https://x.test/b"), "body-b");
        // last-modified only
        c.store(
            "https://x.test/c",
            None,
            Some("Mon, 01 Jan 2020 00:00:00 GMT".into()),
            "body-c",
        );
        assert_eq!(
            c.validators("https://x.test/c"),
            vec![(
                "if-modified-since".to_string(),
                "Mon, 01 Jan 2020 00:00:00 GMT".to_string()
            )]
        );
    }

    #[test]
    fn empty_for_unknown_url() {
        let c = ResponseCache::new();
        assert!(c.validators("https://x.test/none").is_empty());
        assert_eq!(c.body("https://x.test/none"), "");
    }
}
