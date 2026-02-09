// mcp-server/server.js
// MCP server for Prompt Enhancer.
// Provides a "build_prompt_context" tool that gathers repo context for
// Cursor's agent system without calling any LLM.
//
// Reuses the core context-gathering logic from ../extension/core/ to avoid
// code duplication.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { createRequire } from "module";

// Bridge CJS modules from the extension core into this ESM context.
const require = createRequire(import.meta.url);
const {
  extractKeywords,
  getGitContext,
  buildProjectSummary,
  findRelevantFilesWithRipgrep,
  findRelevantFilesFallback,
  readFileUtf8Capped,
} = require("../extension/core/context");

// ---------------------------------------------------------------------------
// Context Builder
// ---------------------------------------------------------------------------

/**
 * Build prompt context from the workspace, reusing the shared core modules.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The raw user prompt.
 * @param {string} opts.root - Workspace root path.
 * @param {number} [opts.maxFiles=8] - Max relevant files.
 * @param {number} [opts.maxBytes=65536] - Max bytes per file snippet.
 * @returns {Promise<Object>} Context object with keywords, git, relevantFiles, snippets.
 */
async function buildContext({ prompt, root, maxFiles = 8, maxBytes = 65536 }) {
  const keywords = extractKeywords(prompt);

  // Git info (async)
  let git = null;
  try {
    const gitCtx = await getGitContext(root);
    if (gitCtx.available) {
      git = {
        branch: gitCtx.lastCommit?.split(" ")?.[0] || "",
        changedFiles: gitCtx.changedFiles || [],
      };
    }
  } catch {
    git = null;
  }

  // Find relevant files
  let relevantFiles = [];
  if (keywords.length > 0) {
    let result = await findRelevantFilesWithRipgrep(root, keywords, maxFiles);
    if (!result.files.length) {
      result = await findRelevantFilesFallback(root, keywords, maxFiles);
    }
    relevantFiles = result.files;
  }

  // Read snippets
  const snippets = relevantFiles.map(rel => {
    const fullPath = path.resolve(root, rel);
    const text = readFileUtf8Capped(fullPath, maxBytes);
    return {
      file: rel,
      snippet: text ? text.slice(0, 2000) : "",
    };
  }).filter(s => s.snippet);

  return { root, keywords, git, relevantFiles, snippets };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "prompt-enhancer-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "build_prompt_context",
        description:
          "Collects repository context (keywords, git status, relevant file list, small snippets) " +
          "to help Cursor's agent enhance a prompt. Does not call any LLM.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The raw prompt to gather context for." },
            root: { type: "string", description: "Workspace root path. If omitted, uses current working directory." },
            maxFiles: { type: "number", default: 8, description: "Max relevant files to discover." },
            maxBytes: { type: "number", default: 65536, description: "Max bytes to read per file." },
          },
          required: ["prompt"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "build_prompt_context") {
    const args = request.params.arguments || {};
    const prompt = String(args.prompt || "");
    const root = args.root ? String(args.root) : process.cwd();
    const maxFiles = Number.isFinite(args.maxFiles) ? Number(args.maxFiles) : 8;
    const maxBytes = Number.isFinite(args.maxBytes) ? Number(args.maxBytes) : 65536;

    try {
      const ctx = await buildContext({ prompt, root, maxFiles, maxBytes });
      return {
        content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error building context: ${e?.message || e}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
