// MCP tool handlers (SPEC §10), 1:1 with the Page API. Kept transport-free and
// SDK-free so they unit-test offline; server.mjs wires them into an MCP server.
//
// Each handler returns a plain JSON-able result; the SDK layer wraps it as tool
// output. A handler throwing surfaces as an MCP tool error.

import { textOf } from "../src/dom-ops.mjs";

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

/**
 * Build the tool table for a Page (or a managed pool exposing the Page API).
 * @param {import('../src/page.mjs').Page} page
 * @returns {Array<{name:string, description:string, handler:(args:object)=>Promise<any>|any}>}
 */
export function buildTools(page) {
  return [
    {
      name: "goto",
      description: "Navigate to a URL. Returns { status, url, title }.",
      handler: ({ url }) => page.goto(url),
    },
    {
      name: "interactive_elements",
      description:
        "List the page's interactive elements as an indexed array (the [i] handles for click/fill).",
      handler: () => page.interactiveElements(),
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
  ];
}
