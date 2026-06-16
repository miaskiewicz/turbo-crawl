// Accessibility tree (SPEC §7.2): a compact, structural view for agent reasoning,
// computed from semantics + ARIA. Nested { role, name, value?, children }.
// Geometry-free; presentational/skipped subtrees are pruned.

const ELEMENT_NODE = 1;

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);

// Implicit ARIA roles for the structural/interactive tags we surface.
const IMPLICIT = {
  A: "link",
  BUTTON: "button",
  NAV: "navigation",
  MAIN: "main",
  HEADER: "banner",
  FOOTER: "contentinfo",
  ASIDE: "complementary",
  UL: "list",
  OL: "list",
  LI: "listitem",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  IMG: "img",
  SELECT: "combobox",
  TEXTAREA: "textbox",
  FORM: "form",
  TABLE: "table",
  P: "paragraph",
  SECTION: "region",
  ARTICLE: "article",
};

// Implicit ARIA role for <input> keyed by `type`. `hidden` is an explicit null
// (skipped from the tree); any other/unknown type falls back to "textbox".
const INPUT_ROLE = {
  checkbox: "checkbox",
  radio: "radio",
  button: "button",
  submit: "button",
  reset: "button",
  hidden: null,
};

function inputRole(type) {
  return type in INPUT_ROLE ? INPUT_ROLE[type] : "textbox";
}

function roleOf(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName;
  if (tag === "INPUT") return inputRole(el.getAttribute("type")?.toLowerCase());
  return IMPLICIT[tag] ?? null;
}

// Accessible name: aria-label > alt (img) > direct text, collapsed.
function nameOf(el) {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  if (el.tagName === "IMG") return (el.getAttribute("alt") ?? "").trim();
  const text = el.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

// Tags whose `.value` we surface in the tree.
const VALUE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEmpty(v) {
  return v == null || v === "";
}

function valueOf(el) {
  if (!VALUE_TAGS.has(el.tagName)) return undefined;
  const v = el.value;
  return isEmpty(v) ? undefined : String(v);
}

function isSkipped(el) {
  if (el.nodeType !== ELEMENT_NODE) return true;
  if (SKIP.has(el.tagName)) return true;
  return el.getAttribute("aria-hidden") === "true";
}

// Recurse over element children, keeping only the non-null built subtrees.
function buildChildren(el) {
  const children = [];
  const kids = el.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    const node = build(kids[i]);
    if (node) children.push(node);
  }
  return children;
}

// Prune structurally-uninteresting wrappers: no role and no own contribution,
// collapse to their children so the tree stays compact.
function pruneRoleless(children) {
  if (children.length === 1) return children[0];
  if (children.length === 0) return null;
  return { role: "generic", children };
}

function nodeFor(el, role, children) {
  const node = { role, name: nameOf(el) };
  const value = valueOf(el);
  if (value !== undefined) node.value = value;
  if (children.length) node.children = children;
  return node;
}

function build(el) {
  if (isSkipped(el)) return null;
  const role = roleOf(el);
  const children = buildChildren(el);
  if (!role) return pruneRoleless(children);
  return nodeFor(el, role, children);
}

/**
 * @param {object} document  turbo-dom Document
 * @returns {{ role:string, name?:string, value?:string, children?:object[] }}
 */
export function accessibilityTree(document) {
  const body = document.querySelector("body") ?? document.documentElement;
  const tree = build(body);
  return tree ?? { role: "document", children: [] };
}
