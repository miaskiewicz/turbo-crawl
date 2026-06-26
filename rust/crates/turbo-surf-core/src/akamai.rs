//! In-house **Akamai Bot Manager** solver — the first hand-written
//! [`crate::challenge::ChallengeSolver`] (vs renting Hyper/Scrapfly or the browser
//! sidecar). Akamai is the best feasibility:value target: ubiquitous on
//! retail/travel/airline/banking, the most publicly reverse-engineered of the
//! hard vendors, and largely *static* reads + a known `sensor_data` format.
//!
//! The hard part is [`generate_sensor`]: build the `sensor_data` payload Akamai's
//! `_abck` cookie machinery expects. The solver then POSTs it to the page's
//! sensor endpoint and reads the cleared `_abck` from the response.
//!
//! TDD: the tests below are the contract. They are RED until `generate_sensor`
//! and `AkamaiSolver::solve` are implemented. Use the render-tier `probe` mode on
//! a live `_abck` script to confirm which fields are static before filling them.

use crate::challenge::{Challenge, ChallengeSolver, SolveContext, SolveError, SolvedToken};
use crate::http_backend as http;
use std::time::Duration;

/// Akamai web `sensor_data` version this generator targets.
pub const SENSOR_VERSION: &str = "2.1.1";

/// Inputs to the `sensor_data` generator: the identity + the seed values Akamai
/// hands out on the first (challenge) response.
#[derive(Debug, Clone, Default)]
pub struct SensorInput {
    pub user_agent: String,
    pub page_url: String,
    /// The `_abck` cookie value from the challenge response (the seed to refresh).
    pub abck: String,
    /// The `bm_sz` cookie value from the challenge response.
    pub bm_sz: String,
}

/// Build the Akamai `sensor_data` payload for `input`. The string Akamai's edge
/// validates to (re)issue a valid `_abck`.
///
/// Contract (see tests): a `;`-section payload that opens with [`SENSOR_VERSION`],
/// embeds the UA + the `_abck` seed, carries the device/behavioral sections, and
/// closes with an integrity hash.
pub fn generate_sensor(input: &SensorInput) -> String {
    // Akamai-shaped sensor_data: version, identity, the _abck/bm_sz seeds, a device
    // section, synthesized pointer telemetry, and the page href — closed with an
    // integrity hash over all of it. Deterministic for a fixed input (replayable
    // per client).
    //
    // NOTE: structurally correct + the full POST/parse flow works, but the exact
    // dynamic field encoding a live Akamai edge validates must be keyed off the
    // page's `_abck` script. Use the render-tier `probe` on a real script to fill
    // the dynamic sections before expecting live acceptance.
    let sections = [
        SENSOR_VERSION.to_string(),
        format!("uar,{}", input.user_agent),
        format!("abck,{}", input.abck),
        format!("bmsz,{}", input.bm_sz),
        "scr,1920,1080,24".to_string(),
        // Synthesized pointer path (comma-delimited so it stays one section).
        "mm,0,0,1,1,2,3,5,8".to_string(),
        format!("href,{}", input.page_url),
    ];
    let payload = sections.join(";");
    format!("{payload};{:016x}", fnv1a(&payload))
}

// FNV-1a (64-bit) — deterministic, process-independent integrity hash.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Solves Akamai walls by generating `sensor_data` and POSTing it to the sensor
/// endpoint (defaults to the page URL), then reading the cleared `_abck`.
pub struct AkamaiSolver {
    sensor_url: Option<String>,
    client: http::Client,
}

impl AkamaiSolver {
    pub fn new() -> Self {
        Self {
            sensor_url: None,
            client: crate::net::build_client(),
        }
    }
    /// Override the sensor POST endpoint (defaults to the challenge page URL).
    pub fn with_sensor_url(mut self, url: String) -> Self {
        self.sensor_url = Some(url);
        self
    }
}

impl Default for AkamaiSolver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ChallengeSolver for AkamaiSolver {
    fn name(&self) -> &'static str {
        "akamai"
    }

    async fn solve(&self, ch: &Challenge, ctx: &SolveContext) -> Result<SolvedToken, SolveError> {
        let sensor = generate_sensor(&SensorInput {
            user_agent: ctx.user_agent.clone(),
            page_url: ch.page_url.clone(),
            abck: String::new(),
            bm_sz: String::new(),
        });
        // Akamai posts sensor_data back to the page (or a configured sensor path);
        // the edge replies with a refreshed _abck.
        let url = self
            .sensor_url
            .clone()
            .unwrap_or_else(|| ch.page_url.clone());
        let body = serde_json::json!({ "sensor_data": sensor }).to_string();
        let resp = self
            .client
            .post(&url)
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
                line.strip_prefix("_abck=").map(|rest| {
                    let val = rest.split(';').next().unwrap_or("").to_string();
                    ("_abck".to_string(), val)
                })
            })
            .collect();
        if cookies.is_empty() {
            return Err(SolveError::Parse("no _abck in sensor response".into()));
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

    fn input() -> SensorInput {
        SensorInput {
            user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                         (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
                .into(),
            page_url: "https://shop.example.com/".into(),
            abck: "0~seed~-1~-1".into(),
            bm_sz: "ABCDEF1234567890".into(),
        }
    }

    // RED until generate_sensor is implemented. Defines the structural contract a
    // real Akamai sensor_data satisfies.
    #[test]
    fn sensor_has_akamai_structure() {
        let s = generate_sensor(&input());
        assert!(
            s.starts_with(SENSOR_VERSION),
            "sensor must open with the version: {s}"
        );
        assert!(s.contains(&input().user_agent), "sensor must embed the UA");
        assert!(s.contains("seed"), "sensor must carry the _abck seed");
        assert!(
            s.split(';').count() >= 7,
            "sensor must have the device/behavioral sections (>=7 ;-sections)"
        );
        // Closes with a hex integrity hash section.
        let last = s.rsplit(';').next().unwrap_or("");
        assert!(
            !last.is_empty() && last.chars().all(|c| c.is_ascii_hexdigit()),
            "sensor must close with a hex integrity hash, got {last:?}"
        );
    }

    // The generator must be deterministic for a fixed input (replayable per
    // client) — RED until implemented.
    #[test]
    fn sensor_is_deterministic() {
        assert_eq!(generate_sensor(&input()), generate_sensor(&input()));
    }

    // RED until solve() is implemented: generate -> POST sensor_data -> parse the
    // cleared _abck from the response Set-Cookie. Mock Akamai sensor endpoint.
    #[tokio::test]
    async fn solver_posts_sensor_and_parses_abck() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            // The POST body must carry the generated sensor_data.
            assert!(req.contains("sensor_data"), "expected a sensor POST: {req}");
            let body = "{}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: _abck=CLEARED~0~ok; Path=/\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
        });

        let solver =
            AkamaiSolver::new().with_sensor_url(format!("http://127.0.0.1:{port}/akam/sensor"));
        let ch = Challenge {
            vendor: crate::challenge::Vendor::Akamai,
            page_url: format!("http://127.0.0.1:{port}/"),
        };
        let ctx = SolveContext {
            user_agent: input().user_agent,
            proxy: None,
        };
        let token = solver.solve(&ch, &ctx).await.unwrap();
        let abck = token.cookies.iter().find(|(k, _)| k == "_abck");
        assert!(abck.is_some(), "solve must return the cleared _abck");
        assert!(
            abck.unwrap().1.starts_with("CLEARED"),
            "must parse the issued _abck value"
        );
    }
}
