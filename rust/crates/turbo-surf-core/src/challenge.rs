//! Optional **challenge-solver integration**: detect a JS-challenge / proof-of-work
//! WAF wall (Akamai Bot Manager, DataDome, Kasada, Cloudflare) and hand it to a
//! server-side solver (Hyper Solutions or Scrapfly) that runs the vendor's VM and
//! returns valid tokens/cookies to replay on turbo-surf's fast path.
//!
//! turbo-surf cannot self-solve these in-isolate (no raster/GPU for active
//! canvas/WebGL fingerprints; the VMs re-obfuscate continuously) — see the tier-3
//! notes. This module is the seam to *rent* that layer: detection is local and
//! free; [`ChallengeSolver`] is the pluggable remote step.
//!
//! Configuration is via env (optionally a `.env` file): [`solver_from_env`]
//! returns `None` when no key is set, so this is entirely inert until wired to a
//! real account. Placeholder keys (`.env.example`) are recognised and ignored.
//!
//! **IP/JA3 pinning:** solver-issued tokens are bound to the egress IP + TLS
//! fingerprint that generated them. Pass the same proxy via [`SolveContext`] that
//! you replay the token through, or the token is rejected (the #1 failure mode).

use crate::http_backend as http;
use std::time::Duration;

/// The anti-bot vendor behind a detected wall.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vendor {
    Akamai,
    DataDome,
    Kasada,
    Cloudflare,
}

impl Vendor {
    pub fn as_str(self) -> &'static str {
        match self {
            Vendor::Akamai => "akamai",
            Vendor::DataDome => "datadome",
            Vendor::Kasada => "kasada",
            Vendor::Cloudflare => "cloudflare",
        }
    }
}

/// A detected challenge wall on a response.
#[derive(Debug, Clone)]
pub struct Challenge {
    pub vendor: Vendor,
    pub page_url: String,
}

/// Identity to pin the solve to — must match what you replay the token through.
#[derive(Debug, Clone, Default)]
pub struct SolveContext {
    pub user_agent: String,
    /// Egress proxy URL (e.g. `http://user:pass@host:port`). The token is bound to
    /// this IP; replay through the same one.
    pub proxy: Option<String>,
}

/// A solved token: cookies (and any extra headers) to attach to subsequent
/// requests, valid for roughly `ttl`.
#[derive(Debug, Clone)]
pub struct SolvedToken {
    pub cookies: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub ttl: Duration,
}

#[derive(Debug)]
pub enum SolveError {
    NotConfigured,
    Http(String),
    Parse(String),
    Unsupported(Vendor),
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SolveError::NotConfigured => write!(f, "no solver configured"),
            SolveError::Http(e) => write!(f, "solver HTTP error: {e}"),
            SolveError::Parse(e) => write!(f, "solver response parse error: {e}"),
            SolveError::Unsupported(v) => write!(f, "solver does not support {}", v.as_str()),
        }
    }
}
impl std::error::Error for SolveError {}

/// A pluggable remote solver. Implemented by [`HyperSolver`] and [`ScrapflySolver`].
#[async_trait::async_trait]
pub trait ChallengeSolver: Send + Sync {
    async fn solve(&self, ch: &Challenge, ctx: &SolveContext) -> Result<SolvedToken, SolveError>;
    fn name(&self) -> &'static str;
}

// ---- detection -------------------------------------------------------------

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn has_set_cookie(headers: &[(String, String)], needle: &str) -> bool {
    headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("set-cookie") && v.contains(needle))
}

