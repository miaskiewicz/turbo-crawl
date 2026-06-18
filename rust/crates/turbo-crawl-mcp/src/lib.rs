//! turbo-crawl MCP server core (port of `mcp/`) — a stateful agent session over
//! a current page `Tree`, exposed via stdio JSON-RPC 2.0. No Node, no SDK: the
//! JSON-RPC envelope is hand-rolled (`initialize` / `tools/list` / `tools/call`).
//!
//! `goto` fetches + parses into the session; the read tools (markdown / text /
//! html / links / interactive_elements / accessibility_tree / aria_snapshot /
//! extract / hydration_state / query / get_by / detect) run over that `Tree`.
//! Action tools (click/fill/submit) need the navigation state machine and land
//! with the tier-2 `Page` wiring.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use turbo_crawl_core::net::{fetch_html, FetchOptions};
use turbo_crawl_view as view;
use turbo_dom_parser::rtdom::serialize::serialize_inner;
use turbo_dom_parser::rtdom::Tree;
use view::{Field, FieldType, QueryType, TextMode};

pub const VERSION: &str = "0.1.11";

/// One agent session: the current page URL + parsed tree + nav history.
#[derive(Default)]
pub struct Session {
    pub url: String,
    tree: Option<Tree>,
    back: Vec<String>,
    forward: Vec<String>,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inject a parsed tree (test seam, bypasses the network).
    pub fn load(&mut self, url: &str, html: &str) {
        self.url = url.to_string();
        self.tree = Some(Tree::parse(html));
    }

    fn tree(&self) -> Result<&Tree, String> {
        self.tree
            .as_ref()
            .ok_or_else(|| "no page loaded (call goto first)".to_string())
    }

    fn tree_mut(&mut self) -> Result<&mut Tree, String> {
        self.tree
            .as_mut()
            .ok_or_else(|| "no page loaded (call goto first)".to_string())
    }

    // Fetch + parse into the session (no history bookkeeping).
    async fn fetch_into(
        &mut self,
        url: &str,
        method: Option<String>,
        body: Option<String>,
    ) -> Result<Value, String> {
        let opts = FetchOptions {
            method,
            body,
            allow_non_html: true,
            ..Default::default()
        };
        let res = fetch_html_with(url, opts).await?;
        self.load(&res.0, &res.1);
        Ok(json!({ "url": res.0, "status": res.2, "title": title_of(self.tree.as_ref().unwrap()) }))
    }

    async fn goto(&mut self, url: &str) -> Result<Value, String> {
        if !self.url.is_empty() && self.url != "about:blank" {
            self.back.push(self.url.clone());
        }
        self.forward.clear();
        self.fetch_into(url, None, None).await
    }

    async fn reload(&mut self) -> Result<Value, String> {
        let url = self.url.clone();
        self.fetch_into(&url, None, None).await
    }

    async fn go_back(&mut self) -> Result<Value, String> {
        let prev = self.back.pop().ok_or("no back history")?;
        self.forward.push(self.url.clone());
        self.fetch_into(&prev, None, None).await
    }

    async fn go_forward(&mut self) -> Result<Value, String> {
        let next = self.forward.pop().ok_or("no forward history")?;
        self.back.push(self.url.clone());
        self.fetch_into(&next, None, None).await
    }

    // Mutate a control located by selector; returns the new title (or ok).
    fn mutate<F: FnOnce(&mut Tree, u32)>(&mut self, selector: &str, f: F) -> Result<Value, String> {
        let tree = self.tree_mut()?;
        let h = tree
            .query_selector(selector)
            .ok_or_else(|| format!("no element matches {selector}"))?;
        f(tree, h);
        Ok(json!({ "ok": true }))
    }

    async fn click(&mut self, selector: &str) -> Result<Value, String> {
        let base = self.url.clone();
        let intent = {
            let tree = self.tree()?;
            let h = tree
                .query_selector(selector)
                .ok_or_else(|| format!("no element matches {selector}"))?;
            view::click_intent(tree, h, &base)
        };
        match intent {
            view::ClickIntent::Navigate(url) => self.goto(&url).await,
            view::ClickIntent::Submit(s) => {
                let method = (s.method != "GET").then_some(s.method);
                self.back.push(base);
                self.forward.clear();
                self.fetch_into(&s.url, method, s.body).await
            }
            view::ClickIntent::Inert => Ok(json!({ "action": "inert" })),
        }
    }
}

