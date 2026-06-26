//! In-house **Cloudflare** solver — second hand-written
//! [`crate::challenge::ChallengeSolver`]. Cloudflare is the highest-volume target,
//! but most CF sites only run *passive* bot management, which the fingerprint +
//! seed pool already clear. This module handles the smaller **managed-challenge**
//! subset: parse the interstitial, solve its challenge, submit, harvest
//! `cf_clearance`.
//!
//! turbo-surf's angle vs the other vendors: the basic CF challenge is a **JS
//! compute** (no canvas), so it can run in the V8 render tier — no browser. The
//! flow here (parse → solve → POST → parse `cf_clearance`) is the scaffold; the
//! real per-version PoW math + the live `/cdn-cgi/challenge-platform/` params must
//! be keyed off a real challenge (run the interstitial under the `probe` mode).
//! Turnstile-interactive (canvas/behavioral) stays out — that needs the browser
//! sidecar.

use crate::challenge::{Challenge, ChallengeSolver, SolveContext, SolveError, SolvedToken, Vendor};
use crate::http_backend as http;
use std::time::Duration;

/// Parameters lifted from a Cloudflare interstitial's `window._cf_chl_opt`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChallengeParams {
    pub ray: String,
    pub cv_id: String,
}

// Extract a single-quoted-or-double-quoted JS string field `key: '...'`.
fn js_field(html: &str, key: &str) -> Option<String> {
    let pat = format!("{key}:");
    let i = html.find(&pat)? + pat.len();
    let rest = html[i..].trim_start();
    let q = rest.chars().next()?;
    if q != '\'' && q != '"' {
        return None;
    }
    let after = &rest[q.len_utf8()..];
    let end = after.find(q)?;
    Some(after[..end].to_string())
}

/// Parse the challenge parameters from interstitial HTML (`None` if it isn't a
/// recognisable managed-challenge page).
pub fn parse_challenge(html: &str) -> Option<ChallengeParams> {
    let ray = js_field(html, "cRay")?;
    let cv_id = js_field(html, "cvId").unwrap_or_default();
    Some(ChallengeParams { ray, cv_id })
}

/// Solve the challenge's proof-of-work for `params`. Deterministic for a fixed
/// challenge (the answer the orchestrate endpoint expects).
///
/// NOTE: placeholder PoW — structurally a stable answer derived from the
/// challenge, not yet the real per-version algorithm (key it off a live script).
pub fn solve_pow(params: &ChallengeParams) -> String {
    format!(
        "{:016x}",
        fnv1a(&format!("{}:{}", params.ray, params.cv_id))
    )
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Solves Cloudflare managed challenges: fetch the interstitial, parse + solve it,
/// POST the answer to the challenge-platform endpoint, read `cf_clearance`.
pub struct CloudflareSolver {
    submit_url: Option<String>,
    client: http::Client,
}

impl CloudflareSolver {
    pub fn new() -> Self {
        Self {
            submit_url: None,
            client: crate::net::build_client(),
        }
    }
    /// Override the challenge-submit endpoint (defaults to the page origin's
    /// `/cdn-cgi/challenge-platform/`).
    pub fn with_submit_url(mut self, url: String) -> Self {
        self.submit_url = Some(url);
        self
    }
}

impl Default for CloudflareSolver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ChallengeSolver for CloudflareSolver {
    fn name(&self) -> &'static str {
        "cloudflare"
    }

    async fn solve(&self, ch: &Challenge, _ctx: &SolveContext) -> Result<SolvedToken, SolveError> {
        // Fetch the interstitial and lift its challenge parameters.
        let page = self
            .client
            .get(&ch.page_url)
            .send()
            .await
            .map_err(|e| SolveError::Http(e.to_string()))?
            .text()
            .await
            .map_err(|e| SolveError::Http(e.to_string()))?;
        let params = parse_challenge(&page).ok_or(SolveError::Unsupported(Vendor::Cloudflare))?;
        let answer = solve_pow(&params);

        let submit = self.submit_url.clone().unwrap_or_else(|| {
            let origin = crate::url::origin_of(&ch.page_url).unwrap_or_else(|| ch.page_url.clone());
            format!("{origin}/cdn-cgi/challenge-platform/")
        });
        let body = serde_json::json!({ "cf_chl_answer": answer, "cRay": params.ray }).to_string();
        let resp = self
            .client
            .post(&submit)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| SolveError::Http(e.to_string()))?;

        let cookies: Vec<(String, String)> = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|line| {
                line.strip_prefix("cf_clearance=").map(|rest| {
                    (
                        "cf_clearance".to_string(),
                        rest.split(';').next().unwrap_or("").to_string(),
                    )
                })
            })
            .collect();
        if cookies.is_empty() {
            return Err(SolveError::Parse("no cf_clearance in response".into()));
        }
        Ok(SolvedToken {
            cookies,
            headers: Vec::new(),
            ttl: Duration::from_secs(30 * 60),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTERSTITIAL: &str = r#"<!DOCTYPE html><html><head><title>Just a moment…</title>
      <script>window._cf_chl_opt={cvId:'3',cZone:'x.test',cType:'managed',
        cRay:'8af0c0deadbeef42',cH:'abc',cUPMDTk:"/cdn-cgi/challenge-platform/h/b/..."};</script>
      </head><body>/cdn-cgi/challenge-platform/ checking…</body></html>"#;

    #[test]
    fn parses_challenge_params() {
        let p = parse_challenge(INTERSTITIAL).expect("managed challenge");
        assert_eq!(p.ray, "8af0c0deadbeef42");
        assert_eq!(p.cv_id, "3");
        // A normal page is not a challenge.
        assert!(parse_challenge("<html><body>ok</body></html>").is_none());
    }

    #[test]
    fn pow_is_deterministic() {
        let p = parse_challenge(INTERSTITIAL).unwrap();
        assert_eq!(solve_pow(&p), solve_pow(&p));
        assert!(solve_pow(&p).chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn solver_submits_and_parses_cf_clearance() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            // Serve the interstitial on GET, issue cf_clearance on the POST.
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let resp = if req.starts_with("POST") {
                        assert!(req.contains("cf_chl_answer"), "expected answer POST: {req}");
                        let b = "{}";
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: cf_clearance=CF~cleared~1; Path=/\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", b.len(), b)
                    } else {
                        format!("HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", INTERSTITIAL.len(), INTERSTITIAL)
                    };
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.flush().await;
                });
            }
        });
        let base = format!("http://127.0.0.1:{port}");
        let solver =
            CloudflareSolver::new().with_submit_url(format!("{base}/cdn-cgi/challenge-platform/"));
        let ch = Challenge {
            vendor: Vendor::Cloudflare,
            page_url: format!("{base}/"),
        };
        let token = solver.solve(&ch, &SolveContext::default()).await.unwrap();
        let cf = token.cookies.iter().find(|(k, _)| k == "cf_clearance");
        assert!(cf.is_some(), "must return cf_clearance");
        assert!(
            cf.unwrap().1.starts_with("CF~"),
            "must parse cf_clearance value"
        );
    }
}
