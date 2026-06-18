//! turbo-crawl tier-2 **views** over the turbo-dom `rtdom::Tree`. First batch:
//!
//! - [`text`] — structured plain-text view (block-aware line breaks)
//! - [`xpath`] — pragmatic XPath subset (`//`, `/`, predicates, `@attr`)
//! - [`query`] — unified CSS-or-XPath query → `{ node, html, text }`
//!
//! Remaining view modules (extract / visible / aria / locator / markdown / ax /
//! aria-snapshot / schema / hydration / dom-ops) land here next (task #4).

pub mod aria;
pub mod extract;
pub mod locator;
pub mod markdown;
pub mod query;
pub mod text;
pub mod visible;
pub mod xpath;

pub use aria::{accessible_name, implicit_role, role_of};
pub use extract::{interactive_elements, links, Interactive};
pub use locator::{by_attr_text, by_label, by_role, by_text, text_match, TextMode};
pub use markdown::markdown;
pub use query::{query, query_first, Match, QueryType};
pub use text::text;
pub use visible::is_visible;
pub use xpath::{evaluate as evaluate_xpath, XPath};
