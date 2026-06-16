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

// Inline serialization: text + emphasis + links + code, no block breaks.
function inline(node, baseUrl) {
  if (node.nodeType === TEXT_NODE) return collapse(node.textContent ?? "");
  if (node.nodeType !== ELEMENT_NODE) return "";
  const tag = node.tagName;
  if (SKIP.has(tag)) return "";

  const inner = childrenInline(node, baseUrl);
  switch (tag) {
    case "A": {
      const href = resolve(baseUrl, node.getAttribute("href"));
      return href ? `[${inner}](${href})` : inner;
    }
    case "STRONG":
    case "B":
      return inner.trim() ? `**${inner}**` : "";
    case "EM":
    case "I":
      return inner.trim() ? `*${inner}*` : "";
    case "CODE":
      return inner.trim() ? `\`${inner}\`` : "";
    case "BR":
      return "\n";
    default:
      return inner;
  }
}

function childrenInline(node, baseUrl) {
  const kids = node.childNodes;
  let out = "";
  for (let i = 0; i < kids.length; i++) out += inline(kids[i], baseUrl);
  return out;
}

// Block serialization: emit paragraph/heading/list/quote/code/table blocks.
function block(node, baseUrl, out) {
  if (node.nodeType === TEXT_NODE) {
    const t = collapse(node.textContent ?? "").trim();
    if (t) out.push(t);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  const tag = node.tagName;
  if (SKIP.has(tag)) return;

  if (HEADINGS[tag]) {
    const text = childrenInline(node, baseUrl).trim();
    if (text) out.push(`${HEADINGS[tag]} ${text}`);
    return;
  }
  switch (tag) {
    case "P":
    case "BLOCKQUOTE": {
      const text = childrenInline(node, baseUrl).trim();
      if (text) out.push(tag === "BLOCKQUOTE" ? `> ${text}` : text);
      return;
    }
    case "PRE": {
      const code = (node.textContent ?? "").replace(/\n+$/, "");
      if (code.trim()) out.push("```\n" + code + "\n```");
      return;
    }
    case "UL":
    case "OL": {
      emitList(node, baseUrl, out, tag === "OL");
      return;
    }
    case "HR":
      out.push("---");
      return;
    default: {
      // Container: recurse into children for nested block content.
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) block(kids[i], baseUrl, out);
    }
  }
}

function emitList(listNode, baseUrl, out, ordered) {
  const items = listNode.querySelectorAll("li");
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    // Only direct-child <li> of this list.
    if (items[i].parentNode !== listNode) continue;
    const text = childrenInline(items[i], baseUrl).trim();
    if (text) lines.push(`${ordered ? `${lines.length + 1}.` : "-"} ${text}`);
  }
  if (lines.length) out.push(lines.join("\n"));
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
