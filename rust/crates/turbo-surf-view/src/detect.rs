//! Lane B routing heuristic (port of `src/detect.mjs`, SPEC §11): cheap,
//! geometry-free decision on whether a no-JS parse is "shell only" and should be
//! escalated to the JS render tier. Near-empty rendered text + external scripts,
//! or an empty known SPA mount + external scripts ⇒ JS required.

use turbo_dom_parser::rtdom::tree::Handle;
use turbo_dom_parser::rtdom::Tree;

const DEFAULT_MIN_TEXT: usize = 200;
const DEFAULT_MIN_SCRIPTS: usize = 1;

const MOUNTS: &[&str] = &["#root", "#app", "#__next", "[data-reactroot]"];

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Detect {
    pub js_required: bool,
    pub text_length: usize,
    pub scripts: usize,
    pub reason: String,
}

fn collapsed_len(tree: &Tree, h: Handle) -> usize {
    tree.text_content(h)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .len()
}

// A common SPA mount point exists but has no server-rendered content.
fn has_empty_mount(tree: &Tree) -> bool {
    MOUNTS.iter().any(|sel| match tree.query_selector(sel) {
        Some(h) => tree.text_content(h).trim().is_empty(),
        None => false,
    })
}

fn reason(js_required: bool, empty_mount: bool) -> String {
    if !js_required {
        "server-rendered content present".to_string()
    } else if empty_mount {
        "empty SPA mount + external scripts".to_string()
    } else {
        "near-empty body + external scripts".to_string()
    }
}

/// Decide whether the page is JS-gated. `min_text`/`min_scripts` default to
/// 200 / 1 when `None`.
pub fn detect_js_required(
    tree: &Tree,
    min_text: Option<usize>,
    min_scripts: Option<usize>,
) -> Detect {
    let min_text = min_text.unwrap_or(DEFAULT_MIN_TEXT);
    let min_scripts = min_scripts.unwrap_or(DEFAULT_MIN_SCRIPTS);

    let text_length = tree
        .query_selector("body")
        .map_or(0, |b| collapsed_len(tree, b));
    let scripts = tree.query_selector_all("script[src]").len();
    let empty_mount = has_empty_mount(tree);

    let shellish = text_length < min_text && scripts >= min_scripts;
    let js_required = shellish || (empty_mount && scripts >= min_scripts);

    Detect {
        js_required,
        text_length,
        scripts,
        reason: reason(js_required, empty_mount),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_rendered_is_not_js_required() {
        let body = "x".repeat(300);
        let tree = Tree::parse(&format!("<body><p>{body}</p></body>"));
        let d = detect_js_required(&tree, None, None);
        assert!(!d.js_required);
        assert_eq!(d.reason, "server-rendered content present");
    }

    #[test]
    fn empty_body_with_external_script_is_shellish() {
        let tree = Tree::parse("<body><script src='/app.js'></script></body>");
        let d = detect_js_required(&tree, None, None);
        assert!(d.js_required);
        assert_eq!(d.scripts, 1);
        assert_eq!(d.reason, "near-empty body + external scripts");
    }

    #[test]
    fn empty_spa_mount_with_content_elsewhere() {
        // Body text is long enough to not be "shellish", but a known mount is empty.
        let filler = "y".repeat(300);
        let tree = Tree::parse(&format!(
            "<body><div id='root'></div><p>{filler}</p><script src='/a.js'></script></body>"
        ));
        let d = detect_js_required(&tree, None, None);
        assert!(d.js_required);
        assert_eq!(d.reason, "empty SPA mount + external scripts");
    }

    #[test]
    fn no_external_scripts_never_js_required() {
        let tree = Tree::parse("<body><div id='root'></div></body>");
        let d = detect_js_required(&tree, None, None);
        assert!(!d.js_required);
        assert_eq!(d.scripts, 0);
    }

    #[test]
    fn thresholds_are_tunable() {
        let tree = Tree::parse("<body><p>short</p><script src='/a.js'></script></body>");
        // Lower the text threshold below the actual length → not shellish.
        let d = detect_js_required(&tree, Some(1), None);
        assert!(!d.js_required);
    }
}