// Fetch returning (final_url, html, status) — small adapter over net.
async fn fetch_html_with(
    url: &str,
    opts: FetchOptions<'_>,
) -> Result<(String, String, u16), String> {
    let res = fetch_html(url, opts).await.map_err(|e| e.to_string())?;
    Ok((res.final_url, res.html, res.status))
}

fn title_of(tree: &Tree) -> String {
    tree.query_selector("title")
        .map(|h| tree.text_content(h).trim().to_string())
        .unwrap_or_default()
}

// --- tool registry ----------------------------------------------------------

/// `tools/list` descriptors (name + one-line description + minimal input schema).
pub fn tools() -> Value {
    let specs: &[(&str, &str)] = &[
        ("goto", "Fetch + parse a URL into the session"),
        (
            "markdown",
            "Markdown view of the current page's main content",
        ),
        ("text", "Plain-text view of the current page"),
        ("html", "Serialized HTML of the current page"),
        ("links", "Absolute http(s) links on the current page"),
        ("interactive_elements", "Indexed interactive elements"),
        ("accessibility_tree", "Accessibility (role/name) tree"),
        ("aria_snapshot", "YAML-ish ARIA snapshot of <body>"),
        (
            "extract",
            "Structured extraction by a selector-bound schema",
        ),
        (
            "hydration_state",
            "No-JS hydration state (Next/JSON-LD/globals)",
        ),
        ("query", "Query by CSS or XPath"),
        ("get_by", "Locate by role/text/label/attr"),
        ("detect", "Lane B (JS-required) heuristic"),
        ("click", "Click an element (follow link / submit form)"),
        ("fill", "Fill a control's value"),
        ("check", "Check a checkbox/radio"),
        ("uncheck", "Uncheck a checkbox/radio"),
        ("select_option", "Select a <select> option by value/label"),
        ("reload", "Re-fetch the current URL"),
        ("go_back", "Navigate to the previous URL"),
        ("go_forward", "Navigate forward"),
        ("get_attribute", "Attribute of the first selector match"),
        ("is_visible", "Visibility of the first selector match"),
    ];
    let list: Vec<Value> = specs
        .iter()
        .map(|(name, desc)| {
            json!({
                "name": name,
                "description": desc,
                "inputSchema": { "type": "object", "properties": {}, "additionalProperties": true }
            })
        })
        .collect();
    json!({ "tools": list })
}

// --- tool dispatch ----------------------------------------------------------

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// Run a tool by name, returning its result value (the caller wraps it in the
/// MCP `content` envelope).
pub async fn call_tool(session: &mut Session, name: &str, args: &Value) -> Result<Value, String> {
    let sel = || arg_str(args, "selector").ok_or_else(|| format!("{name}: missing 'selector'"));
    let val = || arg_str(args, "value").unwrap_or("").to_string();
    match name {
        "goto" => {
            session
                .goto(arg_str(args, "url").ok_or("goto: missing 'url'")?)
                .await
        }
        "click" => session.click(sel()?).await,
        "reload" => session.reload().await,
        "go_back" => session.go_back().await,
        "go_forward" => session.go_forward().await,
        "fill" => {
            let (s, v) = (sel()?.to_string(), val());
            session.mutate(&s, |t, h| view::fill_value(t, h, &v))
        }
        "check" => {
            let s = sel()?.to_string();
            session.mutate(&s, |t, h| view::set_checked(t, h, true))
        }
        "uncheck" => {
            let s = sel()?.to_string();
            session.mutate(&s, |t, h| view::set_checked(t, h, false))
        }
        "select_option" => {
            let (s, v) = (sel()?.to_string(), val());
            session.mutate(&s, |t, h| {
                view::select_option(t, h, &v);
            })
        }
        _ => call_read_tool(session, name, args),
    }
}

