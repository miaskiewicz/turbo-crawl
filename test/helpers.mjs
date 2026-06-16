import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Read a fixture file from test/fixtures by name. */
export function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

/**
 * A stub fetchHtml that serves in-memory HTML by URL, for offline tests.
 * Each route value is either an HTML string or a function (url, opts) => html.
 * The returned stub exposes `.calls` — the [url, opts] of every request — so
 * tests can assert on method/body/headers of form submits.
 *
 * @param {Record<string, string | ((url:string, opts:object)=>string)>} routes
 */
export function stubFetch(routes) {
  const stub = async (url, opts = {}) => {
    stub.calls.push([url, opts]);
    const route = routes[url] ?? routes[url.split("?")[0]];
    if (route === undefined) throw new Error(`stubFetch: no route for ${url}`);
    const html = typeof route === "function" ? route(url, opts) : route;
    return { html, finalUrl: url, status: 200, headers: new Headers() };
  };
  stub.calls = [];
  stub.last = () => stub.calls[stub.calls.length - 1];
  return stub;
}
