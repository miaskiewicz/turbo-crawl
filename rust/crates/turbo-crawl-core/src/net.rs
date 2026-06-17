//! Networking (port of `src/net.mjs`, SPEC §8): `fetch_html` over reqwest
//! (redirects + gzip/br/deflate for free) plus the hardening the spec calls for:
//! charset sniffing, max body size, content-type gate, and an optional CookieJar
//! round-trip. The pure helpers below are unit-tested offline; `fetch_html`
//! itself is the live-IO seam (covered by the integration suite / harness).

use crate::cookies::CookieJar;
use bytes::BytesMut;
use futures_util::StreamExt;
use std::collections::BTreeMap;

const DEFAULT_UA: &str = "turbo-crawl/0.1 (+https://github.com/miaskiewicz/turbo-crawl)";
const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024; // 8 MiB
const HTML_TYPES: &[&str] = &[
    "text/html",
    "application/xhtml+xml",
    "application/xml",
    "text/xml",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorCode {
    BodyTooLarge,
    NotHtml,
    Network,
}

#[derive(Debug)]
pub struct HttpError {
    pub message: String,
    pub code: ErrorCode,
}

impl HttpError {
    fn new(message: impl Into<String>, code: ErrorCode) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}
impl std::error::Error for HttpError {}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub html: String,
    pub final_url: String,
    pub status: u16,
    pub redirected: bool,
}

#[derive(Default)]
pub struct FetchOptions<'a> {
    pub headers: BTreeMap<String, String>,
    pub method: Option<String>,
    pub body: Option<String>,
    pub max_bytes: Option<usize>,
    pub allow_non_html: bool,
    pub max_redirects: Option<usize>,
    pub jar: Option<&'a mut CookieJar>,
    pub now: f64,
}

// charset: Content-Type header → <meta charset> sniff → utf-8.
fn detect_charset(content_type: &str, head: &[u8]) -> String {
    if let Some(cs) = charset_from_ct(content_type) {
        return cs;
    }
    charset_from_meta(head).unwrap_or_else(|| "utf-8".to_string())
}

fn charset_from_ct(ct: &str) -> Option<String> {
    let lc = ct.to_ascii_lowercase();
    let i = lc.find("charset=")? + "charset=".len();
    let rest = &lc[i..];
    let end = rest.find(';').unwrap_or(rest.len());
    Some(rest[..end].trim().replace(['"', '\''], ""))
}

fn charset_from_meta(head: &[u8]) -> Option<String> {
    let ascii: String = head
        .iter()
        .map(|&b| b as char)
        .collect::<String>()
        .to_ascii_lowercase();
    let i = ascii.find("charset=")? + "charset=".len();
    let label: String = ascii[i..]
        .chars()
        .skip_while(|c| *c == '"' || *c == '\'')
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

fn is_html_type(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.is_empty() {
        return true; // permissive when the server omits it
    }
    HTML_TYPES.iter().any(|t| ct.contains(t))
}

fn decode(bytes: &[u8], charset: &str) -> String {
    let enc = encoding_rs::Encoding::for_label(charset.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    enc.decode(bytes).0.into_owned()
}

// Method after a redirect: 303 (and 301/302 on POST) → GET; 307/308 keep it.
fn next_method(status: u16, method: &str) -> String {
    if status == 303 {
        return "GET".to_string();
    }
    if (status == 301 || status == 302) && method == "POST" {
        return "GET".to_string();
    }
    method.to_string()
}

const REDIRECT_STATUS: &[u16] = &[301, 302, 303, 307, 308];

fn is_redirect(status: u16) -> bool {
    REDIRECT_STATUS.contains(&status)
}

fn build_headers(url: &str, opts: &FetchOptions) -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    h.insert("user-agent".into(), DEFAULT_UA.into());
    h.insert("accept".into(), "text/html,application/xhtml+xml".into());
    for (k, v) in &opts.headers {
        h.insert(k.to_ascii_lowercase(), v.clone());
    }
    if let Some(jar) = &opts.jar {
        let cookie = jar.cookie_header(url, opts.now);
        if !cookie.is_empty() {
            h.insert("cookie".into(), cookie);
        }
    }
    h
}

fn client(policy: reqwest::redirect::Policy) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder().redirect(policy).build()
}

