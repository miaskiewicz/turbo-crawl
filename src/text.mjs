// Plain-text view of a page: all text, no markup, with line breaks intelligently
// inserted at block-level boundaries so DOM structure survives as paragraphs.
// Inline elements (a/span/b/em/code/…) stay on one line; block elements
// (p/div/li/headings/tr/…) start a new line. <br> breaks, <pre> is preserved.
//
// Distinct from markdown() (which emits #/-/links syntax) — this is raw reading
// text for embeddings/summarization where markup would be noise.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const SKIP = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "HEAD",
  "META",
  "LINK",
  "TITLE",
  "SVG",
]);

// Elements that force a line break before and after their content.
const BLOCK = new Set([
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
]);

function collapse(s) {
  return (s ?? "").replace(/[ \t\r\n]+/g, " ");
}

/**
 * Render an element subtree (or whole document) to structured plain text.
 * @param {object} root  turbo-dom Element or Document
 * @returns {string}
 */
export function text(root) {
  const node = root.querySelector ? (root.querySelector("body") ?? root) : root;
  const lines = [];
  let cur = "";

  const flush = () => {
    const t = cur.replace(/[ \t]+/g, " ").trim();
    if (t) lines.push(t);
    cur = "";
  };

  const walk = (el) => {
    if (el.nodeType === TEXT_NODE) {
      cur += collapse(el.textContent);
      return;
    }
    if (el.nodeType !== ELEMENT_NODE) return;
    const tag = el.tagName;
    if (SKIP.has(tag)) return;

    if (tag === "BR") {
      flush();
      return;
    }
    if (tag === "PRE") {
      flush();
      const code = (el.textContent ?? "").replace(/\s+$/, "");
      if (code) lines.push(code);
      return;
    }
    if (tag === "HR") {
      flush();
      return;
    }

    const block = BLOCK.has(tag);
    if (block) flush();

    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) walk(kids[i]);

    // Cells stay on their row's line, separated by a tab.
    if (tag === "TD" || tag === "TH") cur += "\t";
    if (block) flush();
  };

  walk(node);
  flush();
  return lines.join("\n");
}
