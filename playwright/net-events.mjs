// Playwright-shaped Request / Response / ConsoleMessage objects, built from the
// raw records the render tier emits (src/render/page-fetch.mjs + render/index.mjs).
// These back the `request`/`response`/`console` events and the goto() return.

function headerObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function") return Object.fromEntries(headers.entries());
  return headers;
}

export class PWRequest {
  #r;
  constructor(raw) {
    this.#r = raw;
  }
  url() {
    return this.#r.url;
  }
  method() {
    return this.#r.method ?? "GET";
  }
  headers() {
    return headerObject(this.#r.headers);
  }
  postData() {
    return this.#r.postData ?? null;
  }
  resourceType() {
    return this.#r.resourceType ?? "other";
  }
}

export class PWResponse {
  #r;
  constructor(raw) {
    this.#r = raw;
  }
  url() {
    return this.#r.url;
  }
  status() {
    return this.#r.status;
  }
  ok() {
    return this.#r.status >= 200 && this.#r.status < 300;
  }
  headers() {
    return headerObject(this.#r.headers);
  }
  request() {
    return this.#r.request ? new PWRequest(this.#r.request) : null;
  }
  async text() {
    return this.#r.body ?? "";
  }
  async json() {
    return JSON.parse(this.#r.body ?? "null");
  }
}

export class PWConsoleMessage {
  #type;
  #args;
  constructor(type, args) {
    this.#type = type;
    this.#args = args ?? [];
  }
  type() {
    return this.#type;
  }
  text() {
    return this.#args.map(String).join(" ");
  }
  args() {
    return this.#args;
  }
}

// Glob → RegExp: Playwright URL globs use `**` (any) and `*` (any non-slash).
function globToRegExp(glob) {
  const body = glob
    .split("**")
    .map((seg) => seg.split("*").map(escapeRe).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

// Normalize a Playwright url-or-predicate matcher into `(url) => boolean`.
export function urlMatcher(pattern) {
  if (typeof pattern === "function") return pattern;
  if (pattern instanceof RegExp) return (url) => pattern.test(url);
  const re = globToRegExp(String(pattern));
  return (url) => re.test(url);
}

// The raw request record for a top-level navigation (Lane-A wrapper + goto).
export function documentRequest(url, opts = {}) {
  return {
    url,
    method: (opts.method ?? "GET").toUpperCase(),
    headers: opts.headers ?? {},
    postData: opts.body ?? null,
    resourceType: "document",
  };
}

// Emit a host-net result (shape `{ status, html, headers }`) as response events.
export function emitNetResponse(netHooks, req, res, url) {
  netHooks.onResponse?.({
    url,
    status: res.status,
    headers: res.headers,
    body: res.html ?? "",
    request: req,
  });
  netHooks.onRequestFinished?.(req);
}
