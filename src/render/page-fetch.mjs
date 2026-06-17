// A `fetch` for page scripts in the render tier — routes page-initiated requests
// through turbo-crawl's host net layer (cookies/UA/redirects) instead of the
// turbo-dom stub. Shared by both backends; `state.pending` lets the settle loop
// wait for in-flight requests before snapshotting.
//
// `hooks` (optional) surface page-initiated traffic to the Playwright façade as
// request/response events and let a registered `route()` mock/abort a request
// before it hits the network:
//   { onRequest(req), onResponse(res), onRequestFinished(req),
//     onRequestFailed(req), intercept(req) => Promise<null|mock|"abort"> }

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

// The plain request record handed to hooks + route interceptors (façade wraps it
// in a Playwright-shaped Request).
function makeReq(url, init, resourceType) {
  return {
    url,
    method: (init.method ?? "GET").toUpperCase(),
    headers: init.headers ?? {},
    postData: init.body ?? null,
    resourceType,
  };
}

// A fulfilled route mock → the host-net-shaped result the rest of the tier expects.
function mockToRes(mock) {
  return { html: mock.body ?? "", status: mock.status ?? 200, headers: mock.headers };
}

// Resolve a request: a route may abort (throw) or fulfill (mock) it; otherwise it
// hits the host net layer.
async function fetchOrMock(hostFetch, url, init, req, hooks) {
  const mock = hooks.intercept ? await hooks.intercept(req) : null;
  if (mock === "abort") throw new Error("turbo-crawl: request aborted by route()");
  if (mock) return mockToRes(mock);
  return hostFetch(url, {
    allowNonHtml: true,
    method: init.method,
    body: init.body,
    headers: init.headers,
  });
}

function emitResponse(hooks, req, res, url) {
  hooks.onResponse?.({
    url,
    status: res.status,
    headers: res.headers,
    body: res.html ?? "",
    request: req,
  });
  hooks.onRequestFinished?.(req);
}

/**
 * @param {Function} hostFetch  the host fetchHtml(url, opts) → { html, status, ... }
 * @param {string} base         page URL, for resolving relative request URLs
 * @param {{ pending: number }} state  in-flight counter for settling
 * @param {object} [hooks]      façade event/route hooks (see file header)
 * @returns {(input:any, init?:object)=>Promise<object>}
 */
export function makePageFetch(hostFetch, base, state, hooks = {}) {
  return async (input, init = {}) => {
    const url = requestUrl(input, base);
    const req = makeReq(url, init, "fetch");
    hooks.onRequest?.(req);
    state.pending++;
    try {
      const res = await fetchOrMock(hostFetch, url, init, req, hooks);
      emitResponse(hooks, req, res, url);
      return pageResponse(res, url);
    } catch {
      hooks.onRequestFailed?.(req);
      return pageResponse({ html: "", status: 0 }, url);
    } finally {
      state.pending--;
    }
  };
}

// Fire an XHR's completion callbacks after a response is applied.
function finishXhr(xhr) {
  xhr.readyState = 4;
  if (xhr.onreadystatechange) xhr.onreadystatechange();
  if (xhr.onload) xhr.onload();
}

// Apply a settled host result to the XHR instance (shared success path).
function applyXhrResult(xhr, res) {
  xhr.status = res.status;
  xhr.responseText = res.html ?? "";
  xhr.response = xhr.responseText;
}

/**
 * Minimal host-net-backed XMLHttpRequest for the fast backend (async; the host
 * fetch resolves on the host loop and `state.pending` keeps the render settling).
 */
export function makeXHR(hostFetch, base, state, hooks = {}) {
  return class XMLHttpRequest {
    readyState = 0;
    status = 0;
    responseText = "";
    response = "";
    open(method, url) {
      this._method = method;
      this._url = requestUrl(url, base);
      this.readyState = 1;
    }
    setRequestHeader() {}
    getResponseHeader() {
      return null;
    }
    send(body) {
      const req = makeReq(this._url, { method: this._method, body }, "xhr");
      hooks.onRequest?.(req);
      state.pending++;
      fetchOrMock(hostFetch, this._url, { method: this._method, body }, req, hooks)
        .then((res) => {
          applyXhrResult(this, res);
          emitResponse(hooks, req, res, this._url);
        })
        .catch(() => hooks.onRequestFailed?.(req))
        .finally(() => {
          state.pending--;
          finishXhr(this);
        });
    }
  };
}
