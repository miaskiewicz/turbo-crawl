//! JS-execution tier (tier 3): a `deno_core` V8 isolate with a real rtdom↔V8 DOM
//! binding ([`browser_env`], vendored from turbo-test) so page scripts hydrate
//! against a genuine `document`. [`runtime`] is the browser-environment runtime — it
//! grafts the binding onto deno_core's context, installs the non-DOM `window` globals
//! a real page needs (timers/fetch/URL/crypto/streams/…), and drives the event
//! loop + hydration pump + execution budget.

mod browser_env;
mod runtime;

pub use runtime::{
    eval_async, render_html, render_html_async, render_hydrate, render_hydrate_with_budget,
    render_page, render_page_with_budget, run_with_dom, PageSession, DEFAULT_RENDER_BUDGET_MS,
};
