//! Differential parity (task #13): the Rust ports must produce byte-identical
//! output to the JS implementation for the same inputs. The golden values are
//! generated from `turbo-surf/src/*.mjs` by `rust/parity/gen-golden.mjs`;
//! this test runs the Rust ports over the SAME inputs and asserts equality.
//!
//! Skip-gated on `golden.json` presence so CI stays green without Node (the
//! committed golden lets it run; regenerate with the node script after JS edits).

use async_trait::async_trait;
use serde_json::Value;
use turbo_surf_core::cookies::CookieJar;
use turbo_surf_core::robots::{RobotsCache, RobotsFetcher};
use turbo_surf_core::url::{canonicalize, is_http_url, resolve};

// Must mirror the input lists in rust/parity/gen-golden.mjs exactly.
const CANON: &[&str] = &[
    "https://X.test/p?b=2&utm_source=g&a=1#h",
    "https://x.test",
    "http://x.test:80/a",
    "https://x.test/a/../b",
    "https://x.test/p?z=1&a=2&a=1",
];
const RESOLVE: &[(&str, &str)] = &[
    ("https://x.test/a/b", "../c"),
    ("https://x.test/", "https://y.test/z"),
    ("https://x.test/", ""),
];
const HTTP: &[&str] = &[
    "http://x.test",
    "https://x.test",
    "mailto:a@b.test",
    "not a url",
];
const ROBOTS_TXT: &str = "User-agent: *\nDisallow: /private\nAllow: /private/ok\nCrawl-delay: 3\n";
const ROBOT_PATHS: &[&str] = &["/private/x", "/private/ok/y", "/public", "/private"];

fn golden() -> Option<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../parity/golden.json");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn arr_str(v: &Value) -> Vec<Option<String>> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().map(str::to_string))
        .collect()
}

struct StubRobots;
#[async_trait]
impl RobotsFetcher for StubRobots {
    async fn fetch_text(&self, _url: &str) -> Result<(u16, String), ()> {
        Ok((200, ROBOTS_TXT.to_string()))
    }
}

#[tokio::test]
async fn rust_matches_js_golden() {
    let Some(g) = golden() else {
        eprintln!("parity: golden.json absent — skipping (run rust/parity/gen-golden.mjs)");
        return;
    };

    // --- url ---
    let canon: Vec<Option<String>> = CANON.iter().map(|u| canonicalize(u)).collect();
    assert_eq!(
        canon,
        arr_str(&g["url"]["canonicalize"]),
        "canonicalize parity"
    );

    let res: Vec<Option<String>> = RESOLVE.iter().map(|(b, h)| resolve(b, h)).collect();
    assert_eq!(res, arr_str(&g["url"]["resolve"]), "resolve parity");

    let http: Vec<bool> = HTTP.iter().map(|u| is_http_url(u)).collect();
    let want_http: Vec<bool> = g["url"]["isHttpUrl"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_bool().unwrap())
        .collect();
    assert_eq!(http, want_http, "isHttpUrl parity");

    // --- robots ---
    let mut rc = RobotsCache::new(StubRobots);
    let mut allowed = Vec::new();
    for p in ROBOT_PATHS {
        allowed.push(
            rc.allowed(&format!("https://x.test{p}"), "turbo-surf", 0)
                .await,
        );
    }
    let want_allowed: Vec<bool> = g["robots"]["allowed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_bool().unwrap())
        .collect();
    assert_eq!(allowed, want_allowed, "robots allow parity");

    let cd = rc.crawl_delay("https://x.test", "turbo-surf", 0).await;
    assert_eq!(
        cd,
        Some(g["robots"]["crawlDelay"].as_f64().unwrap()),
        "crawl-delay parity"
    );

    // --- cookies ---
    let mut jar = CookieJar::new();
    jar.set_from_response(
        "https://x.test/app",
        &[
            "a=1; Path=/".to_string(),
            "b=2; Path=/app; Secure".to_string(),
        ],
        0.0,
    );
    assert_eq!(
        jar.cookie_header("https://x.test/", 0.0),
        g["cookies"]["root"],
        "cookie root parity"
    );
    assert_eq!(
        jar.cookie_header("https://x.test/app/x", 0.0),
        g["cookies"]["appHttps"],
        "cookie https parity"
    );
    assert_eq!(
        jar.cookie_header("http://x.test/app/x", 0.0),
        g["cookies"]["appHttp"],
        "cookie http parity"
    );
}
