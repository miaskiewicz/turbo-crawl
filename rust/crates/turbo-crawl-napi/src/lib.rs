//! turbo-crawl napi-rs addon — the in-process bridge from the Rust core to Node.
//! Stateless functional surface: Node holds the HTML, each call parses it with
//! turbo-dom and runs a Rust view/extract pass. `fetchHtml` + `crawl` are async
//! (driven on napi's tokio runtime). The thin `@playwright/test` shim (task #10)
//! composes these; `goto` = `fetchHtml` then view calls on the cached HTML.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use turbo_crawl_core::crawl::{crawl as run_crawl, CrawlOptions, Record};
use turbo_crawl_core::net::{fetch_html as net_fetch, FetchOptions};
use turbo_crawl_page::TurboNavigator;
use turbo_crawl_view as view;
use turbo_dom_parser::rtdom::serialize::serialize_inner;
use turbo_dom_parser::rtdom::Tree;
use view::{Field, FieldType, QueryType, TextMode};

#[napi]
pub fn version() -> String {
    "0.1.6".to_string()
}

fn to_json_string<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".to_string())
}

// --- view passes (parse-per-call; the shim caches the HTML) -----------------

#[napi]
pub fn markdown(html: String, base_url: String) -> String {
    let tree = Tree::parse(&html);
    view::markdown(&tree, tree.root(), &base_url)
}

#[napi]
pub fn text(html: String) -> String {
    let tree = Tree::parse(&html);
    view::text(&tree, tree.root())
}

/// Document `<title>` (raw text — the text view skips TITLE, so read it directly).
#[napi]
pub fn title(html: String) -> String {
    let tree = Tree::parse(&html);
    tree.query_selector("title")
        .map(|h| tree.text_content(h).trim().to_string())
        .unwrap_or_default()
}

#[napi]
pub fn html(html: String) -> String {
    let tree = Tree::parse(&html);
    serialize_inner(&tree, tree.root())
}

#[napi]
pub fn links(html: String, base_url: String) -> Vec<String> {
    let tree = Tree::parse(&html);
    view::links(&tree, &base_url)
}

#[napi]
pub fn interactive_elements(html: String, base_url: String) -> String {
    let tree = Tree::parse(&html);
    to_json_string(&view::interactive_elements(&tree, &base_url, true))
}

#[napi]
pub fn accessibility_tree(html: String) -> String {
    let tree = Tree::parse(&html);
    to_json_string(&view::accessibility_tree(&tree))
}

#[napi]
pub fn aria_snapshot(html: String) -> String {
    let tree = Tree::parse(&html);
    match tree.query_selector("body") {
        Some(b) => view::aria_snapshot(&tree, b),
        None => String::new(),
    }
}

#[napi]
pub fn hydration_state(html: String) -> String {
    let tree = Tree::parse(&html);
    to_json_string(&view::extract_hydration_state(&tree))
}

#[napi]
pub fn detect(html: String) -> String {
    let tree = Tree::parse(&html);
    to_json_string(&view::detect_js_required(&tree, None, None))
}

#[napi]
pub fn query(html: String, selector: String, kind: Option<String>) -> String {
    let tree = Tree::parse(&html);
    let ty = match kind.as_deref() {
        Some("css") => QueryType::Css,
        Some("xpath") => QueryType::Xpath,
        _ => QueryType::Auto,
    };
    to_json_string(&view::query(&tree, tree.root(), &selector, ty))
}

/// Locate by `kind` ("role" | "text" | "label") → JSON `[{ node, text }]`.
/// `name` filters a role match by accessible name (substring).
#[napi]
pub fn get_by(html: String, kind: String, value: String, name: Option<String>) -> String {
    let tree = Tree::parse(&html);
    let nm = name.as_deref().map(|n| (n, TextMode::Substring));
    let hits = match kind.as_str() {
        "role" => view::by_role(&tree, &value, nm),
        "text" => view::by_text(&tree, &value, TextMode::Substring),
        "label" => view::by_label(&tree, &value, TextMode::Substring),
        _ => Vec::new(),
    };
    let out: Vec<Value> = hits
        .iter()
        .map(|&h| json!({ "node": h, "text": view::text(&tree, h) }))
        .collect();
    Value::Array(out).to_string()
}

