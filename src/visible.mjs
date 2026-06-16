// Cascade-based visibility (SPEC §7.3). We cannot measure pixels; we approximate
// visibility from turbo-dom's real CSS cascade. Honest about being *declared*,
// not *rendered*, visibility.
//
//   not-visible if:
//     - self or any ancestor has display:none           (display does NOT inherit → walk up)
//     - computed visibility:hidden                       (inherits → self check suffices)
//     - hidden attribute, aria-hidden="true", or type="hidden"

/**
 * @param {object} el      turbo-dom Element
 * @param {object} window  turbo-dom window (for getComputedStyle)
 * @returns {boolean}
 */
export function isVisible(el, window) {
  if (el.getAttribute("hidden") !== null) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.tagName === "INPUT" && el.getAttribute("type")?.toLowerCase() === "hidden") {
    return false;
  }

  // visibility inherits, so one read on the element reflects ancestor hidden too.
  if (window.getComputedStyle(el).visibility === "hidden") return false;

  // display:none does not inherit — walk the ancestor chain.
  let node = el;
  while (node && node.nodeType === 1) {
    if (window.getComputedStyle(node).display === "none") return false;
    node = node.parentNode;
  }
  return true;
}
