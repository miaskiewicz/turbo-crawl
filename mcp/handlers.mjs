// MCP tool handlers (SPEC §10), 1:1 with the Page API. Kept transport-free and
// SDK-free so they unit-test offline; server.mjs wires them into an MCP server.
//
// Each handler returns a plain JSON-able result; the SDK layer wraps it as tool
// output. A handler throwing surfaces as an MCP tool error.

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
      description:
        "Return the page's serialized HTML (the rendered DOM behind the Playwright adapter).",
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
  ];
}