/// Sniff a response for a known challenge wall. Header-first (most reliable),
/// with a few body markers as backup. Returns `None` for a normal page — note a
/// site can *use* a vendor without the current response *being* a challenge, so
/// detection keys on challenge-specific signals (e.g. Cloudflare's
/// `cf-mitigated: challenge`, not the ever-present `Server: cloudflare`).
pub fn detect(
    page_url: &str,
    _status: u16,
    headers: &[(String, String)],
    body: &str,
) -> Option<Challenge> {
    let here = |vendor| {
        Some(Challenge {
            vendor,
            page_url: page_url.to_string(),
        })
    };

    // Cloudflare managed challenge / Turnstile.
    if header(headers, "cf-mitigated").is_some_and(|v| v.contains("challenge"))
        || has_set_cookie(headers, "cf_clearance")
        || body.contains("__cf_chl")
        || body.contains("/cdn-cgi/challenge-platform/")
    {
        return here(Vendor::Cloudflare);
    }
    // DataDome.
    if has_set_cookie(headers, "datadome")
        || header(headers, "x-datadome").is_some()
        || header(headers, "x-datadome-cid").is_some()
        || body.contains("geo.captcha-delivery.com")
    {
        return here(Vendor::DataDome);
    }
    // Kasada.
    if header(headers, "x-kpsdk-ct").is_some()
        || header(headers, "x-kpsdk-st").is_some()
        || body.contains("KPSDK")
        || body.contains("/ips.js")
    {
        return here(Vendor::Kasada);
    }
    // Akamai Bot Manager (its sensor cookies).
    if has_set_cookie(headers, "_abck")
        || has_set_cookie(headers, "bm_sz")
        || has_set_cookie(headers, "ak_bmsc")
    {
        return here(Vendor::Akamai);
    }
    None
}

// ---- orchestration ---------------------------------------------------------

/// Detect a wall on a response and, if present, solve it. `Ok(None)` means the
/// response was a normal page (no challenge).
pub async fn solve_if_challenged(
    solver: &dyn ChallengeSolver,
    page_url: &str,
    status: u16,
    headers: &[(String, String)],
    body: &str,
    ctx: &SolveContext,
) -> Result<Option<SolvedToken>, SolveError> {
    match detect(page_url, status, headers, body) {
        Some(ch) => solver.solve(&ch, ctx).await.map(Some),
        None => Ok(None),
    }
}

fn enc(s: &str) -> String {
    // Minimal percent-encoding for query values (RFC 3986 unreserved kept raw).
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---- Scrapfly adapter ------------------------------------------------------

/// Scrapfly's Anti-Scraping-Protection (ASP) API: it renders the page through a
/// real browser + residential proxy and returns the page plus the cleared
/// cookies. Base URL is overridable for tests.
pub struct ScrapflySolver {
    api_key: String,
    base_url: String,
    client: http::Client,
}

impl ScrapflySolver {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            base_url: "https://api.scrapfly.io".to_string(),
            client: crate::net::build_client(),
        }
    }
    pub fn with_base_url(mut self, base_url: String) -> Self {
        self.base_url = base_url;
        self
    }
}

#[async_trait::async_trait]
impl ChallengeSolver for ScrapflySolver {
    fn name(&self) -> &'static str {
        "scrapfly"
    }

    async fn solve(&self, ch: &Challenge, ctx: &SolveContext) -> Result<SolvedToken, SolveError> {
        // GET /scrape?key=..&url=..&asp=true&render_js=true[&proxy_pool=..]
        let mut url = format!(
            "{}/scrape?key={}&asp=true&render_js=true&url={}",
            self.base_url,
            enc(&self.api_key),
            enc(&ch.page_url),
        );
        if ctx.proxy.is_some() {
            url.push_str("&proxy_pool=public_residential_pool");
        }
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| SolveError::Http(e.to_string()))?;
        let text = resp
            .text()
            .await
            .map_err(|e| SolveError::Http(e.to_string()))?;
        let json: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| SolveError::Parse(e.to_string()))?;
        // result.cookies: [{ name, value, ... }]
        let cookies = json["result"]["cookies"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|c| {
                        Some((
                            c["name"].as_str()?.to_string(),
                            c["value"].as_str()?.to_string(),
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(SolvedToken {
            cookies,
            headers: Vec::new(),
            ttl: Duration::from_secs(30 * 60),
        })
    }
}

// ---- Hyper Solutions adapter ----------------------------------------------

/// Hyper Solutions: per-vendor token-generation endpoints (no browser). The exact
/// request/response fields differ per vendor and are finalised against a live key
/// — this is the structural best-effort (defensive parsing of the token/cookie
/// field). Base URL overridable for tests.
pub struct HyperSolver {
    api_key: String,
    base_url: String,
    client: http::Client,
}

impl HyperSolver {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            base_url: "https://api.hypersolutions.co".to_string(),
            client: crate::net::build_client(),
        }
    }
    pub fn with_base_url(mut self, base_url: String) -> Self {
        self.base_url = base_url;
        self
    }

    fn path(vendor: Vendor) -> &'static str {
        match vendor {
            Vendor::Akamai => "/akamai/v1/sensor",
            Vendor::DataDome => "/datadome/v1/interstitial",
            Vendor::Kasada => "/kasada/v1/payload",
            // Cloudflare is Scrapfly's lane in our setup; Hyper focuses on the
            // other three. Surfaced as Unsupported so the caller can fall back.
            Vendor::Cloudflare => "",
        }
    }
}

