#!/usr/bin/env node
// KYM MCP server (stdio). Exposes read-only budget tools (src/tools.mjs) over the
// Model Context Protocol so any MCP client — Claude Desktop, or a LOCAL model via
// Ollama+MCP — can answer questions about your finances. The budget never leaves
// your machine: point a local model at this and the whole loop is private.
//
//   KYM_FILE=~/budget.json kym-mcp
//
// The budget event log is re-read on every tool call, so answers reflect live edits.
import { readFileSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.mjs";

const FILE = process.env.KYM_FILE || process.argv[2] || "budget.json";

function loadBudget() {
  if (!existsSync(FILE)) return { events: [], currency: "CZK" };
  const doc = JSON.parse(readFileSync(FILE, "utf8"));
  return { events: doc.events || [], currency: doc.currency || "CZK" };
}

const server = new Server(
  { name: "kym", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.description, inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const tool = TOOLS[name];
  if (!tool) return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
  try {
    const { events, currency } = loadBudget();
    const result = tool.fn(events, currency, args);
    // Human summary first (what a chat model reads), then the structured JSON.
    const text = `${result.text || ""}\n\n${JSON.stringify(result, null, 2)}`;
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `error: ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`kym-mcp: serving ${Object.keys(TOOLS).length} tools over ${FILE}`);
