// Markdown view of main content (SPEC §7.2) for RAG / summarization context.
// A DOM walk, not a renderer. Boilerplate (script/style/nav/footer/aside) is
// dropped via simple heuristics. Open question §15.2: heuristic vs readability —
// start heuristic, measure.

import { resolve } from "./url.mjs";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "NAV", "FOOTER", "ASIDE"]);
const HEADINGS = { H1: "#", H2: "##", H3: "###", H4: "####", H5: "#####", H6: "######" };

function collapse(s) {
  return s.replace(/\s+/g, " ");
}

function wrap(marker) {
  return (inner) => (inner.trim() ? `${marker}${inner}${marker}` : "");
}

// Per-tag inline serializers. Each is its own small function (own cc budget).
const INLINE_TAGS = {
  A(node, baseUrl, inner) {
    const href = resolve(baseUrl, node.getAttribute("href"));
    return href ? `[${inner}](${href})` : inner;
  },
  STRONG: (_node, _baseUrl, inner) => wrap("**")(inner),
  B: (_node, _baseUrl, inner) => wrap("**")(inner),
  EM: (_node, _baseUrl, inner) => wrap("*")(inner),
  I: (_node, _baseUrl, inner) => wrap("*")(inner),
  CODE: (_node, _baseUrl, inner) => wrap("`")(inner),
  BR: () => "\n",
};

function inlineText(node) {
  return collapse(node.textContent ?? "");
}

// Inline serialization: text + emphasis + links + code, no block breaks.
function inline(node, baseUrl) {
  if (node.nodeType === TEXT_NODE) return inlineText(node);
  if (node.nodeType !== ELEMENT_NODE) return "";
  const tag = node.tagName;
  if (SKIP.has(tag)) return "";

  const inner = childrenInline(node, baseUrl);
  const handler = INLINE_TAGS[tag] || passthrough;
  return handler(node, baseUrl, inner);
}

function passthrough(_node, _baseUrl, inner) {
  return inner;
}

function childrenInline(node, baseUrl) {
  const kids = node.childNodes;
  let out = "";
  for (let i = 0; i < kids.length; i++) out += inline(kids[i], baseUrl);
  return out;
}

function blockText(node, baseUrl, out) {
  const t = collapse(node.textContent ?? "").trim();
  if (t) out.push(t);
}

function blockHeading(node, baseUrl, out, tag) {
  const text = childrenInline(node, baseUrl).trim();
  if (text) out.push(`${HEADINGS[tag]} ${text}`);
}

// Per-tag block serializers. Each is its own small function (own cc budget).
const BLOCK_TAGS = {
  P(node, baseUrl, out) {
    const text = childrenInline(node, baseUrl).trim();
    if (text) out.push(text);
  },
  BLOCKQUOTE(node, baseUrl, out) {
    const text = childrenInline(node, baseUrl).trim();
    if (text) out.push(`> ${text}`);
  },
  PRE(node, _baseUrl, out) {
    const code = (node.textContent ?? "").replace(/\n+$/, "");
    if (code.trim()) out.push("```\n" + code + "\n```");
  },
  UL(node, baseUrl, out) {
    emitList(node, baseUrl, out, false);
  },
  OL(node, baseUrl, out) {
    emitList(node, baseUrl, out, true);
  },
  HR(_node, _baseUrl, out) {
    out.push("---");
  },
  TABLE(node, baseUrl, out) {
    emitTable(node, baseUrl, out);
  },
};

// One table row's cells as trimmed, pipe-escaped inline text.
function rowCells(tr, baseUrl) {
  const cells = tr.querySelectorAll("th,td");
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    out.push(childrenInline(cells[i], baseUrl).trim().replace(/\|/g, "\\|"));
  }
  return out;
}

// Append a row as a Markdown table line; after the first row, add the header rule.
function appendRow(tr, baseUrl, lines) {
  const cells = rowCells(tr, baseUrl);
  if (!cells.length) return;
  lines.push(`| ${cells.join(" | ")} |`);
  if (lines.length === 1) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
}

// GitHub-flavored Markdown table (first <tr> treated as the header row).
function emitTable(node, baseUrl, out) {
  const rows = node.querySelectorAll("tr");
  const lines = [];
  for (let i = 0; i < rows.length; i++) appendRow(rows[i], baseUrl, lines);
  if (lines.length) out.push(lines.join("\n"));
}

function blockContainer(node, baseUrl, out) {
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i++) block(kids[i], baseUrl, out);
}

// Resolve the serializer for an element tag (heading > tag table > container).
function blockHandlerFor(tag) {
  return HEADINGS[tag] ? blockHeading : BLOCK_TAGS[tag] || blockContainer;
}

// Block serialization: emit paragraph/heading/list/quote/code/table blocks.
function block(node, baseUrl, out) {
  if (node.nodeType === TEXT_NODE) return blockText(node, baseUrl, out);
  if (node.nodeType !== ELEMENT_NODE) return;
  const tag = node.tagName;
  if (SKIP.has(tag)) return;
  blockHandlerFor(tag)(node, baseUrl, out, tag);
}

function emitList(listNode, baseUrl, out, ordered) {
  const items = listNode.querySelectorAll("li");
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    appendListItem(items[i], listNode, baseUrl, lines, ordered);
  }
  if (lines.length) out.push(lines.join("\n"));
}

function appendListItem(item, listNode, baseUrl, lines, ordered) {
  // Only direct-child <li> of this list.
  if (item.parentNode !== listNode) return;
  const text = childrenInline(item, baseUrl).trim();
  if (text) lines.push(`${ordered ? `${lines.length + 1}.` : "-"} ${text}`);
}

/**
 * Render the document's main content to Markdown.
 * @param {object} document  turbo-dom Document
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function markdown(document, baseUrl) {
  const root = document.querySelector("main") || document.querySelector("body") || document;
  const out = [];
  const kids = root.childNodes ?? [];
  for (let i = 0; i < kids.length; i++) block(kids[i], baseUrl, out);
  return out.join("\n\n").trim();
}
