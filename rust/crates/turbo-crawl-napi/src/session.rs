//! Stateful session (G11): a napi `Session` over a retained turbo-dom `Tree` +
//! `CookieJar`, so reads/actions don't reparse and node handles stay stable
//! across calls. The `Tree` is not `Send`, so it lives on a dedicated worker
//! thread (with its own current-thread runtime for `goto`); the napi object
//! holds only a `Send` command channel. One generic `call(tool, argsJson)`
//! dispatches over the session state (mirrors the MCP tool surface).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{json, Value};
use std::sync::mpsc::{sync_channel, Sender, SyncSender};
use std::thread;
use turbo_crawl_core::cookies::CookieJar;
use turbo_crawl_core::net::{fetch_html, FetchOptions};
use turbo_crawl_view as view;
use turbo_dom_parser::rtdom::serialize::serialize_inner;
use turbo_dom_parser::rtdom::Tree;

struct Job {
    tool: String,
    args: Value,
    reply: SyncSender<std::result::Result<String, String>>,
}

#[derive(Default)]
struct State {
    tree: Option<Tree>,
    url: String,
    jar: CookieJar,
}

/// A retained-DOM browsing session. Methods block on the worker thread.
#[napi]
pub struct Session {
    tx: Sender<Job>,
}

#[napi]
impl Session {
    #[napi(constructor)]
    pub fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("session runtime");
            let mut state = State::default();
            for job in rx {
                let res = rt.block_on(dispatch(&mut state, &job.tool, &job.args));
                let _ = job.reply.send(res);
            }
        });
        Self { tx }
    }

    /// Run a tool by name with JSON args → JSON result string. Blocks until the
    /// worker (owning the live `Tree`) replies.
    #[napi]
    pub fn call(&self, tool: String, args_json: Option<String>) -> Result<String> {
        let args: Value = args_json
            .as_deref()
            .map(|s| serde_json::from_str(s).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        let (reply, rx) = sync_channel(1);
        self.tx
            .send(Job { tool, args, reply })
            .map_err(|_| Error::from_reason("session worker gone"))?;
        rx.recv()
            .map_err(|_| Error::from_reason("session worker dropped reply"))?
            .map_err(Error::from_reason)
    }
}

fn arg<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(Value::as_str)
}

async fn dispatch(st: &mut State, tool: &str, args: &Value) -> std::result::Result<String, String> {
    match tool {
        // Load HTML directly into the session (no network) — test seam + for
        // callers that fetched elsewhere.
        "load" => {
            st.url = arg(args, "url").unwrap_or("about:blank").to_string();
            st.tree = Some(Tree::parse(arg(args, "html").unwrap_or("")));
            Ok(json!({ "ok": true }).to_string())
        }
        "goto" => goto(st, arg(args, "url").ok_or("goto: missing url")?).await,
        "fill" | "check" | "uncheck" | "select_option" | "click" => action(st, tool, args).await,
        _ => read(st, tool, args),
    }
}

async fn goto(st: &mut State, url: &str) -> std::result::Result<String, String> {
    let opts = FetchOptions {
        allow_non_html: true,
        jar: Some(&mut st.jar),
        ..Default::default()
    };
    let res = fetch_html(url, opts).await.map_err(|e| e.to_string())?;
    st.url = res.final_url.clone();
    st.tree = Some(Tree::parse(&res.html));
    let title = st.tree.as_ref().unwrap().query_selector("title").map(|h| {
        st.tree.as_ref().unwrap().text_content(h).trim().to_string()
    });
    Ok(json!({ "url": res.final_url, "status": res.status, "title": title.unwrap_or_default() }).to_string())
}

fn tree(st: &State) -> std::result::Result<&Tree, String> {
    st.tree.as_ref().ok_or_else(|| "no page loaded (call goto)".to_string())
}

async fn action(st: &mut State, tool: &str, args: &Value) -> std::result::Result<String, String> {
    let sel = arg(args, "selector").ok_or("missing selector")?.to_string();
    if tool == "click" {
        let intent = {
            let t = tree(st)?;
            let h = t.query_selector(&sel).ok_or("no match")?;
            view::click_intent(t, h, &st.url)
        };
        return match intent {
            view::ClickIntent::Navigate(u) => goto(st, &u).await,
            view::ClickIntent::Submit(s) => {
                let opts = FetchOptions {
                    method: (s.method != "GET").then_some(s.method),
                    body: s.body,
                    allow_non_html: true,
                    jar: Some(&mut st.jar),
                    ..Default::default()
                };
                let res = fetch_html(&s.url, opts).await.map_err(|e| e.to_string())?;
                st.url = res.final_url.clone();
                st.tree = Some(Tree::parse(&res.html));
                Ok(json!({ "url": res.final_url, "status": res.status }).to_string())
            }
            view::ClickIntent::Inert => Ok(json!({ "action": "inert" }).to_string()),
        };
    }
    let value = arg(args, "value").unwrap_or("").to_string();
    let t = st.tree.as_mut().ok_or("no page loaded (call goto)")?;
    let h = t.query_selector(&sel).ok_or("no match")?;
    match tool {
        "fill" => view::fill_value(t, h, &value),
        "check" => view::set_checked(t, h, true),
        "uncheck" => view::set_checked(t, h, false),
        "select_option" => {
            view::select_option(t, h, &value);
        }
        _ => unreachable!(),
    }
    Ok(json!({ "ok": true }).to_string())
}

fn read(st: &State, tool: &str, args: &Value) -> std::result::Result<String, String> {
    let t = tree(st)?;
    let root = t.root();
    let j = |v: Value| Ok(v.to_string());
    match tool {
        "markdown" => Ok(view::markdown(t, root, &st.url)),
        "text" => Ok(view::text(t, root)),
        "html" => Ok(serialize_inner(t, root)),
        "title" => Ok(t.query_selector("title").map(|h| t.text_content(h).trim().to_string()).unwrap_or_default()),
        "links" => j(json!(view::links(t, &st.url))),
        "interactive_elements" => j(json!(view::interactive_elements(t, &st.url, true))),
        "accessibility_tree" => j(json!(view::accessibility_tree(t))),
        "hydration_state" => j(json!(view::extract_hydration_state(t))),
        "detect" => j(json!(view::detect_js_required(t, None, None))),
        "query" => read_query(t, root, args),
        "cookies" => Ok(st.jar.storage_state()),
        _ => Err(format!("unknown tool: {tool}")),
    }
}

fn read_query(t: &Tree, root: u32, args: &Value) -> std::result::Result<String, String> {
    let selector = arg(args, "selector").ok_or("query: missing selector")?;
    let ty = match arg(args, "type") {
        Some("css") => view::QueryType::Css,
        Some("xpath") => view::QueryType::Xpath,
        _ => view::QueryType::Auto,
    };
    Ok(json!(view::query(t, root, selector, ty)).to_string())
}