fn call_read_tool(session: &mut Session, name: &str, args: &Value) -> Result<Value, String> {
    let tree = session.tree()?;
    let root = tree.root();
    let base = session.url.clone();
    match name {
        "markdown" => Ok(json!(view::markdown(tree, root, &base))),
        "text" => Ok(json!(view::text(tree, root))),
        "html" => Ok(json!(serialize_inner(tree, root))),
        "links" => Ok(json!(view::links(tree, &base))),
        "interactive_elements" => Ok(json!(view::interactive_elements(tree, &base, true))),
        "accessibility_tree" => Ok(json!(view::accessibility_tree(tree))),
        "aria_snapshot" => Ok(json!(aria_snapshot_body(tree))),
        "hydration_state" => Ok(json!(view::extract_hydration_state(tree))),
        "detect" => Ok(json!(view::detect_js_required(tree, None, None))),
        "query" => tool_query(tree, root, args),
        "get_by" => tool_get_by(tree, args),
        "extract" => tool_extract(tree, &base, args),
        "get_attribute" => tool_get_attribute(tree, args),
        "is_visible" => Ok(json!(
            first(tree, args)?.is_some_and(|h| view::is_visible(tree, h))
        )),
        _ => Err(format!("unknown tool: {name}")),
    }
}

// First selector match handle (or None), for accessor tools.
fn first(tree: &Tree, args: &Value) -> Result<Option<u32>, String> {
    let sel = arg_str(args, "selector").ok_or("missing 'selector'")?;
    Ok(tree.query_selector(sel))
}

fn tool_get_attribute(tree: &Tree, args: &Value) -> Result<Value, String> {
    let name = arg_str(args, "name").ok_or("get_attribute: missing 'name'")?;
    let v = first(tree, args)?.and_then(|h| tree.get_attribute(h, name));
    Ok(json!(v))
}

fn aria_snapshot_body(tree: &Tree) -> String {
    match tree.query_selector("body") {
        Some(b) => view::aria_snapshot(tree, b),
        None => String::new(), // defensive: a parsed document always has <body>
    }
}

fn tool_query(tree: &Tree, root: u32, args: &Value) -> Result<Value, String> {
    let selector = arg_str(args, "selector").ok_or("query: missing 'selector'")?;
    let ty = match arg_str(args, "type") {
        Some("css") => QueryType::Css,
        Some("xpath") => QueryType::Xpath,
        _ => QueryType::Auto,
    };
    Ok(json!(view::query(tree, root, selector, ty)))
}

fn tool_get_by(tree: &Tree, args: &Value) -> Result<Value, String> {
    let name = arg_str(args, "name").map(|n| (n, TextMode::Substring));
    let hits = if let Some(role) = arg_str(args, "role") {
        view::by_role(tree, role, name)
    } else if let Some(text) = arg_str(args, "text") {
        view::by_text(tree, text, TextMode::Substring)
    } else if let Some(label) = arg_str(args, "label") {
        view::by_label(tree, label, TextMode::Substring)
    } else {
        return Err("get_by: need one of role/text/label".to_string());
    };
    let out: Vec<Value> = hits
        .iter()
        .map(|&h| json!({ "node": h, "text": view::text(tree, h) }))
        .collect();
    Ok(json!(out))
}

// Parse a JSON schema object into the view Field map (selector/attr/type/list/fields).
fn parse_schema(v: &Value) -> BTreeMap<String, Field> {
    v.as_object()
        .map(|o| {
            o.iter()
                .map(|(k, spec)| (k.clone(), parse_field(spec)))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_field(spec: &Value) -> Field {
    Field {
        selector: arg_str(spec, "selector").map(str::to_string),
        attr: arg_str(spec, "attr").map(str::to_string),
        ftype: match arg_str(spec, "type") {
            Some("number") => FieldType::Number,
            Some("boolean") => FieldType::Boolean,
            _ => FieldType::String,
        },
        list: spec.get("list").and_then(Value::as_bool).unwrap_or(false),
        fields: spec.get("fields").map(parse_schema),
    }
}

fn tool_extract(tree: &Tree, base: &str, args: &Value) -> Result<Value, String> {
    let schema = args.get("schema").ok_or("extract: missing 'schema'")?;
    Ok(view::extract_schema(tree, &parse_schema(schema), base))
}

// --- JSON-RPC envelope ------------------------------------------------------

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: Value, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } })
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "turbo-crawl", "version": VERSION }
    })
}

