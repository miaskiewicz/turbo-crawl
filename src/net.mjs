// Networking (SPEC §8). fetchHtml over undici's fetch (redirects + gzip/br/deflate
// decode for free), plus the hardening the spec calls for: charset sniffing, max
// body size, content-type gate, and an optional CookieJar round-trip. We use the
// undici package's own fetch (not Node's global) so it pairs with the undici
// Agent we pass as a `dispatcher` for HTTP/2 — mixing the two undici builds
// throws "invalid onRequestStart method".

import { fetch as undiciFetch } from "undici";

const DEFAULT_UA = "turbo-crawl/0.0 (+https://github.com/miaskiewicz/turbo-crawl)";
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const HTML_TYPES = ["text/html", "application/xhtml+xml", "application/xml", "text/xml"];

export class HttpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "HttpError";
    this.code = code;
  }
}

// charset: Content-Type header → <meta charset> sniff over the first bytes → utf-8.
function detectCharset(headers, head) {
  const ct = headers.get("content-type") ?? "";
  const m = /charset=([^;]+)/i.exec(ct);
  if (m) return m[1].trim().replace(/["']/g, "").toLowerCase();
  const ascii = new TextDecoder("latin1").decode(head);
  const meta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii) ||
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(ascii);
  return meta ? meta[1].toLowerCase() : "utf-8";
}

function isHtmlType(headers) {
  const ct = (headers.get("content-type") ?? "").toLowerCase();
  if (!ct) return true; // be permissive when the server omits it
  return HTML_TYPES.some((t) => ct.includes(t));
}

// Reject up-front when the declared content-length already blows the cap.
function checkContentLength(res, maxBytes) {
  const len = Number(res.headers.get("content-length"));
  if (len && len > maxBytes) {
    throw new HttpError(`body exceeds maxBytes (${len} > ${maxBytes})`, "BODY_TOO_LARGE");
  }
}

// Flatten accumulated chunks into one contiguous Uint8Array.
function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Stream the body, enforcing the cap as bytes arrive.
async function accumulate(body, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(`body exceeds maxBytes (> ${maxBytes})`, "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  return concatChunks(chunks, total);
}

// Read the body with a hard byte cap, streaming so we never buffer a huge response.
async function readCapped(res, maxBytes) {
  checkContentLength(res, maxBytes);
  if (!res.body) return new Uint8Array(0);
  return accumulate(res.body, maxBytes);
}

function decode(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // unknown label → utf-8
  }
}

/**
 * Fetch a URL and return its decoded HTML plus response metadata.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {string} [opts.method]
 * @param {string} [opts.body]
 * @param {AbortSignal} [opts.signal]
 * @param {import('./cookies.mjs').CookieJar} [opts.jar]  request/response cookie round-trip
 * @param {object} [opts.cache]      ResponseCache for conditional (304) revalidation
 * @param {object} [opts.dispatcher] undici Agent (HTTP/2 + DNS cache) as the fetch dispatcher
 * @param {number} [opts.maxBytes]
 * @param {boolean} [opts.allowNonHtml]  skip the content-type gate
 * @param {typeof fetch} [opts.fetch]    injectable for tests / Lane B
 * @returns {Promise<{ html:string, finalUrl:string, status:number, headers:Headers }>}
 */
// Build the request headers: UA/accept defaults, caller overrides, jar cookie,
// and conditional-request validators (If-None-Match / If-Modified-Since).
function buildHeaders(url, opts) {
  const headers = {
    "user-agent": DEFAULT_UA,
    accept: "text/html,application/xhtml+xml",
    ...opts.headers,
  };
  if (opts.jar) {
    const cookie = opts.jar.cookieHeader(url);
    if (cookie) headers.cookie = cookie;
  }
  if (opts.cache) Object.assign(headers, opts.cache.validators(url));
  return headers;
}

// Feed any Set-Cookie headers from the response back into the jar.
function ingestSetCookie(opts, res, finalUrl) {
  if (opts.jar && typeof res.headers.getSetCookie === "function") {
    opts.jar.setFromResponse(finalUrl, res.headers.getSetCookie());
  }
}

// Enforce the HTML content-type gate unless the caller opted out.
function gateHtmlType(opts, res) {
  if (!opts.allowNonHtml && !isHtmlType(res.headers)) {
    throw new HttpError(`non-HTML content-type: ${res.headers.get("content-type")}`, "NOT_HTML");
  }
}

// Read + charset-decode the body into the final HTML string.
async function decodeBody(res, maxBytes) {
  const bytes = await readCapped(res, maxBytes);
  return decode(bytes, detectCharset(res.headers, bytes.subarray(0, 1024)));
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function redirectLocation(res) {
  return REDIRECT_STATUS.has(res.status) ? res.headers.get("location") : null;
}

// Method after a redirect: 303 (and 301/302 on POST) become GET; 307/308 keep it.
function nextMethod(status, method) {
  if (status === 303) return "GET";
  if ((status === 301 || status === 302) && method === "POST") return "GET";
  return method;
}

// Compute the next hop's state after a redirect (URL + rewritten method/body).
function advanceHop(state, res, loc) {
  const method = nextMethod(res.status, state.method);
  return {
    current: new URL(loc, state.current).href,
    method,
    body: method === state.method ? state.body : undefined,
  };
}

// One request in the manual-follow loop: returns { done } at a terminal response
// (or the cap) else { next } with the following hop's state.
async function redirectHop(doFetch, state, opts, redirects, maxRedirects) {
  const headers = buildHeaders(state.current, { ...opts, method: state.method });
  const res = await doFetch(state.current, {
    method: state.method,
    body: state.body,
    redirect: "manual",
    signal: opts.signal,
    headers,
    dispatcher: opts.dispatcher,
  });
  ingestSetCookie(opts, res, res.url || state.current);
  const loc = redirectLocation(res);
  if (!loc || redirects >= maxRedirects) {
    return { done: { res, finalUrl: res.url || state.current, redirected: redirects > 0 } };
  }
  return { next: advanceHop(state, res, loc) };
}

// Manual redirect following with a hard hop cap (opts.maxRedirects). Re-derives
// the Cookie header + Set-Cookie ingest per hop and rewrites method/body per the
// fetch spec. Used only when the caller sets maxRedirects.
async function followManually(doFetch, url, opts, maxRedirects) {
  let state = { current: url, method: opts.method ?? "GET", body: opts.body };
  for (let redirects = 0; ; redirects++) {
    const step = await redirectHop(doFetch, state, opts, redirects, maxRedirects);
    if (step.done) return step.done;
    state = step.next;
  }
}

// Single fetch delegating redirects to undici (default: cap 20).
async function followAuto(doFetch, url, opts) {
  const res = await doFetch(url, {
    method: opts.method ?? "GET",
    body: opts.body,
    redirect: "follow",
    signal: opts.signal,
    headers: buildHeaders(url, opts),
    dispatcher: opts.dispatcher,
  });
  const finalUrl = res.url || url;
  ingestSetCookie(opts, res, finalUrl);
  return { res, finalUrl, redirected: !!res.redirected };
}

// 304 Not Modified → reuse the cached body (the server sent no body).
function notModified(res, finalUrl, redirected, opts) {
  return {
    html: opts.cache.body(finalUrl),
    finalUrl,
    status: 304,
    headers: res.headers,
    redirected,
    notModified: true,
  };
}

// Turn a settled response into the FetchResult: short-circuit 304s, else gate +
// decode and (when caching) record the validators/body for next time.
async function finishFetch(res, finalUrl, redirected, opts, maxBytes) {
  if (opts.cache && res.status === 304) return notModified(res, finalUrl, redirected, opts);
  gateHtmlType(opts, res);
  const html = await decodeBody(res, maxBytes);
  if (opts.cache) opts.cache.store(finalUrl, res.headers, html, res.status);
  return { html, finalUrl, status: res.status, headers: res.headers, redirected };
}

export async function fetchHtml(url, opts = {}) {
  const doFetch = opts.fetch ?? undiciFetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const { res, finalUrl, redirected } =
    opts.maxRedirects != null
      ? await followManually(doFetch, url, opts, opts.maxRedirects)
      : await followAuto(doFetch, url, opts);

  return finishFetch(res, finalUrl, redirected, opts, maxBytes);
}
