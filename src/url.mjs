// URL helpers. Phase 0: resolve(base, href). Canonicalization lands in Phase 3.

/**
 * Resolve a possibly-relative href against a base URL.
 * Returns an absolute URL string, or null if it cannot be resolved
 * (e.g. `javascript:`/`mailto:` are kept verbatim only when absolute).
 */
export function resolve(base, href) {
  if (typeof href !== "string" || href.length === 0) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// Tracking/query params stripped during canonicalization (dedupe noise).
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
]);

/**
 * Canonical form of a URL for dedupe (SPEC §9): lowercase host, drop fragment,
 * strip known tracking params, sort the remaining query, drop a default port and
 * a trailing-slash-only path difference.
 * @returns {string|null}
 */
export function canonicalize(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const kept = [];
  for (const [k, v] of u.searchParams) {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  u.search = new URLSearchParams(kept).toString();
  if (u.pathname === "") u.pathname = "/";
  return u.href;
}

/** True if `url` is an http(s) URL we are willing to navigate to. */
export function isHttpUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