#[napi]
pub fn extract(html: String, base_url: String, schema_json: String) -> Result<String> {
    let schema_value: Value =
        serde_json::from_str(&schema_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let tree = Tree::parse(&html);
    let schema = parse_schema(&schema_value);
    Ok(to_json_string(&view::extract_schema(
        &tree, &schema, &base_url,
    )))
}

fn parse_schema(v: &Value) -> BTreeMap<String, Field> {
    v.as_object()
        .map(|o| o.iter().map(|(k, s)| (k.clone(), parse_field(s))).collect())
        .unwrap_or_default()
}

fn parse_field(spec: &Value) -> Field {
    let s = |k: &str| spec.get(k).and_then(Value::as_str).map(str::to_string);
    Field {
        selector: s("selector"),
        attr: s("attr"),
        ftype: match spec.get("type").and_then(Value::as_str) {
            Some("number") => FieldType::Number,
            Some("boolean") => FieldType::Boolean,
            _ => FieldType::String,
        },
        list: spec.get("list").and_then(Value::as_bool).unwrap_or(false),
        fields: spec.get("fields").map(parse_schema),
    }
}

// --- JS execution (tier 3, deno_core) ---------------------------------------

/// Evaluate `script` against the page's DOM and return its result as a string
/// (Playwright `page.evaluate`-ish; synchronous, no event loop).
#[napi]
pub fn evaluate(html: String, script: String) -> Result<String> {
    let dom = std::rc::Rc::new(turbo_crawl_render::TreeDom::parse(&html));
    turbo_crawl_render::run_with_dom(dom, &script).map_err(Error::from_reason)
}

/// Run the page's own `script` over its DOM (promises/await + virtual timers +
/// `document.cookie`/`fetch` against `baseUrl`) and return the hydrated HTML —
/// the no-Chromium render. The V8 isolate is not `Send`, so it runs on a
/// dedicated thread with its own current-thread runtime (only strings cross).
#[napi]
pub fn render(html: String, base_url: String, script: String) -> Result<String> {
    std::thread::spawn(move || {
        let dom = std::rc::Rc::new(turbo_crawl_render::TreeDom::parse(&html));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(turbo_crawl_render::render_page(dom, &base_url, &script))
    })
    .join()
    .map_err(|_| Error::from_reason("render thread panicked"))?
    .map_err(Error::from_reason)
}

// --- async: fetch + crawl ---------------------------------------------------

/// Fetch a URL; returns JSON `{ html, finalUrl, status, redirected }`.
#[napi]
pub async fn fetch_html(url: String) -> Result<String> {
    let opts = FetchOptions {
        allow_non_html: true,
        ..Default::default()
    };
    let res = net_fetch(&url, opts)
        .await
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(json!({
        "html": res.html,
        "finalUrl": res.final_url,
        "status": res.status,
        "redirected": res.redirected,
    })
    .to_string())
}

fn record_json(r: &Record) -> Value {
    json!({
        "url": r.url, "status": r.status, "depth": r.depth,
        "title": r.title, "links": r.links, "error": r.error,
    })
}

fn crawl_options(opts: &Value) -> CrawlOptions {
    let start = opts
        .get("start")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let u = |k: &str, d: u64| opts.get(k).and_then(Value::as_u64).unwrap_or(d);
    CrawlOptions {
        start,
        max_pages: u("maxPages", 100) as usize,
        max_depth: u("maxDepth", 3) as usize,
        concurrency: u("concurrency", 4) as usize,
        same_host_only: opts
            .get("sameHost")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        ..Default::default()
    }
}

/// Crawl from `optsJson` (`{ start:[…], maxPages?, maxDepth?, concurrency?,
/// sameHost? }`); returns a JSON array of page records.
#[napi]
pub async fn crawl(opts_json: String) -> Result<String> {
    let opts_value: Value =
        serde_json::from_str(&opts_json).map_err(|e| Error::from_reason(e.to_string()))?;
    let opts = crawl_options(&opts_value);
    let recs = run_crawl(opts, Arc::new(TurboNavigator::default())).await;
    let arr: Vec<Value> = recs.iter().map(record_json).collect();
    Ok(Value::Array(arr).to_string())
}