async fn tools_call(session: &mut Session, params: &Value) -> Result<Value, String> {
    let name = arg_str(params, "name").ok_or("tools/call: missing 'name'")?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let value = call_tool(session, name, &args).await?;
    // MCP content envelope: a single text block carrying the serialized result.
    let text = match &value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

/// Handle one JSON-RPC request object, returning the response object (or `None`
/// for a notification, which has no `id`).
pub async fn handle(session: &mut Session, req: &Value) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    // Notifications (no id) get no response.
    id.as_ref()?;
    let id = id.unwrap();

    let result = match method {
        "initialize" => Ok(initialize_result()),
        "tools/list" => Ok(tools()),
        "tools/call" => tools_call(session, &params).await,
        other => Err(format!("unknown method: {other}")),
    };
    Some(match result {
        Ok(r) => ok(id, r),
        Err(e) => err(id, &e),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "<html><head><title>T</title></head><body>\
        <main><h1>Hi</h1><p>para</p></main>\
        <a href='/x'>L</a><button>Go</button>\
        <div id='app'></div><script src='/a.js'></script>\
        <script id='__NEXT_DATA__' type='application/json'>{\"p\":1}</script>\
        </body></html>";

    fn loaded() -> Session {
        let mut s = Session::new();
        s.load("https://x.test/", PAGE);
        s
    }

    async fn call(s: &mut Session, name: &str, args: Value) -> Value {
        call_tool(s, name, &args).await.unwrap()
    }

    #[tokio::test]
    async fn read_tools_over_loaded_page() {
        let mut s = loaded();
        assert!(call(&mut s, "markdown", json!({}))
            .await
            .as_str()
            .unwrap()
            .contains("# Hi"));
        assert!(call(&mut s, "text", json!({}))
            .await
            .as_str()
            .unwrap()
            .contains("para"));
        assert!(call(&mut s, "html", json!({}))
            .await
            .as_str()
            .unwrap()
            .contains("<h1>"));
        assert_eq!(
            call(&mut s, "links", json!({})).await,
            json!(["https://x.test/x"])
        );
        assert_eq!(
            call(&mut s, "interactive_elements", json!({}))
                .await
                .as_array()
                .unwrap()
                .len(),
            2
        );
        // body has several roled children → a generic wrapper containing them
        let ax = call(&mut s, "accessibility_tree", json!({})).await;
        assert_eq!(ax["role"], "generic");
        assert!(ax.to_string().contains("\"main\""));
    }

    #[tokio::test]
    async fn structured_and_locator_tools() {
        let mut s = loaded();
        // query (CSS)
        let q = call(&mut s, "query", json!({ "selector": "h1" })).await;
        assert_eq!(q[0]["text"], "Hi");
        // get_by role
        let g = call(&mut s, "get_by", json!({ "role": "button" })).await;
        assert_eq!(g[0]["text"], "Go");
        // extract schema
        let e = call(
            &mut s,
            "extract",
            json!({ "schema": { "heading": { "selector": "h1" } } }),
        )
        .await;
        assert_eq!(e["heading"], "Hi");
        // hydration + detect
        assert_eq!(
            call(&mut s, "hydration_state", json!({})).await["next"],
            json!({"p": 1})
        );
        assert_eq!(call(&mut s, "detect", json!({})).await["js_required"], true);
    }

    #[tokio::test]
    async fn jsonrpc_envelope() {
        let mut s = loaded();
        // initialize
        let init = handle(
            &mut s,
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        )
        .await
        .unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "turbo-crawl");
        // tools/list
        let list = handle(
            &mut s,
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .await
        .unwrap();
        assert!(list["result"]["tools"].as_array().unwrap().len() >= 13);
        // tools/call → content envelope
        let call = handle(
            &mut s,
            &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"text","arguments":{}}}),
        )
        .await
        .unwrap();
        assert!(call["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Hi"));
        // a non-string tool result is JSON-serialized into the text block
        let links = handle(
            &mut s,
            &json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"links","arguments":{}}}),
        )
        .await
        .unwrap();
        assert!(links["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with('['));
        // notification (no id) → no response
        assert!(handle(&mut s, &json!({"jsonrpc":"2.0","method":"x"}))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn goto_fetches_and_loads_over_localhost() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut b = [0u8; 512];
                let _ = sock.read(&mut b).await;
                let body = "<html><head><title>Live</title></head><body><p>hello</p></body></html>";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        let mut s = Session::new();
        let r = call_tool(
            &mut s,
            "goto",
            &json!({ "url": format!("http://127.0.0.1:{port}/") }),
        )
        .await
        .unwrap();
        assert_eq!(r["status"], 200);
        assert_eq!(r["title"], "Live");
        // session now serves read tools
        assert!(call(&mut s, "text", json!({}))
            .await
            .as_str()
            .unwrap()
            .contains("hello"));
    }

    #[tokio::test]
    async fn aria_query_getby_branches() {
        let mut s = loaded();
        assert!(call(&mut s, "aria_snapshot", json!({}))
            .await
            .as_str()
            .unwrap()
            .contains("- "));
        // explicit query types
        assert_eq!(
            call(&mut s, "query", json!({"selector":"h1","type":"css"})).await[0]["text"],
            "Hi"
        );
        assert_eq!(
            call(&mut s, "query", json!({"selector":"//h1","type":"xpath"})).await[0]["text"],
            "Hi"
        );
        // get_by text + label (label absent → empty list, exercises the branch)
        assert!(!call(&mut s, "get_by", json!({"text":"para"}))
            .await
            .as_array()
            .unwrap()
            .is_empty());
        assert!(call(&mut s, "get_by", json!({"label":"none"}))
            .await
            .as_array()
            .unwrap()
            .is_empty());
        // missing-arg errors
        assert!(call_tool(&mut s, "query", &json!({})).await.is_err());
        assert!(call_tool(&mut s, "get_by", &json!({})).await.is_err());
        assert!(call_tool(&mut s, "extract", &json!({})).await.is_err());
    }

    #[tokio::test]
    async fn action_tools_mutate_and_read() {
        let mut s = Session::new();
        s.load(
            "https://x.test/",
            "<input id='t'><input id='c' type='checkbox'><a id='x' href='/p'>l</a><div id='d' style='display:none'>x</div>",
        );
        // fill + check mutate the session tree
        call(
            &mut s,
            "fill",
            json!({ "selector": "#t", "value": "typed" }),
        )
        .await;
        call(&mut s, "check", json!({ "selector": "#c" })).await;
        // accessor reads reflect the mutations
        assert_eq!(
            call(
                &mut s,
                "get_attribute",
                json!({ "selector": "#t", "name": "value" })
            )
            .await,
            "typed"
        );
        assert_eq!(
            call(&mut s, "is_visible", json!({ "selector": "#d" })).await,
            false
        );
        assert_eq!(
            call(&mut s, "is_visible", json!({ "selector": "#x" })).await,
            true
        );
    }

    #[tokio::test]
    async fn click_link_and_history() {
        // link click → navigate; go_back returns to the origin.
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut b = [0u8; 512];
                let _ = sock.read(&mut b).await;
                let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<title>Dest</title>";
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        let mut s = Session::new();
        s.load(
            &format!("http://127.0.0.1:{port}/"),
            &format!("<a href='http://127.0.0.1:{port}/next'>go</a>"),
        );
        let clicked = call_tool(&mut s, "click", &json!({ "selector": "a" }))
            .await
            .unwrap();
        assert_eq!(clicked["title"], "Dest");
        // go_back to the origin
        let back = call_tool(&mut s, "go_back", &json!({})).await.unwrap();
        assert!(back["url"].as_str().unwrap().ends_with("/"));
    }

    #[tokio::test]
    async fn errors_surface() {
        let mut s = loaded();
        // unknown method
        let e = handle(&mut s, &json!({"jsonrpc":"2.0","id":1,"method":"bogus"}))
            .await
            .unwrap();
        assert!(e["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown method"));
        // unknown tool
        assert!(call_tool(&mut s, "nope", &json!({})).await.is_err());
        // read tool with no page loaded
        let mut empty = Session::new();
        assert!(call_tool(&mut empty, "text", &json!({})).await.is_err());
        // goto missing url
        assert!(call_tool(&mut s, "goto", &json!({})).await.is_err());
    }
}
