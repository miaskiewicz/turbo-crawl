//! JS-execution tier (tier 3): a `deno_core` V8 isolate with a real rtdom↔V8 DOM
//! binding ([`browser_env`], vendored from turbo-test) so page scripts hydrate
//! against a genuine `document`. [`dom`] is the runtime that grafts the binding onto
//! deno_core's context and drives fetch/timers/event-loop/budget.

mod browser_env;
pub mod dom;

pub use dom::{
    render_html, render_html_async, render_hydrate, render_hydrate_with_budget, render_page,
    render_page_with_budget, run_with_dom, DEFAULT_RENDER_BUDGET_MS,
};
