//! Markdown view of main content (port of `src/markdown.mjs`, SPEC §7.2) for
//! RAG / summarization. A DOM walk, not a renderer: boilerplate
//! (script/style/nav/footer/aside) is dropped heuristically. Headings, emphasis,
//! links, code, lists, blockquotes, `<pre>`, `<hr>`, and GFM tables are emitted.

use turbo_dom_parser::rtdom::Tree;
use turbo_surf_core::url::resolve;

const ELEMENT_NODE: u8 = 1;
const TEXT_NODE: u8 = 3;

const SKIP: &[&str] = &[
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "NAV", "FOOTER", "ASIDE",
];

fn heading_marker(tag: &str) -> Option<&'static str> {
    match tag {
        "H1" => Some("#"),
        "H2" => Some("##"),
        "H3" => Some("###"),
        "H4" => Some("####"),
        "H5" => Some("#####"),
        "H6" => Some("######"),
        _ => None,
    }
}

fn collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for c in s.chars() {
        let ws = c.is_whitespace();
        if ws {
            if !prev_ws {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
        prev_ws = ws;
    }
    out
}

fn wrap(marker: &str, inner: &str) -> String {
    if inner.trim().is_empty() {
        String::new()
    } else {
        format!("{marker}{inner}{marker}")
    }
}

// --- inline serialization ---------------------------------------------------

fn inline(tree: &Tree, h: u32, base: &str) -> String {
    match tree.node_type(h) {
        TEXT_NODE => collapse(&tree.node_value(h).unwrap_or_default()),
        ELEMENT_NODE => inline_element(tree, h, base),
        _ => String::new(),
    }
}

fn children_inline(tree: &Tree, h: u32, base: &str) -> String {
    let mut out = String::new();
    for c in tree.children(h) {
        out.push_str(&inline(tree, c, base));
    }
    out
}

fn inline_element(tree: &Tree, h: u32, base: &str) -> String {
    let tag = tree.tag_name(h).unwrap_or_default();
    if SKIP.contains(&tag.as_str()) {
        return String::new();
    }
    if tag == "BR" {
        return "\n".to_string();
    }
    let inner = children_inline(tree, h, base);
    match tag.as_str() {
        "A" => link(tree, h, base, &inner),
        "STRONG" | "B" => wrap("**", &inner),
        "EM" | "I" => wrap("*", &inner),
        "CODE" => wrap("`", &inner),
        _ => inner,
    }
}

fn link(tree: &Tree, h: u32, base: &str, inner: &str) -> String {
    match tree
        .get_attribute(h, "href")
        .and_then(|href| resolve(base, href))
    {
        Some(href) => format!("[{inner}]({href})"),
        None => inner.to_string(),
    }
}

// --- block serialization ----------------------------------------------------

// Descendants of `node` whose uppercased tag is in `tags`, in document order.
fn descendants_by_tag(tree: &Tree, node: u32, tags: &[&str]) -> Vec<u32> {
    tree.descendants(node)
        .into_iter()
        .filter(|&h| {
            tree.node_type(h) == ELEMENT_NODE
                && tree.tag_name(h).is_some_and(|t| tags.contains(&t.as_str()))
        })
        .collect()
}

fn element_children_by_tag(tree: &Tree, node: u32, tag: &str) -> Vec<u32> {
    tree.children(node)
        .into_iter()
        .filter(|&c| tree.tag_name(c).as_deref() == Some(tag))
        .collect()
}

fn block(tree: &Tree, h: u32, base: &str, out: &mut Vec<String>) {
    match tree.node_type(h) {
        TEXT_NODE => {
            let t = collapse(&tree.node_value(h).unwrap_or_default())
                .trim()
                .to_string();
            if !t.is_empty() {
                out.push(t);
            }
        }
        ELEMENT_NODE => block_element(tree, h, base, out),
        _ => {}
    }
}

fn block_element(tree: &Tree, h: u32, base: &str, out: &mut Vec<String>) {
    let tag = tree.tag_name(h).unwrap_or_default();
    if SKIP.contains(&tag.as_str()) {
        return;
    }
    if let Some(marker) = heading_marker(&tag) {
        let text = children_inline(tree, h, base).trim().to_string();
        if !text.is_empty() {
            out.push(format!("{marker} {text}"));
        }
        return;
    }
    block_tag(tree, h, base, out, &tag);
}

fn block_tag(tree: &Tree, h: u32, base: &str, out: &mut Vec<String>, tag: &str) {
    match tag {
        "P" => push_inline(tree, h, base, out, ""),
        "BLOCKQUOTE" => push_inline(tree, h, base, out, "> "),
        "PRE" => emit_pre(tree, h, out),
        "UL" => emit_list(tree, h, base, out, false),
        "OL" => emit_list(tree, h, base, out, true),
        "HR" => out.push("---".to_string()),
        "TABLE" => emit_table(tree, h, base, out),
        // Container: recurse into children as blocks.
        _ => {
            for c in tree.children(h) {
                block(tree, c, base, out);
            }
        }
    }
}

fn push_inline(tree: &Tree, h: u32, base: &str, out: &mut Vec<String>, prefix: &str) {
    let text = children_inline(tree, h, base).trim().to_string();
    if !text.is_empty() {
        out.push(format!("{prefix}{text}"));
    }
}

fn emit_pre(tree: &Tree, h: u32, out: &mut Vec<String>) {
    let code = tree.text_content(h).trim_end_matches('\n').to_string();
    if !code.trim().is_empty() {
        out.push(format!("```\n{code}\n```"));
    }
}

fn emit_list(tree: &Tree, list: u32, base: &str, out: &mut Vec<String>, ordered: bool) {
    let mut lines = Vec::new();
    for item in element_children_by_tag(tree, list, "LI") {
        let text = children_inline(tree, item, base).trim().to_string();
        if !text.is_empty() {
            let marker = if ordered {
                format!("{}.", lines.len() + 1)
            } else {
                "-".to_string()
            };
            lines.push(format!("{marker} {text}"));
        }
    }
    if !lines.is_empty() {
        out.push(lines.join("\n"));
    }
}

fn row_cells(tree: &Tree, tr: u32, base: &str) -> Vec<String> {
    descendants_by_tag(tree, tr, &["TH", "TD"])
        .into_iter()
        .map(|c| children_inline(tree, c, base).trim().replace('|', "\\|"))
        .collect()
}

fn emit_table(tree: &Tree, table: u32, base: &str, out: &mut Vec<String>) {
    let mut lines: Vec<String> = Vec::new();
    for tr in descendants_by_tag(tree, table, &["TR"]) {
        let cells = row_cells(tree, tr, base);
        if cells.is_empty() {
            continue;
        }
        lines.push(format!("| {} |", cells.join(" | ")));
        if lines.len() == 1 {
            let rule: Vec<&str> = cells.iter().map(|_| "---").collect();
            lines.push(format!("| {} |", rule.join(" | ")));
        }
    }
    if !lines.is_empty() {
        out.push(lines.join("\n"));
    }
}

/// Render the document's main content (`<main>` → `<body>` → root) to Markdown.
pub fn markdown(tree: &Tree, root: u32, base: &str) -> String {
    let start = tree
        .query_selector("main")
        .or_else(|| tree.query_selector("body"))
        .unwrap_or(root);
    let mut out = Vec::new();
    for c in tree.children(start) {
        block(tree, c, base, &mut out);
    }
    out.join("\n\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(html: &str) -> String {
        let tree = Tree::parse(html);
        markdown(&tree, tree.root(), "https://x.test/")
    }

    #[test]
    fn headings_and_paragraphs() {
        assert_eq!(
            md("<body><h1>Title</h1><p>Body text</p></body>"),
            "# Title\n\nBody text"
        );
    }

    #[test]
    fn emphasis_links_code() {
        let out = md(
            "<body><p>a <strong>b</strong> <em>c</em> <code>d</code> <a href='/x'>e</a></p></body>",
        );
        assert_eq!(out, "a **b** *c* `d` [e](https://x.test/x)");
    }

    #[test]
    fn link_without_href_is_plain_text() {
        assert_eq!(md("<body><p><a>plain</a></p></body>"), "plain");
    }

    #[test]
    fn unordered_and_ordered_lists() {
        assert_eq!(md("<body><ul><li>a</li><li>b</li></ul></body>"), "- a\n- b");
        assert_eq!(
            md("<body><ol><li>x</li><li>y</li></ol></body>"),
            "1. x\n2. y"
        );
    }

    #[test]
    fn blockquote_pre_hr() {
        assert_eq!(md("<body><blockquote>q</blockquote></body>"), "> q");
        assert_eq!(
            md("<body><pre>code\nhere</pre></body>"),
            "```\ncode\nhere\n```"
        );
        assert_eq!(md("<body><hr></body>"), "---");
    }

    #[test]
    fn gfm_table() {
        let out = md("<body><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body>");
        assert_eq!(out, "| A | B |\n| --- | --- |\n| 1 | 2 |");
    }

    #[test]
    fn skips_nav_footer_script() {
        let out =
            md("<body><nav>menu</nav><p>keep</p><footer>foot</footer><script>x</script></body>");
        assert_eq!(out, "keep");
    }

    #[test]
    fn prefers_main_over_body() {
        let out = md("<body><p>chrome</p><main><p>content</p></main></body>");
        assert_eq!(out, "content");
    }

    #[test]
    fn br_becomes_newline_inline() {
        // <br> inside a paragraph emits a hard break in the inline text.
        assert_eq!(md("<body><p>a<br>b</p></body>"), "a\nb");
    }

    #[test]
    fn falls_back_to_root_without_body() {
        assert_eq!(md("<p>bare</p>"), "bare");
    }

    #[test]
    fn inline_edge_cases() {
        assert_eq!(md("<body><p>x<strong></strong>y</p></body>"), "xy"); // empty emphasis dropped
        assert_eq!(md("<body><p>a<!--c-->b</p></body>"), "ab"); // comment inline → ""
        assert_eq!(md("<body><p>a<script>z</script>b</p></body>"), "ab"); // skipped inline
        assert_eq!(md("<body><p><span>hi</span></p></body>"), "hi"); // passthrough tag
    }

    #[test]
    fn loose_text_and_container_recursion() {
        // Top-level text node, a comment (ignored block node), and a container
        // <div> that recurses into block children.
        assert_eq!(
            md("<body>loose<!--skip--><div><p>nested</p></div></body>"),
            "loose\n\nnested"
        );
    }

    #[test]
    fn table_skips_empty_rows() {
        let out = md("<body><table><tr></tr><tr><td>a</td><td>b</td></tr></table></body>");
        assert_eq!(out, "| a | b |\n| --- | --- |");
    }
}
