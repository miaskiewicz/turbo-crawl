// A `fetch` for page scripts in the render tier — routes page-initiated requests
// through turbo-crawl's host net layer (cookies/UA/redirects) instead of the
// turbo-dom stub. Shared by both backends; `state.pending` lets the settle loop
// wait for in-flight requests before snapshotting.

// Minimal Response-like returned to page scripts.
function pageResponse(res, url) {
  const body = res.html ?? "";
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    url,
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  };
}

function requestUrl(input, base) {
  try {
    return new URL(String(input), base || undefined).href;
  } catch {
    return String(input);
  }
}

/**
 * @param {Function} hostFetch  the host fetchHtml(url, opts) → { html, status, ... }
 * @param {string} base         page URL, for resolving relative request URLs
 * @param {{ pending: number }} state  in-flight counter for settling
 * @returns {(input:any, init?:object)=>Promise<object>}
 */
export function makePageFetch(hostFetch, base, state) {
  return async (input, init = {}) => {
    state.pending++;
    const url = requestUrl(input, base);
    try {
      const res = await hostFetch(url, {
        allowNonHtml: true,
        method: init.method,
        body: init.body,
        headers: init.headers,
      });
      return pageResponse(res, url);
    } catch {
      return pageResponse({ html: "", status: 0 }, url);
    } finally {
      state.pending--;
    }
  };
}
