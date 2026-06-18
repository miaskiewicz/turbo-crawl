//! turbo-crawl tier-2 **views** over the turbo-dom `rtdom::Tree`. First batch:
//!
//! - [`text`] — structured plain-text view (block-aware line breaks)
//! - [`xpath`] — pragmatic XPath subset (`//`, `/`, predicates, `@attr`)
//! - [`query`] — unified CSS-or-XPath query → `{ node, html, text }`
//!
//! Remaining view modules (extract / visible / aria / locator / markdown / ax /
//! aria-snapshot / schema / hydration / dom-ops) land here next (task #4).

pub mod query;
pub mod text;
pub mod xpath;

pub use query::{query, query_first, Match, QueryType};
pub use text::text;
pub use xpath::{evaluate as evaluate_xpath, XPath};