fn redirect_location(res: &reqwest::Response) -> Option<String> {
    if !is_redirect(res.status().as_u16()) {
        return None;
    }
    let loc = header_value(res, "location");
    if loc.is_empty() {
        None
    } else {
        Some(loc)
    }
}

fn err(e: impl std::fmt::Display, code: ErrorCode) -> HttpError {
    HttpError::new(e.to_string(), code)
}

async fn send(
    cl: &reqwest::Client,
    method: &str,
    url: &str,
    headers: &BTreeMap<String, String>,
    body: &Option<String>,
) -> Result<reqwest::Response, HttpError> {
    let m =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| err(e, ErrorCode::Network))?;
    let mut req = apply_headers(cl.request(m, url), headers);
    if let Some(b) = body {
        req = req.body(b.clone());
    }
    req.send().await.map_err(|e| err(e, ErrorCode::Network))
}

fn apply_headers(
    mut req: reqwest::RequestBuilder,
    headers: &BTreeMap<String, String>,
) -> reqwest::RequestBuilder {
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req
}

fn check_content_length(res: &reqwest::Response, max_bytes: usize) -> Result<(), HttpError> {
    if let Some(len) = res.content_length() {
        if len as usize > max_bytes {
            return Err(HttpError::new(
                format!("body exceeds maxBytes ({len} > {max_bytes})"),
                ErrorCode::BodyTooLarge,
            ));
        }
    }
    Ok(())
}

