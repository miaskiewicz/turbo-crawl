//! ARIA snapshot (port of `src/aria-snapshot.mjs`, Playwright `ariaSnapshot` /
//! `toMatchAriaSnapshot`): a YAML-ish text view of an element subtree's
//! role/name structure, plus an ordered-subset matcher. Built on the
//! accessibility tree ([`crate::ax`]) so roles/names match the ax view.

use crate::ax::{ax_subtree, AxNode};
use regex::Regex;
use turbo_dom_parser::rtdom::tree::Handle;
use turbo_dom_parser::rtdom::Tree;

const GENERIC: &str = "generic";

fn line(node: &AxNode, depth: usize) -> String {
    let pad = "  ".repeat(depth);
    if node.name.is_empty() {
        format!("{pad}- {}", node.role)
    } else {
        format!("{pad}- {} \"{}\"", node.role, node.name)
    }
}

// The synthetic "generic" wrapper is not shown; its children stay at this depth.
fn serialize(node: &AxNode, depth: usize, lines: &mut Vec<String>) {
    let shown = node.role != GENERIC;
    if shown {
        lines.push(line(node, depth));
    }
    let child_depth = if shown { depth + 1 } else { depth };
    for kid in &node.children {
        serialize(kid, child_depth, lines);
    }
}

/// Indented YAML-ish ARIA snapshot text for the subtree rooted at `h`.
pub fn aria_snapshot(tree: &Tree, h: Handle) -> String {
    let mut lines = Vec::new();
    if let Some(node) = ax_subtree(tree, h) {
        serialize(&node, 0, &mut lines);
    }
    lines.join("\n")
}

#[derive(Debug)]
struct Flat {
    role: String,
    name: String,
}

fn flatten(node: &AxNode, out: &mut Vec<Flat>) {
    if node.role != GENERIC {
        out.push(Flat {
            role: node.role.clone(),
            name: node.name.clone(),
        });
    }
    for kid in &node.children {
        flatten(kid, out);
    }
}

enum Want {
    Name(String),
    Re(Regex),
    Any,
}

struct Expected {
    role: String,
    want: Want,
}

// Parse `- role`, `- role "name"`, or `- role /re/flags`.
fn parse_line(raw: &str) -> Option<Expected> {
    let t = raw.trim();
    let body = t.strip_prefix('-')?.trim();
    let (role, rest) = split_role(body)?;
    Some(Expected {
        role,
        want: parse_want(rest.trim()),
    })
}

fn split_role(body: &str) -> Option<(String, &str)> {
    let end = body
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .unwrap_or(body.len());
    if end == 0 {
        return None;
    }
    Some((body[..end].to_string(), &body[end..]))
}

fn parse_want(rest: &str) -> Want {
    if rest.is_empty() {
        return Want::Any;
    }
    if let Some(inner) = rest.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return Want::Name(inner.to_string());
    }
    parse_regex_want(rest).unwrap_or(Want::Any)
}

// `/source/flags` → a compiled Regex (flags: `i` supported via inline (?i)).
fn parse_regex_want(rest: &str) -> Option<Want> {
    let body = rest.strip_prefix('/')?;
    let last = body.rfind('/')?;
    let (src, flags) = (&body[..last], &body[last + 1..]);
    let pattern = if flags.contains('i') {
        format!("(?i){src}")
    } else {
        src.to_string()
    };
    Regex::new(&pattern).ok().map(Want::Re)
}

fn parse_expected(text: &str) -> Vec<Expected> {
    text.lines().filter_map(parse_line).collect()
}

fn entry_matches(want: &Expected, node: &Flat) -> bool {
    if want.role != node.role {
        return false;
    }
    match &want.want {
        Want::Any => true,
        Want::Name(n) => &node.name == n,
        Want::Re(re) => re.is_match(&node.name),
    }
}

fn is_subsequence(want: &[Expected], have: &[Flat]) -> bool {
    let mut i = 0;
    for node in have {
        if i >= want.len() {
            break;
        }
        if entry_matches(&want[i], node) {
            i += 1;
        }
    }
    i == want.len()
}

/// True if `expected` is an ordered role/name subset of `h`'s ax subtree.
pub fn matches_aria_snapshot(tree: &Tree, h: Handle, expected: &str) -> bool {
    let mut have = Vec::new();
    if let Some(node) = ax_subtree(tree, h) {
        flatten(&node, &mut have);
    }
    is_subsequence(&parse_expected(expected), &have)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first(tree: &Tree, sel: &str) -> Handle {
        tree.query_selector(sel).unwrap()
    }

    #[test]
    fn serializes_indented_roles_and_names() {
        let tree = Tree::parse("<nav><a href='/'>Home</a></nav>");
        let snap = aria_snapshot(&tree, first(&tree, "nav"));
        // a roled container takes its collapsed text as the accessible name
        assert_eq!(snap, "- navigation \"Home\"\n  - link \"Home\"");
    }

    #[test]
    fn generic_wrapper_elided_children_kept() {
        let tree =
            Tree::parse("<section><div><a href='/a'>A</a><a href='/b'>B</a></div></section>");
        let snap = aria_snapshot(&tree, first(&tree, "section"));
        // the roleless <div> (generic) is not printed; its links stay under region
        assert_eq!(snap, "- region \"AB\"\n  - link \"A\"\n  - link \"B\"");
    }

    #[test]
    fn subset_match_in_order() {
        let tree = Tree::parse("<main><h1>Title</h1><a href='/'>Home</a></main>");
        let h = first(&tree, "main");
        assert!(matches_aria_snapshot(
            &tree,
            h,
            "- heading \"Title\"\n- link \"Home\""
        ));
        // out of order → no match
        assert!(!matches_aria_snapshot(
            &tree,
            h,
            "- link \"Home\"\n- heading \"Title\""
        ));
    }

    #[test]
    fn role_only_and_regex_name() {
        let tree = Tree::parse("<nav><a href='/'>Home Page</a></nav>");
        let h = first(&tree, "nav");
        assert!(matches_aria_snapshot(&tree, h, "- link")); // name omitted → any
        assert!(matches_aria_snapshot(&tree, h, "- link /home/i")); // case-insensitive regex
        assert!(!matches_aria_snapshot(&tree, h, "- link \"home\"")); // exact name mismatch
    }

    #[test]
    fn missing_entry_fails_match() {
        let tree = Tree::parse("<nav><a href='/'>Home</a></nav>");
        let h = first(&tree, "nav");
        assert!(!matches_aria_snapshot(&tree, h, "- button \"Submit\""));
    }

    #[test]
    fn role_only_line_for_nameless_node() {
        let tree = Tree::parse("<input value='x'>");
        // an input has no accessible name → role-only line
        assert_eq!(aria_snapshot(&tree, first(&tree, "input")), "- textbox");
    }

    #[test]
    fn regex_without_flags_junk_and_short_want() {
        let tree = Tree::parse("<nav><a href='/'>Home</a></nav>");
        let h = first(&tree, "nav");
        assert!(matches_aria_snapshot(&tree, h, "- link /Home/")); // regex, no flags
        assert!(matches_aria_snapshot(&tree, h, "- @@@\n- link")); // malformed line skipped
        assert!(matches_aria_snapshot(&tree, h, "- navigation")); // want shorter than have
    }

    #[test]
    fn empty_subtree_snapshot_is_empty() {
        let tree = Tree::parse("<script>x</script>");
        assert_eq!(aria_snapshot(&tree, first(&tree, "script")), "");
    }
}
