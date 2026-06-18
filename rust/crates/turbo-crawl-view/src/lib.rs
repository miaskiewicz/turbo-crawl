//! turbo-crawl tier-2 **views** over the turbo-dom `rtdom::Tree`.
//!
//! - [`text`] — structured plain-text view (block-aware line breaks)
//! - [`markdown`] — main-content Markdown (RAG / summarization)
//! - [`xpath`] / [`query`] — pragmatic XPath subset + unified CSS-or-XPath query
//! - [`aria`] — roles + accessible name/description heuristics
//! - [`extract`] — interactive-element index + links
//! - [`visible`] — cascade-based visibility
//! - [`locator`] — getByRole/Text/Label/Attr resolver engine
//! - [`detect`] — Lane B (JS-required) routing heuristic
//! - [`hydration`] — no-JS hydration-state mining (Next/JSON-LD/typed/globals)
//!
//! Remaining (task #4): dom-ops, actions, ax, aria-snapshot, schema.

pub mod aria;
pub mod detect;
pub mod extract;
pub mod hydration;
pub mod locator;
pub mod markdown;
pub mod query;
pub mod text;
pub mod visible;
pub mod xpath;

pub use aria::{accessible_name, implicit_role, role_of};
pub use detect::{detect_js_required, Detect};
pub use extract::{interactive_elements, links, Interactive};
pub use hydration::{extract_hydration_state, Hydration};
pub use locator::{by_attr_text, by_label, by_role, by_text, text_match, TextMode};
pub use markdown::markdown;
pub use query::{query, query_first, Match, QueryType};
pub use text::text;
pub use visible::is_visible;
pub use xpath::{evaluate as evaluate_xpath, XPath};
