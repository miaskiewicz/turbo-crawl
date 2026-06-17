// Shared ARIA role + accessible-name helpers (used by extract, ax, and locator).
// Pragmatic, no-layout heuristics — enough for getByRole/getByText resolution and
// the agent view.

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
