# Prompt Enhancer (Auggie-style)

Enhance rough prompts into detailed, context-aware instructions for coding agents. **Works out of the box with the Cursor CLI** -- no API key needed. Uses your existing Cursor subscription models (Claude, GPT, Gemini, etc.).

The extension uses three backends in priority order:

1. **Cursor CLI** (preferred) -- calls the `agent` CLI in headless mode using your Cursor subscription. Zero API key needed.
2. **OpenAI API** -- if you configure an API key, uses any OpenAI-compatible provider.
3. **Template fallback** -- deterministic template when no LLM is available.

Also includes an **MCP Server** for Cursor Agent that gathers repo context so Cursor's own model can rewrite your prompt directly in chat.

## Prerequisites

- **Node.js** >= 18
- **Cursor** or **VS Code** >= 1.93
- **Cursor CLI** (recommended) -- for AI-powered enhancement without an API key

### Installing the Cursor CLI

The Cursor CLI (`agent`) is a one-time install per machine:

```bash
# Windows (PowerShell)
irm 'https://cursor.com/install?win32=true' | iex

# macOS / Linux / WSL
curl https://cursor.com/install -fsS | bash
```

After install, authenticate:

```bash
agent login
```

Verify it works:

```bash
agent --version
```

> **Note:** The extension auto-detects the CLI and falls through gracefully if it's not installed. You'll see a one-time notification with install instructions.

## Quick Start (one command)

```bash
git clone https://github.com/tjones-gss/prompt-enhance.git
cd prompt-enhance

# Windows (PowerShell)
.\setup.ps1

# macOS / Linux / WSL
./setup.sh
```

The setup script handles everything: installs the Cursor CLI, authenticates, installs npm dependencies, builds the VSIX, and installs the extension into Cursor. Just follow the prompts.

### Manual Setup (alternative)

If you prefer to do it step by step:

```bash
npm run setup          # Install npm dependencies
npm run package        # Build the VSIX
```

Then install the `.vsix` from `build/`:

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
| `preferEditorLM` | `true` | Prefer the Cursor CLI over OpenAI. Set to `false` to always use OpenAI when a key is configured. |
| `openaiApiKey` | `""` | OpenAI API key. Falls back to `OPENAI_API_KEY` env var. Only used when Cursor CLI is unavailable or disabled. |
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
  setup.ps1               # One-command setup (Windows)
  setup.sh                # One-command setup (macOS/Linux)
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
