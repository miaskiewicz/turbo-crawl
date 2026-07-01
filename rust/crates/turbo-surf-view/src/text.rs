//! Plain-text view (port of `src/text.mjs`): all text, no markup, line breaks at
//! block-level boundaries so structure survives as paragraphs. Inline elements
//! stay on one line; block elements break; `<br>`/`<hr>` break; `<pre>` is
//! preserved. Raw reading text for embeddings/summarization (no markdown syntax).

use turbo_dom_parser::rtdom::tree::Handle;
use turbo_dom_parser::rtdom::Tree;

const ELEMENT_NODE: u8 = 1;
const TEXT_NODE: u8 = 3;

const SKIP: &[&str] = &[
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "SVG",
];

const BLOCK: &[&str] = &[
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "SECTION",
    "TABLE",
    "TBODY",
    "TFOOT",
    "THEAD",
    "TR",
    "UL",
];

const CELL: &[&str] = &["TD", "TH"];

// Collapse runs of ASCII whitespace to a single space (boundaries preserved).
fn collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for c in s.chars() {
        let ws = matches!(c, ' ' | '\t' | '\r' | '\n');
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

struct Acc {
    lines: Vec<String>,
    cur: String,
}

impl Acc {
    fn flush(&mut self) {
        let t = self
            .cur
            .split_ascii_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !t.is_empty() {
            self.lines.push(t);
        }
        self.cur.clear();
    }
}

/// Render the subtree at `root` (or the document `<body>` when present) to
/// structured plain text.
pub fn text(tree: &Tree, root: Handle) -> String {
    // Whole-document → prefer <body>; a specific element → render it directly.
    let start = if root == tree.root() {
        tree.query_selector("body").unwrap_or(root)
    } else {
        root
    };
    let mut acc = Acc {
        lines: Vec::new(),
        cur: String::new(),
    };
    walk(tree, start, &mut acc);
    acc.flush();
    acc.lines.join("\n")
}

fn walk(tree: &Tree, h: Handle, acc: &mut Acc) {
    match tree.node_type_id(h) {
        TEXT_NODE => acc
            .cur
            .push_str(&collapse(&tree.node_value(h).unwrap_or_default())),
        ELEMENT_NODE => walk_element(tree, h, acc),
        _ => {}
    }
}

fn walk_element(tree: &Tree, h: Handle, acc: &mut Acc) {
    let tag = tree.tag_name(h).unwrap_or_default();
    if SKIP.contains(&tag.as_str()) {
        return;
    }
    if leaf_element(tree, h, &tag, acc) {
        return;
    }
    let block = BLOCK.contains(&tag.as_str());
    if block {
        acc.flush();
    }
    for c in tree.children(h) {
        walk(tree, c, acc);
    }
    if CELL.contains(&tag.as_str()) {
        acc.cur.push('\t');
    }
    if block {
        acc.flush();
    }
}

// Tags that end the current line without child recursion. Returns true if handled.
fn leaf_element(tree: &Tree, h: Handle, tag: &str, acc: &mut Acc) -> bool {
    match tag {
        "BR" | "HR" => acc.flush(),
        "PRE" => {
            acc.flush();
            let code = tree.text_content(h).trim_end().to_string();
            if !code.is_empty() {
                acc.lines.push(code);
            }
        }
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(html: &str) -> Tree {
        Tree::parse(html)
    }

    #[test]
    fn blocks_break_inline_joins() {
        let tree = t("<body><p>Hello <b>world</b></p><p>Second</p></body>");
        assert_eq!(text(&tree, tree.root()), "Hello world\nSecond");
    }

    #[test]
    fn skips_script_and_style() {
        let tree = t("<body><p>keep</p><script>var x=1</script><style>.a{}</style></body>");
        assert_eq!(text(&tree, tree.root()), "keep");
    }

    #[test]
    fn br_breaks_line() {
        let tree = t("<body><div>a<br>b</div></body>");
        assert_eq!(text(&tree, tree.root()), "a\nb");
    }

    #[test]
    fn pre_is_preserved() {
        let tree = t("<body><pre>line1\n  line2</pre></body>");
        assert_eq!(text(&tree, tree.root()), "line1\n  line2");
    }

    #[test]
    fn table_cells_separated() {
        // The cell tab is collapsed to a space by flush (matches the JS view).
        let tree = t("<body><table><tr><td>a</td><td>b</td></tr></table></body>");
        assert_eq!(text(&tree, tree.root()), "a b");
    }

    #[test]
    fn collapses_whitespace() {
        let tree = t("<body><p>a   \n  b\t c</p></body>");
        assert_eq!(text(&tree, tree.root()), "a b c");
    }

    #[test]
    fn ignores_comment_nodes() {
        // Comment node hits the catch-all node-type arm (no text contributed).
        let tree = t("<body><div>a<!--skip me-->b</div></body>");
        assert_eq!(text(&tree, tree.root()), "ab");
    }

    #[test]
    fn falls_back_to_root_without_body() {
        // No <body> wrapper element present after parse → use root.
        let tree = t("<p>bare</p>");
        assert!(text(&tree, tree.root()).contains("bare"));
    }
}
