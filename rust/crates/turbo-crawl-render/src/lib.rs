//! Toolchain smoke test for the JS-execution tier: boot a deno_core isolate and
//! evaluate trivial JS. Validates the V8 build before the DOM op layer lands.

pub mod dom;
pub use dom::{run_with_dom, DomBackend};

use deno_core::{v8, JsRuntime, RuntimeOptions};

/// Evaluate `code` in a fresh isolate, returning its result as an i64.
pub fn eval_i64(code: &str) -> Result<i64, String> {
    let mut rt = JsRuntime::new(RuntimeOptions::default());
    let global = rt
        .execute_script("<smoke>", code.to_string())
        .map_err(|e| e.to_string())?;
    let context = rt.main_context();
    let scope = v8::HandleScope::new(rt.v8_isolate());
    let scope = std::pin::pin!(scope);
    let mut scope = scope.init();
    let context = v8::Local::new(&scope, context);
    let scope = v8::ContextScope::new(&mut scope, context);
    let local = v8::Local::new(&scope, global);
    local
        .integer_value(&scope)
        .ok_or_else(|| "not an integer".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolate_runs_js() {
        assert_eq!(eval_i64("1 + 2").unwrap(), 3);
    }
}