#[async_trait::async_trait]
impl ChallengeSolver for HyperSolver {
    fn name(&self) -> &'static str {
        "hyper"
    }

    async fn solve(&self, ch: &Challenge, ctx: &SolveContext) -> Result<SolvedToken, SolveError> {
        let path = Self::path(ch.vendor);
        if path.is_empty() {
            return Err(SolveError::Unsupported(ch.vendor));
        }
        let body = serde_json::json!({
            "site": ch.page_url,
            "userAgent": ctx.user_agent,
            "proxy": ctx.proxy,
        });
        let resp = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| SolveError::Http(e.to_string()))?;
        let text = resp
            .text()
            .await
            .map_err(|e| SolveError::Http(e.to_string()))?;
        let json: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| SolveError::Parse(e.to_string()))?;
        // Vendors return either ready-to-set cookies (e.g. Akamai _abck) or a
        // header token (e.g. Kasada x-kpsdk-ct). Accept both shapes defensively.
        let mut cookies = Vec::new();
        let mut headers = Vec::new();
        if let Some(obj) = json["cookies"].as_object() {
            for (k, v) in obj {
                if let Some(v) = v.as_str() {
                    cookies.push((k.clone(), v.to_string()));
                }
            }
        }
        if let Some(obj) = json["headers"].as_object() {
            for (k, v) in obj {
                if let Some(v) = v.as_str() {
                    headers.push((k.clone(), v.to_string()));
                }
            }
        }
        if cookies.is_empty() && headers.is_empty() {
            return Err(SolveError::Parse(format!("no token in response: {text}")));
        }
        Ok(SolvedToken {
            cookies,
            headers,
            // Akamai _abck / Kasada ct are reusable for tens of minutes.
            ttl: Duration::from_secs(30 * 60),
        })
    }
}

// ---- env / .env configuration ---------------------------------------------

// Treat the committed `.env.example` placeholders as "unset".
fn is_real_key(v: &str) -> bool {
    !v.is_empty() && !v.starts_with("your_") && !v.contains("_here")
}

// Load `.env` (first found walking up from CWD) into the process env, without
// overwriting already-set vars. Tiny parser — no dotenv dependency.
fn load_dotenv() {
    for candidate in [".env", "../.env", "../../.env", "../../../.env"] {
        let Ok(contents) = std::fs::read_to_string(candidate) else {
            continue;
        };
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let (k, v) = (k.trim(), v.trim().trim_matches('"'));
                if std::env::var(k).is_err() {
                    // Safe on edition 2021; this runs before any solver thread.
                    std::env::set_var(k, v);
                }
            }
        }
        return;
    }
}

