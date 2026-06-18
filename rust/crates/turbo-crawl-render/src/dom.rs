//! DOM op bridge + global bootstrap (tier 3). Page JS runs on a `deno_core` V8
//! isolate; `document` / element / `window` / timers are layered over `#[op2]`
//! ops that call a `DomBackend` trait object backed by turbo-dom's native
//! `rtdom::Tree`. The page's own scripts mutate that Rust DOM in place; the
//! render returns the hydrated HTML (the Lane B contract).
//!
//! Timers are virtualized (drained synchronously, ordered by delay) — mirroring
//! the JS tier's virtual clock; no wall-clock waits. `fetch` is an honest throw
//! (no async IO in this tier yet) rather than a silent no-op.

use deno_core::{op2, v8, JsRuntime, OpState, RuntimeOptions};
use std::rc::Rc;

/// Native DOM surface the ops call into. All methods take `&self`; the turbo-dom
/// `Tree` lives behind interior mutability in the implementor (`TreeDom`), since
/// the isolate is single-threaded. Node ids are turbo-dom handles (`u32`).
pub trait DomBackend {
    // reads
    fn query_selector(&self, selector: &str) -> Option<u32>;
    /// Space-joined handle ids (avoids a serde dep at the op boundary).
    fn query_selector_all(&self, selector: &str) -> String;
    fn query_within(&self, node: u32, selector: &str) -> Option<u32>;
    fn get_element_by_id(&self, id: &str) -> Option<u32>;
    fn text_content(&self, node: u32) -> Option<String>;
    fn get_attribute(&self, node: u32, name: &str) -> Option<String>;
    fn tag_name(&self, node: u32) -> Option<String>;
    fn inner_html(&self, node: u32) -> String;
    fn outer_html(&self, node: u32) -> String;
    fn document_html(&self) -> String;
    fn body(&self) -> Option<u32>;
    // mutations
    fn set_text_content(&self, node: u32, text: &str);
    fn set_attribute(&self, node: u32, name: &str, value: &str);
    fn create_element(&self, tag: &str) -> u32;
    fn append_child(&self, parent: u32, child: u32);
    fn set_inner_html(&self, node: u32, html: &str);
}

type Backend = Rc<dyn DomBackend>;

fn dom(state: &OpState) -> Backend {
    state.borrow::<Backend>().clone()
}

const NONE: i32 = -1;
fn id_or_none(h: Option<u32>) -> i32 {
    h.map_or(NONE, |n| n as i32)
}

#[op2(fast)]
fn op_query_selector(state: &mut OpState, #[string] selector: &str) -> i32 {
    id_or_none(dom(state).query_selector(selector))
}

#[op2]
#[string]
fn op_query_selector_all(state: &mut OpState, #[string] selector: &str) -> String {
    dom(state).query_selector_all(selector)
}

#[op2(fast)]
fn op_query_within(state: &mut OpState, node: u32, #[string] selector: &str) -> i32 {
    id_or_none(dom(state).query_within(node, selector))
}

#[op2(fast)]
fn op_get_element_by_id(state: &mut OpState, #[string] id: &str) -> i32 {
    id_or_none(dom(state).get_element_by_id(id))
}

#[op2]
#[string]
fn op_text_content(state: &mut OpState, node: u32) -> Option<String> {
    dom(state).text_content(node)
}

#[op2]
#[string]
fn op_get_attribute(state: &mut OpState, node: u32, #[string] name: &str) -> Option<String> {
    dom(state).get_attribute(node, name)
}

#[op2]
#[string]
fn op_tag_name(state: &mut OpState, node: u32) -> Option<String> {
    dom(state).tag_name(node)
}

#[op2]
#[string]
fn op_inner_html(state: &mut OpState, node: u32) -> String {
    dom(state).inner_html(node)
}

#[op2]
#[string]
fn op_outer_html(state: &mut OpState, node: u32) -> String {
    dom(state).outer_html(node)
}

