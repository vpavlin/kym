# @kym/mcp — ask an AI about your budget, locally

An [MCP](https://modelcontextprotocol.io) server exposing **read-only** tools over your KYM budget, so an AI can answer questions like *"how much did I spend on dining last month?"*, *"am I on track for the emergency fund?"*, *"can I afford 15 000 Kč?"*.

**Principle: the LLM never does math or sees raw events.** Each tool returns values *computed by `@kym/engine`* — the model only routes and phrases, so it cannot hallucinate your numbers. Same rule as the rest of KYM: never trust a derived total from an untrusted layer; always fold.

## Tools
`budget_summary` · `ready_to_assign` · `category_status` · `target_progress` · `spending` · `search_transactions` · `net_worth` · `can_i_afford`

## Run it

```sh
KYM_FILE=/path/to/budget.json node packages/mcp/src/server.mjs   # stdio MCP server
```

The budget event log is re-read on every call, so answers reflect live edits.

## Connect a model

**Private (recommended) — a local model via Ollama + an MCP bridge.** Nothing leaves your machine:

```
ollama pull qwen2.5   # or llama3.x — any tool-calling model
# point your Ollama MCP client at:  KYM_FILE=~/budget.json node .../packages/mcp/src/server.mjs
```

**Claude Desktop** (convenient; tool *results* go to Anthropic) — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kym": {
      "command": "node",
      "args": ["/abs/path/kym/packages/mcp/src/server.mjs"],
      "env": { "KYM_FILE": "/abs/path/budget.json" }
    }
  }
}
```

Then ask: *"What's my Ready to Assign?"*, *"Break down my spending this month."*, *"Can I afford 3 000 Kč of dining?"*

## Privacy

With a local model the whole loop is on your machine — something cloud budgeting apps structurally can't offer. A cloud model is convenient but sends the tool *results* (your figures) to the provider; that's an explicit opt-in, not the default.

## Roadmap
- **Write tools** (`assign`, `categorize`, `create_transaction`) so the assistant can act, not just report (issue #9).
- Serve these tools **from the Basecamp module** (it already holds the engine + the live log) + an embedded local model for a zero-config private assistant.