/// Build a solver from env (loading `.env` if present). `TURBO_SURF_SOLVER` picks
/// `hyper`|`scrapfly`; otherwise the first key present wins. Returns `None` when
/// nothing is configured — so the whole feature is inert until a real key is set.
pub fn solver_from_env() -> Option<Box<dyn ChallengeSolver>> {
    load_dotenv();
    let hyper = std::env::var("HYPER_API_KEY")
        .ok()
        .filter(|v| is_real_key(v));
    let scrapfly = std::env::var("SCRAPFLY_API_KEY")
        .ok()
        .filter(|v| is_real_key(v));
    let pick = std::env::var("TURBO_SURF_SOLVER")
        .unwrap_or_default()
        .to_ascii_lowercase();
    match pick.as_str() {
        "hyper" => hyper.map(|k| Box::new(HyperSolver::new(k)) as Box<dyn ChallengeSolver>),
        "scrapfly" => {
            scrapfly.map(|k| Box::new(ScrapflySolver::new(k)) as Box<dyn ChallengeSolver>)
        }
        _ => hyper
            .map(|k| Box::new(HyperSolver::new(k)) as Box<dyn ChallengeSolver>)
            .or_else(|| {
                scrapfly.map(|k| Box::new(ScrapflySolver::new(k)) as Box<dyn ChallengeSolver>)
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdr(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn detects_each_vendor() {
        let u = "https://x.test/";
        assert_eq!(
            detect(u, 403, &hdr(&[("set-cookie", "_abck=1~-1~...")]), "").map(|c| c.vendor),
            Some(Vendor::Akamai)
        );
        assert_eq!(
            detect(u, 403, &hdr(&[("set-cookie", "datadome=abc; Path=/")]), "").map(|c| c.vendor),
            Some(Vendor::DataDome)
        );
        assert_eq!(
            detect(u, 429, &hdr(&[("x-kpsdk-ct", "tok")]), "").map(|c| c.vendor),
            Some(Vendor::Kasada)
        );
        assert_eq!(
            detect(u, 403, &hdr(&[("cf-mitigated", "challenge")]), "").map(|c| c.vendor),
            Some(Vendor::Cloudflare)
        );
        // A plain page is not a challenge.
        assert!(detect(u, 200, &hdr(&[("server", "cloudflare")]), "<html>ok</html>").is_none());
    }

    #[test]
    fn body_markers_detect() {
        let u = "https://x.test/";
        assert_eq!(
            detect(u, 200, &[], "loading <script src=\"/ips.js\">").map(|c| c.vendor),
            Some(Vendor::Kasada)
        );
        assert_eq!(
            detect(u, 200, &[], "<div id=\"/cdn-cgi/challenge-platform/h/b\">").map(|c| c.vendor),
            Some(Vendor::Cloudflare)
        );
    }

    #[test]
    fn env_selection_ignores_placeholders() {
        // Fresh keys for this test; placeholders must read as unset.
        std::env::set_var("SCRAPFLY_API_KEY", "your_scrapfly_key_here");
        std::env::remove_var("HYPER_API_KEY");
        std::env::set_var("TURBO_SURF_SOLVER", "scrapfly");
        assert!(
            solver_from_env().is_none(),
            "placeholder counted as configured"
        );

        std::env::set_var("SCRAPFLY_API_KEY", "sk_real_abc123");
        let s = solver_from_env().expect("real key → solver");
        assert_eq!(s.name(), "scrapfly");
        std::env::remove_var("SCRAPFLY_API_KEY");
        std::env::remove_var("TURBO_SURF_SOLVER");
    }

    #[tokio::test]
    async fn scrapfly_parses_cleared_cookies() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        // Mock the Scrapfly API: return its JSON envelope with cleared cookies.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf).await;
            let body = r#"{"result":{"cookies":[{"name":"cf_clearance","value":"TOKEN123"}]}}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
        });
        let solver =
            ScrapflySolver::new("k".into()).with_base_url(format!("http://127.0.0.1:{port}"));
        let ch = Challenge {
            vendor: Vendor::Cloudflare,
            page_url: "https://x.test/".into(),
        };
        let token = solver.solve(&ch, &SolveContext::default()).await.unwrap();
        assert_eq!(
            token.cookies,
            vec![("cf_clearance".to_string(), "TOKEN123".to_string())]
        );
    }
}
