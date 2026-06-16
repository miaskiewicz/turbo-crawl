// Structured extraction (SPEC §7.4). `extractSchema(document, schema)` reads a
// typed object out of the page over turbo-dom's cached selector engine — the
// "give me name, price, rating" path that skips the click dance.
//
// Schema shape (JSON-Schema-ish, selector-bound):
//   { field: { selector, attr?, type?, list?, fields?, transform? } }
//     selector : CSS selector (required unless reading the root)
//     attr     : 'text' (default) | 'html' | <attribute name> (href/src → absolute)
//     type     : 'string' (default) | 'number' | 'boolean'
//     list     : true → array of all matches
//     fields   : nested schema; with `list`, each `selector` match is one object
//     transform: (value) => value, applied last

import { resolve } from "./url.mjs";

const URL_ATTRS = new Set(["href", "src", "action", "poster", "data-src"]);

function coerce(value, type) {
  if (value == null) return value;
  if (type === "number") {
    const n = Number(String(value).replace(/[^0-9.+-]/g, ""));
    return Number.isNaN(n) ? null : n;
  }
  if (type === "boolean") return Boolean(value);
  return value;
}

// Per-`attr` raw-value readers. `text`/`html` are direct; anything else reads an
// attribute (url-bearing attrs are absolutized in readNode).
const ATTR_READERS = {
  text: (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  html: (el) => el.innerHTML ?? "",
};

function readAttr(el, attr, baseUrl) {
  const raw = el.getAttribute(attr);
  if (raw != null && URL_ATTRS.has(attr)) return resolve(baseUrl, raw) ?? raw;
  return raw;
}

function readNode(el, spec, baseUrl) {
  const attr = spec.attr ?? "text";
  const reader = ATTR_READERS[attr];
  const raw = reader ? reader(el) : readAttr(el, attr, baseUrl);
  return coerce(raw, spec.type);
}

// Nested object list: each selector match → an object of sub-fields.
function extractObjectList(root, spec, baseUrl) {
  const items = spec.selector ? root.querySelectorAll(spec.selector) : [root];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    out.push(extractObject(items[i], spec.fields, baseUrl));
  }
  return apply(spec, out);
}

// Nested single object (relative selectors against the matched container).
function extractNestedObject(root, spec, baseUrl) {
  const container = spec.selector ? root.querySelector(spec.selector) : root;
  return apply(spec, container ? extractObject(container, spec.fields, baseUrl) : null);
}

// Scalar list.
function extractScalarList(root, spec, baseUrl) {
  const nodes = root.querySelectorAll(spec.selector);
  const out = [];
  for (let i = 0; i < nodes.length; i++) out.push(readNode(nodes[i], spec, baseUrl));
  return apply(spec, out);
}

// Single scalar.
function extractScalar(root, spec, baseUrl) {
  const el = spec.selector ? root.querySelector(spec.selector) : root;
  return apply(spec, el ? readNode(el, spec, baseUrl) : null);
}

function extractField(root, spec, baseUrl) {
  if (spec.fields) {
    return spec.list
      ? extractObjectList(root, spec, baseUrl)
      : extractNestedObject(root, spec, baseUrl);
  }
  return spec.list ? extractScalarList(root, spec, baseUrl) : extractScalar(root, spec, baseUrl);
}

function apply(spec, value) {
  return typeof spec.transform === "function" ? spec.transform(value) : value;
}

function extractObject(root, fields, baseUrl) {
  const obj = {};
  for (const key of Object.keys(fields)) {
    obj[key] = extractField(root, fields[key], baseUrl);
  }
  return obj;
}

/**
 * @param {object} document  turbo-dom Document
 * @param {object} schema    field → spec (see header)
 * @param {string} [baseUrl] for resolving href/src
 * @returns {object}
 */
export function extractSchema(document, schema, baseUrl) {
  const fields = schema.fields ?? schema;
  return extractObject(document, fields, baseUrl);
}