#[op2(fast)]
fn op_body(state: &mut OpState) -> i32 {
    id_or_none(dom(state).body())
}

#[op2(fast)]
fn op_set_text_content(state: &mut OpState, node: u32, #[string] text: &str) {
    dom(state).set_text_content(node, text);
}

#[op2(fast)]
fn op_set_attribute(state: &mut OpState, node: u32, #[string] name: &str, #[string] value: &str) {
    dom(state).set_attribute(node, name, value);
}

#[op2(fast)]
fn op_create_element(state: &mut OpState, #[string] tag: &str) -> u32 {
    dom(state).create_element(tag)
}

#[op2(fast)]
fn op_append_child(state: &mut OpState, parent: u32, child: u32) {
    dom(state).append_child(parent, child);
}

#[op2(fast)]
fn op_set_inner_html(state: &mut OpState, node: u32, #[string] html: &str) {
    dom(state).set_inner_html(node, html);
}

deno_core::extension!(
    turbo_dom,
    ops = [
        op_query_selector,
        op_query_selector_all,
        op_query_within,
        op_get_element_by_id,
        op_text_content,
        op_get_attribute,
        op_tag_name,
        op_inner_html,
        op_outer_html,
        op_body,
        op_set_text_content,
        op_set_attribute,
        op_create_element,
        op_append_child,
        op_set_inner_html,
    ],
);

// Global bootstrap: document / Element / window / navigator / console / virtual
// timers, layered over the ops. Evaluated once before the page script.
const BOOTSTRAP: &str = r#"
const ops = Deno.core.ops;
function el(id) { return id < 0 ? null : new El(id); }
class El {
  constructor(h) { this.__h = h; }
  get tagName() { return ops.op_tag_name(this.__h); }
  get textContent() { return ops.op_text_content(this.__h); }
  set textContent(v) { ops.op_set_text_content(this.__h, String(v)); }
  get innerHTML() { return ops.op_inner_html(this.__h); }
  set innerHTML(v) { ops.op_set_inner_html(this.__h, String(v)); }
  get outerHTML() { return ops.op_outer_html(this.__h); }
  getAttribute(n) { return ops.op_get_attribute(this.__h, n); }
  setAttribute(n, v) { ops.op_set_attribute(this.__h, n, String(v)); }
  get id() { return ops.op_get_attribute(this.__h, "id") ?? ""; }
  set id(v) { ops.op_set_attribute(this.__h, "id", String(v)); }
  appendChild(c) { ops.op_append_child(this.__h, c.__h); return c; }
  querySelector(s) { return el(ops.op_query_within(this.__h, s)); }
  querySelectorAll(s) { return qsa(ops.op_query_selector_all(s)); }
}
function qsa(packed) {
  return packed ? packed.split(" ").filter((x) => x).map((x) => el(+x)) : [];
}
globalThis.document = {
  querySelector(s) { return el(ops.op_query_selector(s)); },
  querySelectorAll(s) { return qsa(ops.op_query_selector_all(s)); },
  getElementById(id) { return el(ops.op_get_element_by_id(id)); },
  createElement(tag) { return el(ops.op_create_element(tag)); },
  get body() { return el(ops.op_body()); },
  get documentElement() { return el(ops.op_query_selector("html")); },
};
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.navigator = { userAgent: "turbo-crawl", language: "en-US", languages: ["en-US"] };
globalThis.location = { href: "about:blank", protocol: "about:", host: "", pathname: "blank" };
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
})();
const __log = (...a) => Deno.core.print(a.map(String).join(" ") + "\n");
globalThis.console = { log: __log, info: __log, warn: __log, error: __log, debug: () => {} };
// Virtual timers: queued, drained synchronously by __runTimers ordered by delay.
const __timers = [];
let __tid = 1;
globalThis.setTimeout = (fn, delay = 0, ...args) => {
  __timers.push({ id: __tid, fn, delay: +delay || 0, args });
  return __tid++;
};
globalThis.setInterval = globalThis.setTimeout; // one-shot here (no event loop)
globalThis.clearTimeout = (id) => {
  const i = __timers.findIndex((t) => t.id === id);
  if (i >= 0) __timers.splice(i, 1);
};
globalThis.clearInterval = globalThis.clearTimeout;
globalThis.requestAnimationFrame = (fn) => globalThis.setTimeout(fn, 16);
globalThis.cancelAnimationFrame = globalThis.clearTimeout;
globalThis.queueMicrotask = (fn) => globalThis.setTimeout(fn, 0);
globalThis.__runTimers = (max = 100000) => {
  let n = 0;
  while (__timers.length && n++ < max) {
    __timers.sort((a, b) => a.delay - b.delay);
    const t = __timers.shift();
    try { t.fn(...t.args); } catch (e) { Deno.core.print("timer error: " + e + "\n"); }
  }
};
globalThis.fetch = () => {
  throw new Error("fetch is inert in the render tier (no async IO yet)");
};
"#;

