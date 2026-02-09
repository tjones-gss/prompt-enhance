# Prompt Enhancer – Test in Cursor (fixed build)

## A) Fix for the extension error ("command ... not found")
Install the updated VSIX:

- `build/prompt-enhancer-auggie-style-0.1.1.vsix`

In Cursor:
1. `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
2. Choose the VSIX above
3. Restart Cursor

## B) MCP approach (uses Cursor's own models, no OpenAI key)
This uses Cursor Agents + MCP:
- The MCP server just gathers repo context.
- Cursor's agent/model rewrites your prompt using that context.

### Install MCP server
From the `mcp-server/` folder:
```bash
npm install
```

### Configure Cursor
Edit `~/.cursor/mcp.json` (or use Cursor Settings → Tools & Integrations → MCP):
```json
{
  "mcpServers": {
    "prompt-enhancer": {
      "command": "node",
      "args": ["/ABS/PATH/TO/mcp-server/server.js"]
    }
  }
}
```
Restart Cursor.

### Use it
In Cursor Chat / Agent:
1. Paste your rough prompt
2. Say: "Use the `build_prompt_context` tool, then rewrite my prompt into a crisp, actionable instruction set." 

