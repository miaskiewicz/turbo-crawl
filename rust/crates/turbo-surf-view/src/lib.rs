//! turbo-surf tier-2 **views** over the turbo-dom `rtdom::Tree` — the full
//! agent-facing read/extract/interact surface, ported from `src/*.mjs`:
//!
//! - [`text`] / [`markdown`] — plain-text + Markdown content views
//! - [`xpath`] / [`query`] — pragmatic XPath subset + unified CSS-or-XPath query
//! - [`aria`] / [`ax`] / [`aria_snapshot`] — roles/names, accessibility tree,
//!   YAML-ish snapshot + subset matcher
//! - [`extract`] / [`schema`] — interactive-element index + links; typed
//!   structured extraction
//! - [`visible`] — cascade-based visibility
//! - [`locator`] — getByRole/Text/Label/Attr resolver engine
//! - [`detect`] — Lane B (JS-required) routing heuristic
//! - [`hydration`] — no-JS hydration-state mining (Next/JSON-LD/typed/globals)
//! - [`dom_ops`] / [`actions`] — element read/write helpers; link/form intent
//!   graph (form serialization → GET/POST/multipart submission)

pub mod actions;
pub mod aria;
pub mod aria_snapshot;
pub mod ax;
pub mod detect;
pub mod dom_ops;
pub mod extract;
pub mod hydration;
pub mod locator;
pub mod markdown;
pub mod query;
pub mod schema;
pub mod text;
pub mod visible;
pub mod xpath;

pub use actions::{
    build_submission, click_intent, fill_value, serialize_form, ClickIntent, Submission,
};
pub use aria::{
    accessible_description, accessible_error_message, accessible_name, implicit_role, role_of,
};
pub use aria_snapshot::{aria_snapshot, matches_aria_snapshot};
pub use ax::{accessibility_tree, ax_subtree, AxNode};
pub use detect::{detect_js_required, Detect};
pub use dom_ops::{
    css_value, input_value_of, is_checked, is_editable, is_empty, is_enabled, select_option,
    selected_values, set_checked,
};
pub use extract::{interactive_elements, links, Interactive};
pub use hydration::{extract_hydration_state, Hydration};
pub use locator::{by_attr_text, by_label, by_role, by_text, text_match, TextMode};
pub use markdown::markdown;
pub use query::{query, query_first, Match, QueryType};
pub use schema::{extract_schema, Field, FieldType};
pub use text::text;
pub use visible::is_visible;
pub use xpath::{evaluate as evaluate_xpath, XPath};