fn make_runtime(backend: Backend) -> Result<JsRuntime, String> {
    let mut rt = JsRuntime::new(RuntimeOptions {
        extensions: vec![turbo_dom::init()],
        ..Default::default()
    });
    rt.op_state().borrow_mut().put::<Backend>(backend);
    rt.execute_script("<bootstrap>", BOOTSTRAP)
        .map_err(|e| e.to_string())?;
    Ok(rt)
}

/// Evaluate `script` against a `DomBackend`, returning its result as a string.
/// (Read/eval helper for tests; no timer drain.)
pub fn run_with_dom(backend: Backend, script: &str) -> Result<String, String> {
    let mut rt = make_runtime(backend)?;
    let global = rt
        .execute_script("<page>", script.to_string())
        .map_err(|e| e.to_string())?;
    read_string(&mut rt, global)
}

/// Run page `script` against `backend`, drain virtual timers, and return the
/// hydrated document HTML. The Lane B render contract: JS-gated page in, the
/// HTML after the page's own scripts ran out.
pub fn render_html(backend: Backend, script: &str) -> Result<String, String> {
    let mut rt = make_runtime(backend.clone())?;
    rt.execute_script("<page>", script.to_string())
        .map_err(|e| e.to_string())?;
    rt.execute_script("<timers>", "__runTimers()")
        .map_err(|e| e.to_string())?;
    Ok(backend.document_html())
}

async fn drain_event_loop(rt: &mut JsRuntime) -> Result<(), String> {
    rt.run_event_loop(deno_core::PollEventLoopOptions::default())
        .await
        .map_err(|e| e.to_string())
}

/// Like [`render_html`] but drives deno_core's event loop, so a page script that
/// hydrates asynchronously (`Promise`/`async`-`await`/microtasks, and timer
/// callbacks that themselves await) resolves before serialization. This is the
/// fidelity step real SPA frameworks need.
pub async fn render_html_async(backend: Backend, script: &str) -> Result<String, String> {
    let mut rt = make_runtime(backend.clone())?;
    rt.execute_script("<page>", script.to_string())
        .map_err(|e| e.to_string())?;
    drain_event_loop(&mut rt).await?; // resolve promises/microtasks from the page
    rt.execute_script("<timers>", "__runTimers()")
        .map_err(|e| e.to_string())?;
    drain_event_loop(&mut rt).await?; // resolve promises queued by timer callbacks
    Ok(backend.document_html())
}

