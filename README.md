# Prompt Enhancer (Auggie-style)

Enhance rough prompts into detailed, context-aware instructions for coding agents. **Works out of the box in Cursor with zero configuration** -- no API key needed.

The extension uses three backends in priority order:

1. **Cursor / Copilot LM** (preferred) -- uses the editor's built-in language model via `vscode.lm`. Zero setup.
2. **OpenAI API** -- if you configure an API key, uses any OpenAI-compatible provider.
3. **Template fallback** -- deterministic template when no LLM is available.

Also includes an **MCP Server** for Cursor Agent that gathers repo context so Cursor's own model can rewrite your prompt directly in chat.

## Prerequisites

- **Node.js** >= 18
- **Cursor** or **VS Code** >= 1.93

## Quick Start

```bash
git clone https://github.com/tjones-gss/prompt-enhance.git
cd prompt-enhance
npm run setup
```

`npm run setup` installs root dependencies and the MCP server's dependencies in one step.

## Installing the Extension

Build the `.vsix` package:

```bash
npm run package
```

This outputs `build/prompt-enhancer-auggie-style-<version>.vsix`.

Install in Cursor / VS Code:

1. `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS)
2. **Extensions: Install from VSIX...**
3. Select the `.vsix` file from `build/`
4. Restart the editor

## Using the Extension

| Command | Shortcut | Description |
|---------|----------|-------------|
| **Prompt Enhancer: Open Panel** | -- | Opens the webview panel |
| **Prompt Enhancer: Enhance Selected Text** | `Ctrl+Alt+P` | Enhances the selected text in-place |
| **Prompt Enhancer: Enhance Clipboard Text** | -- | Enhances text from your clipboard |
| **Prompt Enhancer: Enhance & Send to Chat** | Right-click menu | Enhances selection and fills the chat input |
| **Prompt Enhancer: Enhance Clipboard & Fill Chat** | -- | Enhances clipboard and fills the chat input |

You can also use the `@enhance` chat participant in Cursor/VS Code chat.

## Setting Up the MCP Server

The MCP server lets Cursor Agent gather workspace context without an OpenAI key.

### 1. Install dependencies

```bash
cd mcp-server
npm install
```

### 2. Configure Cursor

Edit `~/.cursor/mcp.json` (or go to **Cursor Settings > Tools & Integrations > MCP**):

```json
{
  "mcpServers": {
    "prompt-enhancer": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-server/server.js"]
    }
  }
}
```

Restart Cursor after saving.

### 3. Use it

In Cursor Chat or Agent mode:
1. Paste your rough prompt
2. Say: _"Use the `build_prompt_context` tool, then rewrite my prompt into a crisp, actionable instruction set."_

## Configuration

All settings are under `promptEnhancer.*` in VS Code / Cursor settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `preferEditorLM` | `true` | Prefer the editor's built-in language model (Cursor/Copilot) over OpenAI. Set to `false` to always use OpenAI when a key is configured. |
| `openaiApiKey` | `""` | OpenAI API key. Falls back to `OPENAI_API_KEY` env var. Only used when editor LM is unavailable or disabled. |
| `openaiBaseUrl` | `https://api.openai.com` | Base URL for OpenAI-compatible APIs. |
| `openaiModel` | `gpt-4o-mini` | Model name. Any model your provider supports. |
| `maxRelevantFiles` | `8` | Max relevant files to include as context. |
| `maxFileBytes` | `65536` | Max bytes to read per file when building context. |
| `useRipgrepIfAvailable` | `true` | Use ripgrep (`rg`) for fast file discovery if available. |
| `includeGitInfo` | `true` | Include git status and changed files as context. |
| `autoCopyToClipboard` | `true` | Auto-copy the enhanced prompt to clipboard. |

## Development

### Project Structure

```
prompt-enhance/
  package.json            # Root workspace config & scripts
  jest.config.js          # Test configuration
  extension/
    extension.js          # VS Code extension entry point
    package.json          # Extension manifest
    core/
      context.js          # Workspace context gathering
      enhancer.js         # Prompt enhancement pipeline
      openai.js           # Minimal OpenAI client (no deps)
      __tests__/          # Unit tests
  mcp-server/
    server.js             # MCP server entry point
    package.json          # MCP server dependencies
  build/                  # VSIX output directory
```

### Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

### Building the VSIX

```bash
npm run package
```

## License

MIT
