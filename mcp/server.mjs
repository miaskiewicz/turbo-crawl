#!/usr/bin/env node
// MCP server (SPEC §10): exposes a single Page to any agent over stdio. Tools are
// 1:1 with the Page API (see handlers.mjs). No CDP/Playwright-protocol emulation —
// the clean Page API is the right surface for a no-JS fetcher.
//
// Run:  node mcp/server.mjs        (stdio transport)
// Embed: import { createServer } from "turbo-crawl/mcp"

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { Page } from "../src/index.mjs";
import { buildTools } from "./handlers.mjs";

// JSON Schemas for tool inputs (kept inline; the handlers themselves are schema-free).
const INPUT_SCHEMAS = {
  goto: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  interactive_elements: { type: "object", properties: {} },
  accessibility_tree: { type: "object", properties: {} },
  markdown: { type: "object", properties: {} },
  html: { type: "object", properties: {} },
  text: { type: "object", properties: {} },
  links: { type: "object", properties: {} },
  click: { type: "object", properties: { i: { type: "number" } }, required: ["i"] },
  fill: {
    type: "object",
    properties: { i: { type: "number" }, value: {} },
    required: ["i", "value"],
  },
  submit: { type: "object", properties: { i: { type: "number" } } },
  extract: { type: "object", properties: { schema: { type: "object" } }, required: ["schema"] },
  hydration_state: { type: "object", properties: {} },
  query: {
    type: "object",
    properties: {
      selector: { type: "string" },
      type: { type: "string", enum: ["auto", "css", "xpath"] },
      first: { type: "boolean" },
    },
    required: ["selector"],
  },
  get_by: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["role", "text", "label", "placeholder", "testid", "alttext", "title"],
      },
      value: { type: "string" },
      name: { type: "string" },
    },
    required: ["kind", "value"],
  },
  click_selector: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
  },
  fill_selector: {
    type: "object",
    properties: { selector: { type: "string" }, value: { type: "string" } },
    required: ["selector", "value"],
  },
  select_option: {
    type: "object",
    properties: { selector: { type: "string" }, value: { type: "string" } },
    required: ["selector", "value"],
  },
  check: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
  uncheck: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
  get_attribute: {
    type: "object",
    properties: { selector: { type: "string" }, name: { type: "string" } },
    required: ["selector", "name"],
  },
  text_content: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
  },
  inner_html: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
  },
  input_value: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
  },
  is_visible: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
  },
  is_checked: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
  },
  is_enabled: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
  },
  count: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
  evaluate: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
  set_user_agent: {
    type: "object",
    properties: { userAgent: { type: "string" } },
    required: ["userAgent"],
  },
  go_back: { type: "object", properties: {} },
  go_forward: { type: "object", properties: {} },
  reload: { type: "object", properties: {} },
};

/**
 * Create an MCP Server wired to a Page. Does not connect a transport.
 * @param {object} [opts]
 * @param {Page}   [opts.page]  the Page to drive (default: a fresh one)
 * @returns {{ server: Server, page: Page }}
 */
export function createServer(opts = {}) {
  const page = opts.page ?? new Page();
  const tools = buildTools(page);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "turbo-crawl", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: INPUT_SCHEMAS[t.name] ?? { type: "object", properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
    const result = await tool.handler(req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
  });

  return { server, page };
}

// CLI entry: start the stdio transport when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("turbo-crawl MCP server listening on stdio\n");
}
