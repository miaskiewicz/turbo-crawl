// MCP tool handlers (SPEC §10), 1:1 with the Page API. Kept transport-free and
// SDK-free so they unit-test offline; server.mjs wires them into an MCP server.
//
// Each handler returns a plain JSON-able result; the SDK layer wraps it as tool
// output. A handler throwing surfaces as an MCP tool error.

import { buildSubmission } from "../src/actions.mjs";
import { batch } from "../src/batch.mjs";
import { crawlSite } from "../src/crawl.mjs";
import { detectJsRequired } from "../src/detect.mjs";
import { textOf } from "../src/dom-ops.mjs";
import { fetchHtml } from "../src/net.mjs";
import { jsRenderer } from "../src/render/index.mjs";
import { RobotsCache } from "../src/robots.mjs";

// getBy* resolvers exposed to agents by `kind`.
const GET_BY = {
  role: (page, v, name) => page.getByRole(v, { name }),
  text: (page, v) => page.getByText(v),
  label: (page, v) => page.getByLabel(v),
  placeholder: (page, v) => page.getByPlaceholder(v),
  testid: (page, v) => page.getByTestId(v),
  alttext: (page, v) => page.getByAltText(v),
  title: (page, v) => page.getByTitle(v),
};

function resolveBy(page, kind, value, name) {
  const make = GET_BY[kind];
  if (!make)
    throw new Error(
      `unknown get_by kind: ${kind} (role|text|label|placeholder|testid|alttext|title)`,
    );
  return make(page, value, name);
}

// JSON-safe summary of a matched element (no live node).
function elementSummary(el) {
  return { html: el.outerHTML ?? "", text: textOf(el) };
}

// Drop the live DOM `node` from query results — it isn't JSON-serializable.
function stripNodes(result) {
  if (Array.isArray(result)) return result.map(stripNodes);
  if (result && typeof result === "object" && "node" in result) {
    const rest = { ...result };
    delete rest.node;
    return rest;
  }
  return result;
}

// --- render-mode control (lazily wires the JS render tier into the Page) ------

// Cache + reuse one renderer per mode; `ctx.base` is the Page's original fetcher.
function rendererFor(ctx, page, mode) {
  ctx.base ??= page.fetchHtml;
  let r = ctx.renderers.get(mode);
  if (!r) {
    r = jsRenderer({ mode, fetchHtml: ctx.base });
    ctx.renderers.set(mode, r);
  }
  return r;
}

// Point the Page's fetcher at Lane A ("no-js") or a render tier ("fast"/"secure").
function setMode(ctx, page, mode) {
  if (!mode || mode === "no-js") {
    if (ctx.base) page.setFetchHtml(ctx.base);
    return { mode: "no-js" };
  }
  page.setFetchHtml(rendererFor(ctx, page, mode).fetchHtml);
  return { mode };
}

// Switch mode and re-navigate (default url = current page) so it renders now.
function renderNow(ctx, page, mode, url) {
  setMode(ctx, page, mode ?? "fast");
  return page.goto(url ?? page.url);
}

async function robotsCheck(ctx, url, userAgent) {
  ctx.robots ??= new RobotsCache();
  const allowed = await ctx.robots.allowed(url, userAgent);
  const crawlDelay = await ctx.robots.crawlDelay(new URL(url).origin, userAgent);
  return { allowed, crawlDelay };
}

// --- cookies ------------------------------------------------------------------

function toCookie(c) {
  const expires = c.expiresAt === Infinity ? -1 : Math.floor(c.expiresAt / 1000);
  const { name, value, domain, path, secure, httpOnly, sameSite } = c;
  return { name, value, domain, path, expires, secure: !!secure, httpOnly: !!httpOnly, sameSite };
}

// --- snapshot / forms / links -------------------------------------------------

function headings(doc) {
  return [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => ({
    level: Number(h.tagName[1]),
    text: textOf(h),
  }));
}

function snapshot(page) {
  return {
    url: page.url,
    title: page.title(),
    headings: headings(page.document),
    interactive: page.interactiveElements(),
    links: page.links(),
  };
}

function formField(el) {
  const type = (el.getAttribute("type") || el.tagName).toLowerCase();
  return { name: el.getAttribute("name"), type, value: el.value ?? el.getAttribute("value") ?? "" };
}