async fn read_capped(res: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, HttpError> {
    check_content_length(&res, max_bytes)?;
    let mut buf = BytesMut::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| HttpError::new(e.to_string(), ErrorCode::Network))?;
        if buf.len() + chunk.len() > max_bytes {
            return Err(HttpError::new(
                format!("body exceeds maxBytes (> {max_bytes})"),
                ErrorCode::BodyTooLarge,
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf.to_vec())
}

fn header_value(res: &reqwest::Response, name: &str) -> String {
    res.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn ingest_set_cookie(opts: &mut FetchOptions, res: &reqwest::Response, final_url: &str) {
    let now = opts.now;
    let Some(jar) = opts.jar.as_mut() else { return };
    let lines: Vec<String> = res
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok().map(str::to_string))
        .collect();
    if !lines.is_empty() {
        jar.set_from_response(final_url, &lines, now);
    }
}

fn gate_html_type(opts: &FetchOptions, res: &reqwest::Response) -> Result<(), HttpError> {
    let ct = header_value(res, "content-type");
    if !opts.allow_non_html && !is_html_type(&ct) {
        return Err(HttpError::new(
            format!("non-HTML content-type: {ct}"),
            ErrorCode::NotHtml,
        ));
    }
    Ok(())
}

// Turn a settled response into the FetchResult: gate content-type, then read +
// charset-decode the body under the byte cap.
async fn finish(
    opts: &FetchOptions<'_>,
    res: reqwest::Response,
    final_url: String,
    redirected: bool,
    max_bytes: usize,
) -> Result<FetchResult, HttpError> {
    gate_html_type(opts, &res)?;
    let status = res.status().as_u16();
    let ct = header_value(&res, "content-type");
    let bytes = read_capped(res, max_bytes).await?;
    let charset = detect_charset(&ct, &bytes[..bytes.len().min(1024)]);
    Ok(FetchResult {
        html: decode(&bytes, &charset),
        final_url,
        status,
        redirected,
    })
}

// State threaded through the manual-follow loop.
struct Hop {
    url: String,
    method: String,
    body: Option<String>,
}

// Manual redirect following (when `max_redirects` is set): re-derives the Cookie
// header and ingests Set-Cookie per hop and rewrites method/body per the fetch
// spec — the round-trip reqwest's auto-follow can't do.
async fn follow_manually(
    opts: &mut FetchOptions<'_>,
    start: &str,
    max_redirects: usize,
    max_bytes: usize,
) -> Result<FetchResult, HttpError> {
    let cl = client(reqwest::redirect::Policy::none()).map_err(|e| err(e, ErrorCode::Network))?;
    let mut hop = Hop {
        url: start.to_string(),
        method: opts.method.clone().unwrap_or_else(|| "GET".to_string()),
        body: opts.body.clone(),
    };
    for redirects in 0.. {
        let headers = build_headers(&hop.url, opts);
        let res = send(&cl, &hop.method, &hop.url, &headers, &hop.body).await?;
        let final_url = res.url().to_string();
        ingest_set_cookie(opts, &res, &final_url);
        match redirect_location(&res) {
            Some(loc) if redirects < max_redirects => hop = advance(&hop, &res, &loc)?,
            _ => return finish(opts, res, final_url, redirects > 0, max_bytes).await,
        }
    }
    unreachable!("redirect loop always returns at the cap")
}

fn advance(hop: &Hop, res: &reqwest::Response, loc: &str) -> Result<Hop, HttpError> {
    let status = res.status().as_u16();
    let method = next_method(status, &hop.method);
    let next = url::Url::parse(&hop.url)
        .and_then(|b| b.join(loc))
        .map_err(|e| err(e, ErrorCode::Network))?;
    let body = if method == hop.method {
        hop.body.clone()
    } else {
        None
    };
    Ok(Hop {
        url: next.to_string(),
        method,
        body,
    })
}

async fn follow_auto(
    opts: &mut FetchOptions<'_>,
    url: &str,
    max_bytes: usize,
) -> Result<FetchResult, HttpError> {
    let cl =
        client(reqwest::redirect::Policy::limited(20)).map_err(|e| err(e, ErrorCode::Network))?;
    let method = opts.method.clone().unwrap_or_else(|| "GET".to_string());
    let headers = build_headers(url, opts);
    let res = send(&cl, &method, url, &headers, &opts.body.clone()).await?;
    let final_url = res.url().to_string();
    let redirected = final_url != *url;
    ingest_set_cookie(opts, &res, &final_url);
    finish(opts, res, final_url, redirected, max_bytes).await
}

/// Fetch a URL and return its decoded HTML plus response metadata. With
/// `max_redirects` set, redirects are followed manually (per-hop cookie
/// round-trip, fetch-spec method rewrite); otherwise reqwest auto-follows
/// (cap 20). Content-type gate, byte cap, and charset decode mirror the JS.
pub async fn fetch_html(url: &str, mut opts: FetchOptions<'_>) -> Result<FetchResult, HttpError> {
    let max_bytes = opts.max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    match opts.max_redirects {
        Some(n) => follow_manually(&mut opts, url, n, max_bytes).await,
        None => follow_auto(&mut opts, url, max_bytes).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charset_from_header() {
        assert_eq!(
            detect_charset("text/html; charset=ISO-8859-1", b""),
            "iso-8859-1"
        );
        assert_eq!(detect_charset("text/html; charset=\"utf-8\"", b""), "utf-8");
    }

    #[test]
    fn charset_from_meta_tag() {
        let head = br#"<html><head><meta charset="windows-1250">"#;
        assert_eq!(detect_charset("text/html", head), "windows-1250");
    }

    #[test]
    fn charset_falls_back_to_utf8() {
        assert_eq!(detect_charset("text/html", b"<html>"), "utf-8");
    }

    #[test]
    fn html_type_gate() {
        assert!(is_html_type(""));
        assert!(is_html_type("text/html; charset=utf-8"));
        assert!(!is_html_type("application/json"));
    }

    #[test]
    fn redirect_method_rewrite() {
        assert_eq!(next_method(303, "POST"), "GET");
        assert_eq!(next_method(301, "POST"), "GET");
        assert_eq!(next_method(307, "POST"), "POST");
        assert_eq!(next_method(302, "GET"), "GET");
    }

    #[test]
    fn redirect_status_set() {
        assert!(is_redirect(308));
        assert!(!is_redirect(200));
    }

    #[test]
    fn decode_latin1() {
        let bytes = [0xe9u8]; // é in latin1
        assert_eq!(decode(&bytes, "iso-8859-1"), "é");
    }
}
