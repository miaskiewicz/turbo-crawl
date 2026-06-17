// Shared ARIA role + accessible-name helpers (used by extract, ax, and locator).
// Pragmatic, no-layout heuristics — enough for getByRole/getByText resolution and
// the agent view.

import { textOf } from "./dom-ops.mjs";

// Implicit ARIA role for common interactive/structural tags.
const IMPLICIT_ROLE = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
};

// Implicit role for <input> keyed by its `type` (default → textbox).
const INPUT_ROLE = {
  checkbox: "checkbox",
  radio: "radio",
  button: "button",
  submit: "button",
  reset: "button",
};

export function implicitRole(tag, type) {
  if (tag === "input") return INPUT_ROLE[type] ?? "textbox";
  return IMPLICIT_ROLE[tag] ?? "generic";
}

/** Resolved role: explicit `role` attribute, else the implicit tag/type role. */
export function roleOf(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  return implicitRole(el.tagName.toLowerCase(), el.getAttribute("type")?.toLowerCase());
}

// First trimmed, non-empty string produced by one of the candidate getters.
function firstNonEmpty(getters) {
  for (const get of getters) {
    const v = get();
    const t = v == null ? "" : v.trim();
    if (t) return t;
  }
  return "";
}

// Accessible name, cheap heuristic: aria-label > text > placeholder > value > title.
export function accessibleName(el) {
  return firstNonEmpty([
    () => el.getAttribute("aria-label"),
    () => el.textContent,
    () => el.getAttribute("placeholder"),
    () => el.getAttribute("value"),
    () => el.getAttribute("title"),
  ]);
}

// IDREF list of an attribute (e.g. aria-describedby="a b"), filtered to non-empty.
function idList(el, attr) {
  return (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean);
}

// Concatenated trimmed text of the referenced elements, space-joined.
function resolveIds(doc, ids) {
  const els = ids.map((id) => doc.getElementById(id)).filter(Boolean);
  return els
    .map((e) => textOf(e))
    .filter(Boolean)
    .join(" ");
}

// Accessible description: aria-describedby targets, else the `title` attribute.
export function accessibleDescription(el) {
  const ids = idList(el, "aria-describedby");
  if (ids.length) return resolveIds(el.ownerDocument, ids);
  return (el.getAttribute("title") ?? "").trim();
}

// Accessible error message: aria-errormessage targets, only when aria-invalid.
export function accessibleErrorMessage(el) {
  if (el.getAttribute("aria-invalid") !== "true") return "";
  return resolveIds(el.ownerDocument, idList(el, "aria-errormessage"));
}
