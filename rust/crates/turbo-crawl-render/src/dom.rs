//! DOM op bridge (tier 3 seam). Page JS calls `document.querySelector(...)` →
//! V8 → `#[op2]` → a `DomBackend` trait object → back. The real backend binds
//! the turbo-dom Rust crate; the stub in tests proves the roundtrip offline.
//! This is the indirection-free path the JS-in-JS-VM design couldn't have: the
//! DOM lives in Rust where the parser already is.

use deno_core::{op2, v8, JsRuntime, OpState, RuntimeOptions};
use std::rc::Rc;

/// Native DOM surface the ops call into. Nodes are addressed by opaque u32 ids
/// minted by the backend. Extend as tier-2 view modules need more (children,
/// classList, computed visibility, ...).
pub trait DomBackend {
    fn query_selector(&self, selector: &str) -> Option<u32>;
    fn text_content(&self, node: u32) -> Option<String>;
    fn get_attribute(&self, node: u32, name: &str) -> Option<String>;
}

type Backend = Rc<dyn DomBackend>;

fn backend(state: &OpState) -> Backend {
    state.borrow::<Backend>().clone()
}

// Returns the node id, or -1 for "no match" (keeps the op on the fast path
// instead of boxing an Option across the boundary).
#[op2(fast)]
fn op_query_selector(state: &mut OpState, #[string] selector: &str) -> i32 {
    backend(state)
        .query_selector(selector)
        .map_or(-1, |n| n as i32)
}

#[op2]
#[string]
fn op_text_content(state: &mut OpState, node: u32) -> Option<String> {
    backend(state).text_content(node)
}

#[op2]
#[string]
fn op_get_attribute(state: &mut OpState, node: u32, #[string] name: &str) -> Option<String> {
    backend(state).get_attribute(node, name)
}

deno_core::extension!(
    turbo_dom,
    ops = [op_query_selector, op_text_content, op_get_attribute],
);

// JS bootstrap layering a minimal `document` over the ops. Grows into the full
// global surface (window/navigator/timers/fetch) in task #7.
const BOOTSTRAP: &str = r#"
const ops = Deno.core.ops;
function makeEl(id) {
  return {
    get textContent() { return ops.op_text_content(id); },
    getAttribute(name) { return ops.op_get_attribute(id, name); },
  };
}
globalThis.document = {
  querySelector(selector) {
    const id = ops.op_query_selector(selector);
    return id < 0 ? null : makeEl(id);
  },
};
"#;

/// Run page `script` against a `DomBackend`, returning its result as a string.
/// Boots an isolate with the DOM ops + bootstrap, injects the backend into op
/// state, then evaluates the script.
pub fn run_with_dom(backend: Backend, script: &str) -> Result<String, String> {
    let mut rt = JsRuntime::new(RuntimeOptions {
        extensions: vec![turbo_dom::init()],
        ..Default::default()
    });
    rt.op_state().borrow_mut().put::<Backend>(backend);
    rt.execute_script("<bootstrap>", BOOTSTRAP)
        .map_err(|e| e.to_string())?;
    let global = rt
        .execute_script("<page>", script.to_string())
        .map_err(|e| e.to_string())?;
    read_string(&mut rt, global)
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
    use std::collections::HashMap;

    // Tiny fixed DOM: one <h1 id="title">Hello</h1> addressed as node 1.
    struct StubDom {
        by_selector: HashMap<String, u32>,
        text: HashMap<u32, String>,
        attrs: HashMap<(u32, String), String>,
    }

    impl DomBackend for StubDom {
        fn query_selector(&self, selector: &str) -> Option<u32> {
            self.by_selector.get(selector).copied()
        }
        fn text_content(&self, node: u32) -> Option<String> {
            self.text.get(&node).cloned()
        }
        fn get_attribute(&self, node: u32, name: &str) -> Option<String> {
            self.attrs.get(&(node, name.to_string())).cloned()
        }
    }

    fn stub() -> Rc<dyn DomBackend> {
        let mut by_selector = HashMap::new();
        by_selector.insert("h1".to_string(), 1);
        let mut text = HashMap::new();
        text.insert(1, "Hello".to_string());
        let mut attrs = HashMap::new();
        attrs.insert((1, "id".to_string()), "title".to_string());
        Rc::new(StubDom {
            by_selector,
            text,
            attrs,
        })
    }

    #[test]
    fn page_js_reads_text_through_op() {
        let out = run_with_dom(stub(), "document.querySelector('h1').textContent").unwrap();
        assert_eq!(out, "Hello");
    }

    #[test]
    fn page_js_reads_attribute_through_op() {
        let out = run_with_dom(stub(), "document.querySelector('h1').getAttribute('id')").unwrap();
        assert_eq!(out, "title");
    }

    #[test]
    fn missing_selector_is_null() {
        let out = run_with_dom(stub(), "String(document.querySelector('.nope'))").unwrap();
        assert_eq!(out, "null");
    }
}