function formInfo(form, url) {
  const sub = buildSubmission(form, url);
  return {
    action: form.getAttribute("action"),
    method: sub.method,
    submitUrl: sub.url,
    fields: [...form.querySelectorAll("input,select,textarea")].map(formField),
  };
}

function forms(page) {
  return [...page.document.querySelectorAll("form")].map((f) => formInfo(f, page.url));
}

function linkFilter(opts, origin) {
  const re = opts.pattern ? new RegExp(opts.pattern) : null;
  const host = opts.sameHost ? origin : null;
  return (u) => (!re || re.test(u)) && (!host || u.startsWith(host));
}

function extractLinks(page, opts) {
  const origin = page.url ? new URL(page.url).origin : "";
  const keep = page.links().filter(linkFilter(opts, origin));
  return opts.limit ? keep.slice(0, opts.limit) : keep;
}

// --- direct resource fetch (API/asset, bypassing the page) --------------------

async function fetchResource(page, url, asJson) {
  const res = await fetchHtml(url, { allowNonHtml: true, jar: page.cookies });
  const body = res.html ?? "";
  const tail = asJson ? { json: JSON.parse(body) } : { body };
  return { status: res.status, finalUrl: res.finalUrl, ...tail };
}

// --- multi-fill ---------------------------------------------------------------

function fillOne(page, f) {
  if (f.selector != null) page.locator(f.selector).first().fill(f.value);
  else page.fill(f.i, f.value);
}

function fillMany(page, fields) {
  const list = fields ?? [];
  for (const f of list) fillOne(page, f);
  return { ok: true, filled: list.length };
}

/**
 * Build the tool table for a Page (or a managed pool exposing the Page API).
 * @param {import('../src/page.mjs').Page} page
 * @returns {Array<{name:string, description:string, handler:(args:object)=>Promise<any>|any}>}
 */
