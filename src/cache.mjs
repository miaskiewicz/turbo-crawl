// Conditional-request cache (HTTP revalidation). Stores per-URL validators
// (ETag / Last-Modified) + the body; on a recrawl, fetchHtml sends
// If-None-Match / If-Modified-Since and the server can answer 304 Not Modified
// with NO body — the cached body is reused. Recrawls of unchanged pages get
// ~free. Persist/share one instance across Page/Crawler runs to benefit.

export class ResponseCache {
  // url → { etag, lastModified, html, status }
  #store = new Map();

  /** Conditional request headers for `url` (empty if nothing cached). */
  validators(url) {
    const e = this.#store.get(url);
    if (!e) return {};
    const headers = {};
    if (e.etag) headers["if-none-match"] = e.etag;
    if (e.lastModified) headers["if-modified-since"] = e.lastModified;
    return headers;
  }

  /** Record a 200 response's validators + body (only if it carries a validator). */
  store(url, headers, html, status) {
    const etag = headers.get("etag");
    const lastModified = headers.get("last-modified");
    if (etag || lastModified) this.#store.set(url, { etag, lastModified, html, status });
  }

  /** Cached body for `url` (used on a 304), or "". */
  body(url) {
    return this.#store.get(url)?.html ?? "";
  }

  /** Number of cached entries. */
  get size() {
    return this.#store.size;
  }
}
