// Unified node-query interface (SPEC addition): query the page by CSS selector OR
// XPath and get back the matched subtree(s) as { node, html, text }.
//
//   CSS   → turbo-dom's native querySelectorAll (standard CSS; Sizzle is mostly
//           CSS3, so common selectors work. Sizzle-only extensions like :contains
//           are NOT supported by turbo-dom — use the XPath text() predicate).
//   XPath → src/xpath.mjs subset (//, /, predicates, contains(), text(), @attr).
//
// `type: "auto"` (default) treats a selector starting with `/`, `./`, or `(` as
// XPath, else CSS.

import { evaluateXPath } from "./xpath.mjs";
import { text as nodeText } from "./text.mjs";

function looksLikeXPath(selector) {
  return /^\s*[(/]/.test(selector) || selector.startsWith("./");
}

function resolveType(selector, type) {
  if (type === "css" || type === "xpath") return type;
  return looksLikeXPath(selector) ? "xpath" : "css";
}

// Serialize one element to the result shape: live node + outerHTML + plain text.
function describe(node) {
  return { node, html: node.outerHTML ?? "", text: nodeText(node) };
}

function cssNodes(root, selector) {
  return [...root.querySelectorAll(selector)];
}

// XPath may yield attribute strings (trailing @attr) instead of nodes.
function xpathResults(root, selector) {
  const r = evaluateXPath(root, selector);
  if (r.values) return r.values.map((value) => ({ node: null, html: null, text: value, value }));
  return r.nodes.map(describe);
}

/**
 * Query the document for nodes by CSS or XPath.
 * @param {object} root      turbo-dom Document or Element to search within
 * @param {string} selector  a CSS selector or XPath expression
 * @param {object} [opts]
 * @param {"auto"|"css"|"xpath"} [opts.type="auto"]
 * @param {boolean} [opts.first=false]  return only the first match (or null)
 * @returns {Array<{node,html,text}> | {node,html,text} | null}
 */
export function query(root, selector, opts = {}) {
  const kind = resolveType(selector, opts.type ?? "auto");
  const results =
    kind === "xpath" ? xpathResults(root, selector) : cssNodes(root, selector).map(describe);
  return opts.first ? (results[0] ?? null) : results;
}
