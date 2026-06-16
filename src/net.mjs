// Networking (SPEC §8). fetchHtml over Node's global fetch (undici under the
// hood — redirects + gzip/br/deflate decode for free), plus the hardening the
// spec calls for: charset sniffing, max body size, content-type gate, and an
// optional CookieJar round-trip.

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

// Read the body with a hard byte cap, streaming so we never buffer a huge response.
async function readCapped(res, maxBytes) {
  const len = Number(res.headers.get("content-length"));
  if (len && len > maxBytes) {
    throw new HttpError(`body exceeds maxBytes (${len} > ${maxBytes})`, "BODY_TOO_LARGE");
  }
  if (!res.body) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(`body exceeds maxBytes (> ${maxBytes})`, "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
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
 * @param {number} [opts.maxBytes]
 * @param {boolean} [opts.allowNonHtml]  skip the content-type gate
 * @param {typeof fetch} [opts.fetch]    injectable for tests / Lane B
 * @returns {Promise<{ html:string, finalUrl:string, status:number, headers:Headers }>}
 */
export async function fetchHtml(url, opts = {}) {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const headers = {
    "user-agent": DEFAULT_UA,
    accept: "text/html,application/xhtml+xml",
    ...opts.headers,
  };
  if (opts.jar) {
    const cookie = opts.jar.cookieHeader(url);
    if (cookie) headers.cookie = cookie;
  }

  const res = await doFetch(url, {
    method: opts.method ?? "GET",
    body: opts.body,
    redirect: "follow",
    signal: opts.signal,
    headers,
  });
  const finalUrl = res.url || url;

  if (opts.jar && typeof res.headers.getSetCookie === "function") {
    opts.jar.setFromResponse(finalUrl, res.headers.getSetCookie());
  }

  if (!opts.allowNonHtml && !isHtmlType(res.headers)) {
    throw new HttpError(`non-HTML content-type: ${res.headers.get("content-type")}`, "NOT_HTML");
  }

  const bytes = await readCapped(res, maxBytes);
  const html = decode(bytes, detectCharset(res.headers, bytes.subarray(0, 1024)));
  return { html, finalUrl, status: res.status, headers: res.headers };
}