export function buildTools(page) {
  const ctx = { base: null, renderers: new Map(), robots: null };
  return [
    {
      name: "goto",
      description: "Navigate to a URL. Returns { status, url, title }.",
      handler: ({ url }) => page.goto(url),
    },
    {
      name: "interactive_elements",
      description:
        "List the page's interactive elements as an indexed array (the [i] handles for click/fill). Pass fast:true to skip the visibility pass.",
      handler: ({ fast } = {}) => page.interactiveElements({ visibility: !fast }),
    },
    {
      name: "accessibility_tree",
      description: "Return the page's accessibility tree { role, name, value?, children }.",
      handler: () => page.accessibilityTree(),
    },
    {
      name: "markdown",
      description: "Return readable Markdown of the page's main content.",
      handler: () => page.markdown(),
    },
    {
      name: "html",
      description: "Return the page's serialized HTML (the current DOM).",
      handler: () => page.html(),
    },
    {
      name: "text",
      description: "Return the page's plain text (no markup) with line breaks at block boundaries.",
      handler: () => page.text(),
    },
    {
      name: "links",
      description: "Return all absolute http(s) link targets on the page.",
      handler: () => page.links(),
    },
    {
      name: "requests",
      description:
        "URLs the page fetched during render (JS tier) — fetch/XHR/module deps. Empty without the render tier.",
      handler: () => page.requests(),
    },
    {
      name: "click",
      description:
        "Activate interactive element [i]. Links navigate; submit buttons submit their form. Returns the new { status, url } or errors if the element is inert (JS-only).",
      handler: ({ i }) => page.click(i),
    },
    {
      name: "fill",
      description: "Set the value of form control [i]. Returns an ack.",
      handler: ({ i, value }) => page.fill(i, value),
    },
    {
      name: "submit",
      description:
        "Submit a form (optionally the form owning element [i]). Returns { status, url }.",
      handler: ({ i }) => page.submit(i),
    },
    {
      name: "extract",
      description:
        "Extract structured JSON from the page against a selector-bound schema. Returns the object.",
      handler: ({ schema }) => page.extract(schema),
    },
    {
      name: "hydration_state",
      description:
        "Mine server-embedded hydration data (Next/Nuxt/Apollo/JSON-LD/typed JSON) from inline scripts — no JS executed. Recovers most SPA data.",
      handler: () => page.hydrationState(),
    },
    {
      name: "query",
      description:
        "Query nodes by CSS selector or XPath; returns matched subtree(s) as { html, text } (node ref omitted over MCP). type: auto|css|xpath, first: boolean.",
      handler: ({ selector, type, first }) => stripNodes(page.query(selector, { type, first })),
    },
    {
      name: "get_by",
      description:
        "Resolve elements Playwright-style by kind (role|text|label|placeholder|testid|alttext|title) + value (+ optional name for role). Returns matches as { html, text }.",
      handler: ({ kind, value, name }) =>
        resolveBy(page, kind, value, name).elements().map(elementSummary),
    },
    {
      name: "click_selector",
      description:
        "Click the first element matching a CSS selector. Returns the new { status, url }.",
      handler: ({ selector }) => page.locator(selector).first().click(),
    },
    {
      name: "fill_selector",
      description: "Fill the first form control matching a CSS selector. Returns an ack.",
      handler: ({ selector, value }) => {
        page.locator(selector).first().fill(value);
        return { ok: true };
      },
    },
    {
      name: "select_option",
      description: "Select an <option> (by value or label) of the <select> matching a selector.",
      handler: ({ selector, value }) => {
        page.locator(selector).first().selectOption(value);
        return { ok: true };
      },
    },
    {
      name: "check",
      description: "Check the checkbox/radio matching a selector.",
      handler: ({ selector }) => {
        page.locator(selector).first().check();
        return { ok: true };
      },
    },
    {
      name: "uncheck",
      description: "Uncheck the checkbox matching a selector.",
      handler: ({ selector }) => {
        page.locator(selector).first().uncheck();
        return { ok: true };
      },
    },
    {
      name: "get_attribute",
      description: "Get an attribute of the first element matching a selector.",
      handler: ({ selector, name }) => page.locator(selector).first().getAttribute(name),
    },
    {
      name: "text_content",
      description: "Text content of the first element matching a selector.",
      handler: ({ selector }) => page.locator(selector).first().textContent(),
    },
    {
      name: "inner_html",
      description: "innerHTML of the first element matching a selector.",
      handler: ({ selector }) => page.locator(selector).first().innerHTML(),
    },
    {
      name: "input_value",
      description: "Current value of the first form control matching a selector.",
      handler: ({ selector }) => page.locator(selector).first().inputValue(),
    },
    {
      name: "is_visible",
      description: "Whether the first element matching a selector is visible (cascade).",
      handler: ({ selector }) => page.locator(selector).isVisible(),
    },
    {
      name: "is_checked",
      description: "Whether the first checkbox/radio matching a selector is checked.",
      handler: ({ selector }) => page.locator(selector).first().isChecked(),
    },
    {
      name: "is_enabled",
      description: "Whether the first element matching a selector is enabled.",
      handler: ({ selector }) => page.locator(selector).first().isEnabled(),
    },
    {
      name: "count",
      description: "Number of elements matching a CSS selector.",
      handler: ({ selector }) => page.locator(selector).count(),
    },
    {
      name: "evaluate",
      description:
        "Evaluate a JavaScript expression string against the current (rendered) DOM; returns the JSON-able result. (Function form is JS-API only.)",
      handler: ({ expression }) => page.evaluate(expression),
    },
    {
      name: "set_user_agent",
      description: "Set the User-Agent (navigator + HTTP header) for subsequent navigations.",
      handler: ({ userAgent }) => {
        page.setUserAgent(userAgent);
        return { ok: true };
      },
    },
    {
      name: "go_back",
      description: "Navigate back in history. Returns { status, url } or null at the start.",
      handler: () => page.goBack(),
    },
    {
      name: "go_forward",
      description: "Navigate forward in history. Returns { status, url } or null at the end.",
      handler: () => page.goForward(),
    },
    {
      name: "reload",
      description: "Reload the current page. Returns { status, url }.",
      handler: () => page.reload(),
    },
    {
      name: "batch",
      description:
        "Crawl a list of URLs and return one result per URL. mode: no-js (static, default) | fast (in-process JS render) | secure (isolate JS render). view: markdown (default) | text | html | links | interactive | ax | hydration. Returns [{ url, ok, status, finalUrl, title, data }] (failures: { url, ok:false, error }).",
      handler: ({ urls, mode, view, concurrency }) => batch(urls, { mode, view, concurrency }),
    },
    {
      name: "crawl",
      description:
        "Full-site crawl from a start URL over a frontier (same-host by default). Params: url, maxPages, maxDepth, sameHost, allow/deny (URL regex), mode (no-js|fast|secure — JS modes render only JS-gated pages), view, markdown, robots (respect robots.txt). Returns [{ url, status, depth, title, links, view?, extracted? }].",
      handler: (a) => crawlSite(a),
    },
    {
      name: "render",
      description:
        "Re-render the current page (or { url }) with the JS-execution tier and switch the Page to that mode for later navigations. mode: fast (default, in-process) | secure (isolate) | no-js. Returns { status, url, title }.",
      handler: ({ mode, url }) => renderNow(ctx, page, mode, url),
    },
    {
      name: "set_mode",
      description:
        "Set the navigation mode for subsequent goto/click without re-navigating now. mode: no-js (static) | fast | secure. Returns { mode }.",
      handler: ({ mode }) => setMode(ctx, page, mode),
    },
    {
      name: "detect_js",
      description:
        "Heuristically detect whether the current page needs JavaScript to render its content. Returns { jsRequired, textLength, scripts, reason }.",
      handler: () => detectJsRequired(page.document),
    },
    {
      name: "robots_check",
      description:
        "Check robots.txt for a URL. Returns { allowed, crawlDelay } for the given userAgent (default turbo-crawl).",
      handler: ({ url, userAgent }) => robotsCheck(ctx, url, userAgent),
    },
    {
      name: "get_cookies",
      description:
        "List the session cookies the Page jar holds. Returns [{ name, value, domain, path, expires, secure, httpOnly, sameSite }].",
      handler: () => page.cookies.all().map(toCookie),
    },
    {
      name: "set_cookie",
      description:
        "Add a cookie to the Page jar (auth/session). Params: name, value, domain, path, expires (epoch seconds; -1 session), secure, httpOnly, sameSite.",
      handler: (c) => {
        page.cookies.add(c);
        return { ok: true };
      },
    },
    {
      name: "set_extra_headers",
      description:
        "Set persistent extra HTTP headers (e.g. Authorization) merged into every subsequent request. Params: { headers: { name: value } }.",
      handler: ({ headers }) => {
        page.setExtraHeaders(headers);
        return { ok: true };
      },
    },
    {
      name: "snapshot",
      description:
        "One-shot page state in a single call: { url, title, headings, interactive (indexed elements), links }. Saves round-trips.",
      handler: () => snapshot(page),
    },
    {
      name: "forms",
      description:
        "Enumerate the page's forms with their submit URL/method and fields. Returns [{ action, method, submitUrl, fields:[{ name, type, value }] }].",
      handler: () => forms(page),
    },
    {
      name: "find_text",
      description:
        "Find elements containing visible text. Returns matches as { html, text } (up to limit, default 20).",
      handler: ({ text, limit }) =>
        page
          .getByText(text)
          .elements()
          .slice(0, limit ?? 20)
          .map(elementSummary),
    },
    {
      name: "fetch_json",
      description:
        "Fetch a URL (API/asset) directly through the session jar and parse JSON. Returns { status, finalUrl, json }.",
      handler: ({ url }) => fetchResource(page, url, true),
    },
    {
      name: "fetch_raw",
      description:
        "Fetch a URL directly through the session jar and return the raw body. Returns { status, finalUrl, body }.",
      handler: ({ url }) => fetchResource(page, url, false),
    },
    {
      name: "fill_many",
      description:
        "Fill several fields in one call. Params: { fields: [{ selector, value } | { i, value }] }. Returns { ok, filled }.",
      handler: ({ fields }) => fillMany(page, fields),
    },
    {
      name: "extract_links",
      description:
        "Page links, filtered. Params: sameHost (bool), pattern (URL regex), limit. Returns the matching absolute URLs.",
      handler: (opts) => extractLinks(page, opts),
    },
    {
      name: "eval_js",
      description:
        "Execute JavaScript against the current rendered DOM and return the value. `code` is a function body — use `return` for the result and `arguments` for `args`. Has window/document/navigator/console. Runs in a node:vm over the parsed/rendered DOM (not the page's live render isolate). Params: { code, args? }.",
      handler: ({ code, args }) => page.evalJs(code, ...(args ?? [])),
    },
    {
      name: "inject_js",
      description:
        "Inject a <script> with `code` into the page and execute it against the current DOM (DOM mutations persist; the element stays in the serialized HTML). Params: { code }. Returns { ok }.",
      handler: ({ code }) => page.injectJs(code),
    },
  ];
}
