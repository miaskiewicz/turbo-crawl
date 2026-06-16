// Cascade-based visibility (SPEC §7.3). We cannot measure pixels; we approximate
// visibility from turbo-dom's real CSS cascade. Honest about being *declared*,
// not *rendered*, visibility.
//
//   not-visible if:
//     - self or any ancestor has display:none           (display does NOT inherit → walk up)
//     - computed visibility:hidden                       (inherits → self check suffices)
//     - hidden attribute, aria-hidden="true", or type="hidden"
//
// Hot-path note: the dominant cost is the first getComputedStyle() per element —
// turbo-dom resolves the full cascade (selector match + inherited props) on first
// touch, then memoizes it on Document.__version. We minimize that by (a) testing
// the cheap attribute signals first and short-circuiting before any cascade work,
// and (b) reading values via getPropertyValue() rather than the computed-style
// Proxy's property accessor, which avoids the per-read Proxy `get` trap.

/**
 * @param {object} el      turbo-dom Element
 * @param {object} window  turbo-dom window (for getComputedStyle)
 * @returns {boolean}
 */
// display:none does not inherit — walk the ancestor chain. Each gcs() is memoized
// per node on Document.__version, so shared ancestors resolve their cascade once.
function hasDisplayNoneAncestor(el, gcs) {
  let node = el;
  while (node && node.nodeType === 1) {
    if (gcs(node).getPropertyValue("display") === "none") return true;
    node = node.parentNode;
  }
  return false;
}

// <input type="hidden"> is never visible.
function isHiddenInput(el) {
  return el.tagName === "INPUT" && el.getAttribute("type")?.toLowerCase() === "hidden";
}

export function isVisible(el, window) {
  if (el.getAttribute("hidden") !== null) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (isHiddenInput(el)) return false;

  const gcs = window.getComputedStyle;

  // visibility inherits, so one read on the element reflects ancestor hidden too.
  if (gcs(el).getPropertyValue("visibility") === "hidden") return false;

  return !hasDisplayNoneAncestor(el, gcs);
}
