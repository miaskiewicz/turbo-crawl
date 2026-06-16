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
  links: { type: "object", properties: {} },
  click: { type: "object", properties: { i: { type: "number" } }, required: ["i"] },
  fill: {
    type: "object",
    properties: { i: { type: "number" }, value: {} },
    required: ["i", "value"],
  },
  submit: { type: "object", properties: { i: { type: "number" } } },
  extract: { type: "object", properties: { schema: { type: "object" } }, required: ["schema"] },
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
