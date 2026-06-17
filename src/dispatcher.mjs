// Cheaper network phase (SPEC §8). An explicit undici Agent gives us two wins the
// default global-fetch dispatcher doesn't:
//   • HTTP/2 (allowH2) — multiplex many same-host requests over one connection,
//     so a paginated/same-host crawl pays one handshake instead of N.
//   • A TTL DNS cache (connect.lookup) — a many-host crawl resolves each host
//     once per ttl instead of on every connection.
// Brotli needs nothing here: Node's global fetch already advertises
// `accept-encoding: gzip, deflate, br` and transparently decodes the response —
// so long as net.mjs never sets accept-encoding itself (it doesn't).
//
// Opt-in: pass `createDispatcher()` as the `dispatcher` option to fetchHtml / Page
// / Crawler. Tests inject a fake `base` lookup + `now` clock, so this stays
// network-free and deterministic.

import { lookup as nodeLookup } from "node:dns";
import { Agent } from "undici";

// dns.lookup is called as (hostname, options?, callback). Normalize the optional
// options arg so the cache key and the base call see a consistent shape.
function normalizeArgs(options, callback) {
  if (typeof options === "function") return { opts: {}, cb: options };
  return { opts: options ?? {}, cb: callback };
}

// Cache key: same host can be asked for a specific family or all addresses; key
// on both so we never replay the wrong answer shape back to the caller.
function lookupKey(hostname, opts) {
  return `${hostname}|${opts.family ?? 0}|${opts.all ? 1 : 0}`;
}

/**
 * A dns.lookup-compatible function with a per-host TTL cache. Caches the exact
 * (successful) callback arguments and replays them until ttl expires, so it's
 * faithful to the contract regardless of the `all`/`family` options undici uses.
 *
 * @param {object} [o]
 * @param {number} [o.ttlMs]  cache lifetime (default 60s)
 * @param {() => number} [o.now]   clock (injectable for tests)
 * @param {typeof nodeLookup} [o.base]  underlying lookup (injectable for tests)
 */
export function cachedLookup({ ttlMs = 60_000, now = Date.now, base = nodeLookup } = {}) {
  const cache = new Map();
  return (hostname, options, callback) => {
    const { opts, cb } = normalizeArgs(options, callback);
    const key = lookupKey(hostname, opts);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return cb(...hit.args);
    base(hostname, opts, (...args) => {
      if (!args[0]) cache.set(key, { args, expires: now() + ttlMs });
      cb(...args);
    });
  };
}

/**
 * An undici Agent with HTTP/2 + a DNS cache, for use as a fetch `dispatcher`.
 *
 * @param {object} [o]
 * @param {boolean} [o.allowH2]   negotiate HTTP/2 (default true)
 * @param {number} [o.dnsTtlMs]   DNS cache TTL (default 60s)
 */
export function createDispatcher({ allowH2 = true, dnsTtlMs = 60_000 } = {}) {
  return new Agent({ allowH2, connect: { lookup: cachedLookup({ ttlMs: dnsTtlMs }) } });
}
