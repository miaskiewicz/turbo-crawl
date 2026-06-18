//! turbo-crawl-core — Rust port, **tier 1**: the browserless native-speed crawler
//! core. Ports the pure-logic + networking modules of the JS library:
//!
//! - [`url`] — resolve / canonicalize / http-gate (frontier dedupe basis)
//! - [`frontier`] — canonical-dedup URL queue with depth
//! - [`robots`] — robots.txt parse + longest-match + TTL cache
//! - [`cookies`] — RFC 6265 subset CookieJar
//! - [`net`] — `fetch_html` over reqwest (charset/byte-cap/type-gate/cookies)
//! - [`crawl`] — frontier-driven scheduling (concurrency, politeness, backoff)
//!
//! The JS-execution tier (deno_core) and the napi/playwright shim are later
//! tiers; the page fetch+parse seam is the [`crawl::Navigator`] trait, which the
//! tier-2 `Page` (on the turbo-dom Rust crate) will implement.

pub mod cache;
pub mod cookies;
pub mod crawl;
pub mod frontier;
pub mod measure;
pub mod net;
pub mod robots;
pub mod url;

/// Re-export reqwest so downstream crates (e.g. the napi addon's shared client)
/// name the exact same client type/version without a parallel dependency.
pub use reqwest;

/// Library version — kept in lockstep with `package.json` per the release rules.
pub const VERSION: &str = "0.1.11";
