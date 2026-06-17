// BrowserContext state for the Playwright façade: the persistent surface a real
// Playwright context carries across pages/navigations — a cookie jar, per-origin
// Web Storage, registered init scripts, request routes, and extra HTTP headers.
// Pages built in the same context SHARE this, so a login on one navigation is
// still in effect on the next (the PropelAuth-style auth-reuse Playwright relies
// on via `storageState`).

import { CookieJar } from "../src/cookies.mjs";
import { urlMatcher } from "./net-events.mjs";
import { makeStorage, storageEntries } from "./storage.mjs";

const originOf = (url) => new URL(url).origin;

// A registered route's body resolution (fulfill supports `body` or `json`).
function fulfillBody(opts) {
  if (opts.json !== undefined) return JSON.stringify(opts.json);
  return opts.body ?? "";
}

// Playwright Route handed to a route() handler: fulfill (mock) / abort / continue.
class Route {
  #result = null;
  constructor(rawReq, makeRequest) {
    this.request = () => makeRequest(rawReq);
  }
  async fulfill(opts = {}) {
    this.#result = { status: opts.status ?? 200, body: fulfillBody(opts), headers: opts.headers };
  }
  async abort() {
    this.#result = "abort";
  }
  async continue() {
    this.#result = null; // proceed to the host network
  }
  result() {
    return this.#result;
  }
}

// Run the first matching route. Returns null (continue → network) | mock | "abort".
export async function runRoutes(routes, rawReq, makeRequest) {
  for (const r of routes) {
    if (!r.match(rawReq.url)) continue;
    const route = new Route(rawReq, makeRequest);
    await r.handler(route, route.request());
    return route.result();
  }
  return null;
}

// Remove routes matching `pattern` (and `handler`, when given).
function keepRoute(r, pattern, handler) {
  if (r.pattern !== pattern) return true;
  return handler ? r.handler !== handler : false;
}

// CookieJar record → Playwright cookie (expiry epoch-seconds; -1 = session).
function toPWCookie(rec) {
  const expires = rec.expiresAt === Infinity ? -1 : Math.floor(rec.expiresAt / 1000);
  const { name, value, domain, path, secure, httpOnly, sameSite } = rec;
  return { name, value, domain, path, expires, httpOnly: !!httpOnly, secure: !!secure, sameSite };
}

export class ContextState {
  jar = new CookieJar();
  initScripts = [];
  routes = [];
  extraHeaders = {};
  #origins = new Map();

  constructor(storageState) {
    this.load(storageState);
  }

  storageFor(url) {
    const origin = originOf(url);
    let s = this.#origins.get(origin);
    if (!s) {
      s = { localStorage: makeStorage(), sessionStorage: makeStorage() };
      this.#origins.set(origin, s);
    }
    return s;
  }

  addInitScript(code) {
    this.initScripts.push(code);
  }
  setExtraHTTPHeaders(headers) {
    this.extraHeaders = { ...headers };
  }
  route(pattern, handler) {
    this.routes.unshift({ match: urlMatcher(pattern), handler, pattern });
  }
  unroute(pattern, handler) {
    this.routes = this.routes.filter((r) => keepRoute(r, pattern, handler));
  }

  addCookies(cookies) {
    for (const c of cookies ?? []) this.jar.add(c);
  }
  cookies() {
    return this.jar.all().map(toPWCookie);
  }

  storageState() {
    return { cookies: this.cookies(), origins: this.#dumpOrigins() };
  }
  #dumpOrigins() {
    const out = [];
    for (const [origin, s] of this.#origins) {
      const local = storageEntries(s.localStorage);
      if (local.length) out.push({ origin, localStorage: local });
    }
    return out;
  }

  load(storageState) {
    if (!storageState) return;
    this.addCookies(storageState.cookies);
    for (const o of storageState.origins ?? []) {
      this.#origins.set(o.origin, {
        localStorage: makeStorage(o.localStorage),
        sessionStorage: makeStorage(),
      });
    }
  }
}