fn read_string(rt: &mut JsRuntime, global: v8::Global<v8::Value>) -> Result<String, String> {
    let context = rt.main_context();
    let scope = v8::HandleScope::new(rt.v8_isolate());
    let scope = std::pin::pin!(scope);
    let mut scope = scope.init();
    let context = v8::Local::new(&scope, context);
    let scope = v8::ContextScope::new(&mut scope, context);
    let local = v8::Local::new(&scope, global);
    Ok(local.to_rust_string_lossy(&scope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    // Minimal in-memory backend for op-level tests (no turbo-dom dep here; the
    // real TreeDom is covered in tree_backend.rs). Supports read + a tiny mutate.
    #[derive(Default)]
    struct MapDom {
        text: RefCell<HashMap<u32, String>>,
        attrs: RefCell<HashMap<(u32, String), String>>,
        by_sel: HashMap<String, u32>,
    }
    impl DomBackend for MapDom {
        fn query_selector(&self, s: &str) -> Option<u32> {
            self.by_sel.get(s).copied()
        }
        fn query_selector_all(&self, s: &str) -> String {
            self.by_sel
                .get(s)
                .map(|h| h.to_string())
                .unwrap_or_default()
        }
        fn query_within(&self, _n: u32, s: &str) -> Option<u32> {
            self.query_selector(s)
        }
        fn get_element_by_id(&self, _id: &str) -> Option<u32> {
            None
        }
        fn text_content(&self, n: u32) -> Option<String> {
            self.text.borrow().get(&n).cloned()
        }
        fn get_attribute(&self, n: u32, name: &str) -> Option<String> {
            self.attrs.borrow().get(&(n, name.to_string())).cloned()
        }
        fn tag_name(&self, _n: u32) -> Option<String> {
            Some("DIV".into())
        }
        fn inner_html(&self, n: u32) -> String {
            self.text_content(n).unwrap_or_default()
        }
        fn outer_html(&self, n: u32) -> String {
            self.inner_html(n)
        }
        fn document_html(&self) -> String {
            "<html></html>".into()
        }
        fn body(&self) -> Option<u32> {
            self.query_selector("body")
        }
        fn set_text_content(&self, n: u32, t: &str) {
            self.text.borrow_mut().insert(n, t.to_string());
        }
        fn set_attribute(&self, n: u32, name: &str, v: &str) {
            self.attrs
                .borrow_mut()
                .insert((n, name.to_string()), v.to_string());
        }
        fn create_element(&self, _tag: &str) -> u32 {
            999
        }
        fn append_child(&self, _p: u32, _c: u32) {}
        fn set_inner_html(&self, n: u32, html: &str) {
            self.set_text_content(n, html);
        }
    }

    fn dom_with(sel: &str, h: u32) -> Rc<MapDom> {
        let mut by_sel = HashMap::new();
        by_sel.insert(sel.to_string(), h);
        Rc::new(MapDom {
            by_sel,
            ..Default::default()
        })
    }

    #[test]
    fn read_through_op() {
        let d = dom_with("h1", 1);
        d.set_text_content(1, "Hi");
        assert_eq!(
            run_with_dom(d, "document.querySelector('h1').textContent").unwrap(),
            "Hi"
        );
    }

    #[test]
    fn page_script_mutates_dom() {
        let d = dom_with("#out", 1);
        // page JS writes textContent; backend observes the mutation
        run_with_dom(
            d.clone(),
            "document.querySelector('#out').textContent = 'set'",
        )
        .unwrap();
        assert_eq!(d.text_content(1).as_deref(), Some("set"));
    }

    #[test]
    fn virtual_timer_runs() {
        let d = dom_with("#out", 1);
        render_html(
            d.clone(),
            "setTimeout(() => { document.querySelector('#out').textContent = 'late'; }, 50)",
        )
        .unwrap();
        assert_eq!(d.text_content(1).as_deref(), Some("late"));
    }

    #[test]
    fn window_and_navigator_present() {
        let d = dom_with("x", 1);
        assert_eq!(
            run_with_dom(d.clone(), "navigator.userAgent").unwrap(),
            "turbo-crawl"
        );
        assert_eq!(
            run_with_dom(d, "String(window === globalThis)").unwrap(),
            "true"
        );
    }

    #[test]
    fn fetch_throws_honestly() {
        let d = dom_with("x", 1);
        let err = run_with_dom(d, "fetch('/x')").unwrap_err();
        assert!(err.contains("inert in the render tier"));
    }
}
