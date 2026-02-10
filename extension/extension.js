// extension.js
// VS Code extension entry point for Prompt Enhancer.

const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const { enhancePrompt } = require("./core/enhancer");
const { OpenAIError } = require("./core/openai");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time (ms) to wait for an enhance operation before auto-aborting. */
const ENHANCE_TIMEOUT_MS = 150_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {vscode.WebviewPanel|null} */
let panel = null;

/** @type {AbortController|null} */
let inFlightAbort = null;

/** @type {vscode.OutputChannel|null} */
let outputChannel = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Log a message to the Prompt Enhancer output channel.
 * @param {string} msg
 */
function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}`;
  if (outputChannel) outputChannel.appendLine(line);
  console.log(`[PromptEnhancer] ${msg}`);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Read extension configuration from VS Code settings.
 * @returns {Object} Merged config with defaults applied.
 */
function getCfg() {
  const cfg = vscode.workspace.getConfiguration("promptEnhancer");
  return {
    openaiApiKey: cfg.get("openaiApiKey", ""),
    openaiBaseUrl: cfg.get("openaiBaseUrl", "https://api.openai.com"),
    openaiModel: cfg.get("openaiModel", "gpt-4o-mini"),
    maxRelevantFiles: cfg.get("maxRelevantFiles", 8),
    maxFileBytes: cfg.get("maxFileBytes", 65536),
    useRipgrepIfAvailable: cfg.get("useRipgrepIfAvailable", true),
    includeGitInfo: cfg.get("includeGitInfo", true),
    autoCopyToClipboard: cfg.get("autoCopyToClipboard", true),
    preferEditorLM: cfg.get("preferEditorLM", true),
  };
}

/**
 * Validate the current configuration and return any warnings.
 * @param {Object} cfg - Config object from getCfg().
 * @returns {string[]} Array of warning messages (empty if all valid).
 */
function validateConfig(cfg) {
  const warnings = [];

  if (cfg.maxRelevantFiles < 0 || cfg.maxRelevantFiles > 30) {
    warnings.push("promptEnhancer.maxRelevantFiles should be between 0 and 30.");
  }
  if (cfg.maxFileBytes < 1024 || cfg.maxFileBytes > 1048576) {
    warnings.push("promptEnhancer.maxFileBytes should be between 1024 and 1048576.");
  }
  if (cfg.openaiBaseUrl && !/^https?:\/\//.test(cfg.openaiBaseUrl)) {
    warnings.push("promptEnhancer.openaiBaseUrl must start with http:// or https://.");
  }
  if (cfg.openaiApiKey && cfg.openaiApiKey.length < 8) {
    warnings.push("promptEnhancer.openaiApiKey looks too short to be a valid API key.");
  }

  return warnings;
}

/**
 * Show config validation warnings to the user (if any).
 */
function checkAndWarnConfig() {
  const cfg = getCfg();
  const warnings = validateConfig(cfg);
  for (const w of warnings) {
    vscode.window.showWarningMessage(`Prompt Enhancer: ${w}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the first workspace folder root path.
 * @returns {string|null}
 */
function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

/**
 * Format an error into a user-friendly message string.
 * @param {Error|OpenAIError|any} e
 * @returns {string}
 */
function friendlyError(e) {
  if (e instanceof OpenAIError) {
    // Already has a user-friendly message
    return e.message;
  }
  return e?.message || String(e);
}

// ---------------------------------------------------------------------------
// Cursor CLI LLM Backend
// ---------------------------------------------------------------------------

/**
 * Cached path to the Cursor agent CLI executable (or false if not found).
 * @type {string|false|null} null = not yet checked
 */
let _agentCLIPath = null;

/** Whether we've already shown the "CLI not installed" info message this session. */
let _shownCLINotice = false;

/**
 * Locate the Cursor Agent CLI (`agent` / `agent.cmd`) on this machine.
 * Result is cached for the lifetime of the extension host process.
 *
 * Search order:
 *   1. %LOCALAPPDATA%\cursor-agent\agent.cmd  (Windows installer default)
 *   2. ~/.cursor/bin/agent                     (macOS / Linux)
 *   3. `which agent` / `where agent` on PATH
 *
 * @returns {Promise<string|null>} Absolute path to the CLI executable, or null.
 */
async function findAgentCLI() {
  if (_agentCLIPath !== null) {
    log(`findAgentCLI: returning cached result: ${_agentCLIPath || "(not found)"}`);
    return _agentCLIPath || null;
  }

  log("findAgentCLI: searching for Cursor CLI...");
  const isWin = process.platform === "win32";

  // 1. Check well-known install locations
  const candidates = [];
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(path.join(localAppData, "cursor-agent", "agent.cmd"));
  } else {
    candidates.push(path.join(os.homedir(), ".cursor", "bin", "agent"));
    candidates.push("/usr/local/bin/agent");
  }

  for (const p of candidates) {
    const exists = fs.existsSync(p);
    log(`findAgentCLI: checking ${p} — exists: ${exists}`);
    if (exists) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        log(`findAgentCLI: FOUND (X_OK) at ${p}`);
        _agentCLIPath = p;
        return p;
      } catch (accessErr) {
        log(`findAgentCLI: exists but X_OK failed: ${accessErr.message}. Trying R_OK...`);
        // On Windows, X_OK can fail for .cmd files even though they're executable.
        // Fall back to R_OK (readable) which is sufficient for .cmd files.
        try {
          fs.accessSync(p, fs.constants.R_OK);
          log(`findAgentCLI: FOUND (R_OK fallback) at ${p}`);
          _agentCLIPath = p;
          return p;
        } catch (readErr) {
          log(`findAgentCLI: R_OK also failed: ${readErr.message}`);
        }
      }
    }
  }

  // 2. Fall back to PATH lookup
  log("findAgentCLI: candidates not found, trying PATH lookup...");
  return new Promise((resolve) => {
    const cmd = isWin
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe")
      : "which";
    cp.execFile(cmd, ["agent"], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout?.trim()) {
        log(`findAgentCLI: PATH lookup failed (${err?.message || "no output"})`);
        _agentCLIPath = false;
        resolve(null);
      } else {
        const found = stdout.trim().split(/\r?\n/)[0];
        log(`findAgentCLI: FOUND via PATH at ${found}`);
        _agentCLIPath = found;
        resolve(found);
      }
    });
  });
}

/**
 * Call the Cursor Agent CLI in headless print mode to enhance a prompt.
 * Uses stdin piping to avoid argument-length limits on Windows (~8191 chars).
 *
 * @param {string} inputText - The combined prompt text.
 * @returns {Promise<string|null>} The AI-generated text, or null if the CLI is unavailable.
 */
async function callEditorLM(inputText) {
  log(`callEditorLM: called with ${inputText.length} chars`);
  const agentPath = await findAgentCLI();
  if (!agentPath) {
    log("callEditorLM: CLI not found, returning null");
    if (!_shownCLINotice) {
      _shownCLINotice = true;
      vscode.window
        .showInformationMessage(
          "Prompt Enhancer: Install the Cursor CLI for AI-powered enhancement (no API key needed).",
          "Install Guide"
        )
        .then((choice) => {
          if (choice === "Install Guide") {
            vscode.env.openExternal(
              vscode.Uri.parse("https://docs.cursor.com/agent/agent-cli")
            );
          }
        });
    }
    return null;
  }

  log(`callEditorLM: CLI found at ${agentPath}`);

  // Find the bundled rg.exe path so the CLI can locate ripgrep
  const agentDir = path.dirname(agentPath);
  let extraPath = "";
  try {
    // agent installs rg inside its versions directory
    const versionsDir = path.join(agentDir, "versions");
    if (fs.existsSync(versionsDir)) {
      const versions = fs.readdirSync(versionsDir).sort().reverse();
      for (const v of versions) {
        const rgCandidate = path.join(versionsDir, v, process.platform === "win32" ? "rg.exe" : "rg");
        if (fs.existsSync(rgCandidate)) {
          extraPath = path.join(versionsDir, v);
          log(`callEditorLM: found bundled rg at ${extraPath}`);
          break;
        }
      }
    }
  } catch (rgErr) {
    log(`callEditorLM: rg search error (non-fatal): ${rgErr.message}`);
  }

  // Write the prompt to a temp file, then use cmd.exe file redirect (<) to
  // feed it to the CLI. Direct stdin piping to .cmd files on Windows hangs
  // for large multi-line inputs; file redirect is reliable cross-platform.
  const tmpFile = path.join(os.tmpdir(), `pe-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, inputText, "utf8");
  log(`callEditorLM: wrote ${inputText.length} chars to ${tmpFile}`);

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (extraPath) {
      env.PATH = extraPath + (process.platform === "win32" ? ";" : ":") + (env.PATH || "");
    }

    const args = ["-p", "--mode=ask", "--output-format", "text"];
    const isWin = process.platform === "win32";

    // On Windows, .cmd files must be invoked via cmd.exe /c with < redirect.
    // Use ComSpec (full path) because the extension host PATH may not include System32.
    // On Unix, we can pipe stdin directly.
    let proc;
    if (isWin) {
      const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
      const spawnArgs = ["/c", agentPath, ...args, "<", tmpFile];
      log(`callEditorLM: spawning ${comspec} ${spawnArgs.join(" ")}`);
      proc = cp.spawn(comspec, spawnArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: getWorkspaceRoot() || undefined,
      });
    } else {
      log(`callEditorLM: spawning ${agentPath} ${args.join(" ")}`);
      proc = cp.spawn(agentPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        cwd: getWorkspaceRoot() || undefined,
      });
      // On Unix, pipe via stdin
      proc.stdin.write(inputText);
      proc.stdin.end();
    }

    log(`callEditorLM: process spawned, pid=${proc.pid}`);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    function cleanup() {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    // Auto-kill after 120 seconds
    const timer = setTimeout(() => {
      log("callEditorLM: TIMEOUT (120s), killing process");
      proc.kill();
      cleanup();
      reject(new Error("Cursor CLI timed out (120 s). Try a shorter prompt."));
    }, 120_000);

    proc.on("error", (err) => {
      log(`callEditorLM: process error: ${err.message}`);
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      log(`callEditorLM: process exited code=${code}, stdout=${stdout.length} chars, stderr=${stderr.length} chars`);
      if (stderr.trim()) log(`callEditorLM: stderr: ${stderr.trim().substring(0, 500)}`);
      if (code !== 0) {
        if (stderr && /auth/i.test(stderr)) {
          log("callEditorLM: REJECTED — auth error");
          reject(new Error("Cursor CLI not authenticated. Run: agent login"));
        } else {
          log(`callEditorLM: REJECTED — exit code ${code}`);
          reject(new Error(stderr.trim() || `Cursor CLI exited with code ${code}`));
        }
        return;
      }
      log(`callEditorLM: RESOLVED with ${stdout.trim().length} chars`);
      resolve(stdout.trim() || null);
    });
  });
}

/**
 * Map a backend identifier to a user-friendly label.
 * @param {string} backend - "cursor", "openai", or "template".
 * @returns {string}
 */
function backendLabel(backend) {
  switch (backend) {
    case "cursor": return "Cursor CLI";
    case "openai": return "LLM (OpenAI)";
    case "template": return "Template";
    default: return backend || "Unknown";
  }
}

// ---------------------------------------------------------------------------
// Core Enhancement
// ---------------------------------------------------------------------------

/**
 * Run the enhancement pipeline on the given prompt text.
 * Handles abort controller lifecycle and operation timeout.
 *
 * @param {string} promptText - The raw prompt.
 * @param {boolean} replaceSelection - If true, replace the editor selection with the result.
 * @returns {Promise<{enhancedPrompt: string, usedLLM: boolean, keywords: string[], relevantFiles: string[]}>}
 */
async function enhanceFromEditorText(promptText, replaceSelection) {
  log(`enhanceFromEditorText: prompt="${promptText.substring(0, 80)}..." (${promptText.length} chars)`);
  const root = getWorkspaceRoot();
  log(`enhanceFromEditorText: workspaceRoot=${root}`);
  const editor = vscode.window.activeTextEditor;
  const activeFilePath = editor?.document?.uri?.fsPath;
  const selectionText = editor && editor.selection && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection)
    : "";

  const cfg = getCfg();
  log(`enhanceFromEditorText: preferEditorLM=${cfg.preferEditorLM}, openaiApiKey=${cfg.openaiApiKey ? "(set)" : "(empty)"}`);

  // Cancel any previous request
  if (inFlightAbort) {
    try { inFlightAbort.abort(); } catch {}
    inFlightAbort = null;
  }
  inFlightAbort = new AbortController();

  // Auto-abort after timeout so we don't hang forever
  const timer = setTimeout(() => {
    log("enhanceFromEditorText: TIMEOUT — aborting");
    if (inFlightAbort) inFlightAbort.abort();
  }, ENHANCE_TIMEOUT_MS);

  // Show the output channel so user can see progress
  if (outputChannel) outputChannel.show(true);

  let res;
  try {
    log("enhanceFromEditorText: calling enhancePrompt...");
    res = await enhancePrompt({
      prompt: promptText,
      workspaceRoot: root,
      activeFilePath,
      selectionText,
      config: cfg,
      abortSignal: inFlightAbort.signal,
      callEditorLM: cfg.preferEditorLM ? callEditorLM : undefined,
    });
    log(`enhanceFromEditorText: done — backend=${res.backend}, usedLLM=${res.usedLLM}, length=${res.enhancedPrompt.length}`);
  } finally {
    clearTimeout(timer);
  }

  if (cfg.autoCopyToClipboard) {
    await vscode.env.clipboard.writeText(res.enhancedPrompt);
  }

  if (replaceSelection && editor) {
    await editor.edit(editBuilder => {
      if (editor.selection && !editor.selection.isEmpty) {
        editBuilder.replace(editor.selection, res.enhancedPrompt);
      } else {
        editBuilder.insert(editor.selection.active, res.enhancedPrompt);
      }
    });
  }

  return res;
}

// ---------------------------------------------------------------------------
// Webview Panel
// ---------------------------------------------------------------------------

/**
 * Create or reveal the webview panel.
 * @param {vscode.ExtensionContext} context
 * @returns {vscode.WebviewPanel}
 */
function ensurePanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return panel;
  }

  panel = vscode.window.createWebviewPanel(
    "promptEnhancer",
    "Prompt Enhancer",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);

  panel.webview.html = getWebviewHtml(panel.webview);

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      if (msg?.type === "enhance") {
        const promptText = String(msg?.prompt || "");
        if (!promptText.trim()) {
          panel.webview.postMessage({ type: "error", message: "Type a prompt first." });
          return;
        }
        panel.webview.postMessage({ type: "status", message: "Enhancing via Cursor CLI... (0s)" });

        // Show a live countdown so the user knows it's still working
        const startTime = Date.now();
        const progressInterval = setInterval(() => {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          if (panel) {
            panel.webview.postMessage({ type: "status", message: `Enhancing via Cursor CLI... (${elapsed}s)` });
          }
        }, 5000);

        let res;
        try {
          res = await enhanceFromEditorText(promptText, false);
        } finally {
          clearInterval(progressInterval);
        }

        panel.webview.postMessage({
          type: "enhanced",
          enhancedPrompt: res.enhancedPrompt,
          usedLLM: res.usedLLM,
          backend: res.backend,
          keywords: res.keywords,
          relevantFiles: res.relevantFiles,
        });
        panel.webview.postMessage({
          type: "status",
          message: `Enhanced (${backendLabel(res.backend)}). Copied to clipboard.`,
        });
      } else if (msg?.type === "cancel") {
        if (inFlightAbort) {
          try { inFlightAbort.abort(); } catch {}
          inFlightAbort = null;
          panel.webview.postMessage({ type: "status", message: "Canceled." });
        }
      } else if (msg?.type === "copy") {
        const text = String(msg?.text || "");
        await vscode.env.clipboard.writeText(text);
        panel.webview.postMessage({ type: "status", message: "Copied to clipboard." });
      } else if (msg?.type === "insert") {
        const text = String(msg?.text || "");
        await enhanceFromEditorText(text, true);
        panel.webview.postMessage({ type: "status", message: "Inserted into editor selection/cursor." });
      } else if (msg?.type === "sendToChat") {
        const text = String(msg?.text || "");
        if (!text.trim()) {
          panel.webview.postMessage({ type: "error", message: "Nothing to send. Enhance a prompt first." });
          return;
        }
        await vscode.commands.executeCommand(
          "workbench.action.chat.open",
          { query: text, isPartialQuery: true }
        );
        panel.webview.postMessage({ type: "status", message: "Sent to Chat input." });
      }
    } catch (e) {
      const m = friendlyError(e);
      if (panel) panel.webview.postMessage({ type: "error", message: m });
      vscode.window.showErrorMessage(`Prompt Enhancer: ${m}`);
    }
  });

  return panel;
}

/**
 * Generate the HTML content for the webview panel.
 * @param {vscode.Webview} webview
 * @returns {string}
 */
function getWebviewHtml(webview) {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prompt Enhancer</title>
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif; margin: 16px; }
    textarea { width: 100%; height: 260px; font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size: 12px; padding: 10px; box-sizing: border-box; }
    .row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
    button { padding: 8px 12px; }
    .status { margin-top: 10px; font-size: 12px; opacity: 0.85; }
    .meta { margin-top: 10px; font-size: 12px; opacity: 0.85; }
    .error { color: #cc0000; }
    code { background: rgba(127,127,127,0.15); padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>Prompt Enhancer</h2>
  <p>
    Type a rough prompt, then press <code>Ctrl+P</code> (or <code>Cmd+P</code>) inside the box to enhance it using your workspace context.
    <br/>
    Tip: You can also select text in an editor and use <code>Ctrl+Alt+P</code> to replace it with an enhanced prompt.
  </p>

  <textarea id="prompt" placeholder="e.g. fix the login bug"></textarea>

  <div class="row">
    <button id="enhanceBtn">Enhance (Ctrl/Cmd+P)</button>
    <button id="cancelBtn">Cancel</button>
    <button id="copyBtn">Copy Enhanced</button>
    <button id="insertBtn">Insert into Editor</button>
    <button id="sendToChatBtn">Send to Chat</button>
  </div>

  <div id="status" class="status"></div>
  <div id="meta" class="meta"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const promptEl = document.getElementById('prompt');
    const statusEl = document.getElementById('status');
    const metaEl = document.getElementById('meta');

    let latestEnhanced = '';

    function setStatus(msg, isError=false) {
      statusEl.textContent = msg || '';
      statusEl.className = 'status' + (isError ? ' error' : '');
    }

    function enhanceNow() {
      const prompt = promptEl.value || '';
      vscode.postMessage({ type: 'enhance', prompt });
    }

    document.getElementById('enhanceBtn').addEventListener('click', enhanceNow);
    document.getElementById('cancelBtn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    document.getElementById('copyBtn').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: latestEnhanced || promptEl.value || '' }));
    document.getElementById('insertBtn').addEventListener('click', () => vscode.postMessage({ type: 'insert', text: latestEnhanced || promptEl.value || '' }));
    document.getElementById('sendToChatBtn').addEventListener('click', () => vscode.postMessage({ type: 'sendToChat', text: latestEnhanced || promptEl.value || '' }));

    promptEl.addEventListener('keydown', (e) => {
      const key = (e.key || '').toLowerCase();
      const isEnhance = (key === 'p') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
      if (isEnhance) {
        e.preventDefault();
        enhanceNow();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'status') {
        setStatus(msg.message || '');
      } else if (msg.type === 'error') {
        setStatus(msg.message || 'Error', true);
      } else if (msg.type === 'enhanced') {
        latestEnhanced = msg.enhancedPrompt || '';
        promptEl.value = latestEnhanced;
        const files = Array.isArray(msg.relevantFiles) ? msg.relevantFiles : [];
        const kws = Array.isArray(msg.keywords) ? msg.keywords : [];
        metaEl.innerHTML = 
          '<div><strong>Keywords:</strong> ' + (kws.length ? kws.join(', ') : '(none)') + '</div>' +
          '<div><strong>Relevant files:</strong> ' + (files.length ? files.slice(0, 8).join(', ') : '(none)') + '</div>' +
          '<div><strong>Backend:</strong> ' + (msg.backend === 'cursor' ? 'Cursor CLI' : msg.backend === 'openai' ? 'LLM (OpenAI)' : 'Template') + '</div>';
      }
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Called by VS Code when the extension is activated.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // Create output channel for diagnostics
  outputChannel = vscode.window.createOutputChannel("Prompt Enhancer");
  context.subscriptions.push(outputChannel);
  log("Extension activated");
  log(`Platform: ${process.platform}, Node: ${process.version}`);
  log(`LOCALAPPDATA: ${process.env.LOCALAPPDATA || "(not set)"}`);

  // Validate config on activation
  checkAndWarnConfig();

  // Re-validate when config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("promptEnhancer")) {
        checkAndWarnConfig();
      }
    })
  );

  // Command: Open Panel
  context.subscriptions.push(vscode.commands.registerCommand("promptEnhancer.openPanel", () => {
    ensurePanel(context);
  }));

  // Command: Enhance Selection (with progress)
  context.subscriptions.push(vscode.commands.registerCommand("promptEnhancer.enhanceSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("Prompt Enhancer: open a file first.");
      return;
    }
    const selected = editor.selection && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : "";
    const promptText = selected || (await vscode.window.showInputBox({ prompt: "Enter a prompt to enhance" })) || "";
    if (!promptText.trim()) return;

    try {
      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Enhancing prompt...",
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            if (inFlightAbort) inFlightAbort.abort();
          });
          return enhanceFromEditorText(promptText, true);
        }
      );
      vscode.window.showInformationMessage(`Prompt Enhancer: enhanced (${backendLabel(res.backend)}) and copied to clipboard.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Prompt Enhancer: ${friendlyError(e)}`);
    }
  }));

  // Command: Enhance Clipboard (with progress)
  context.subscriptions.push(vscode.commands.registerCommand("promptEnhancer.enhanceClipboard", async () => {
    const text = await vscode.env.clipboard.readText();
    const promptText = text || (await vscode.window.showInputBox({ prompt: "Clipboard empty. Enter a prompt to enhance" })) || "";
    if (!promptText.trim()) return;

    try {
      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Enhancing prompt...",
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            if (inFlightAbort) inFlightAbort.abort();
          });
          return enhanceFromEditorText(promptText, false);
        }
      );
      await vscode.env.clipboard.writeText(res.enhancedPrompt);
      vscode.window.showInformationMessage(`Prompt Enhancer: enhanced (${backendLabel(res.backend)}) and copied to clipboard.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Prompt Enhancer: ${friendlyError(e)}`);
    }
  }));

  // Command: Enhance & Send to Chat (with progress + right-click context menu)
  context.subscriptions.push(vscode.commands.registerCommand("promptEnhancer.enhanceToChat", async () => {
    const editor = vscode.window.activeTextEditor;
    const selected = editor && editor.selection && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : "";
    const promptText = selected || (await vscode.window.showInputBox({ prompt: "Enter a prompt to enhance and send to chat" })) || "";
    if (!promptText.trim()) return;

    try {
      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Enhancing prompt for chat...",
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            if (inFlightAbort) inFlightAbort.abort();
          });
          return enhanceFromEditorText(promptText, false);
        }
      );

      // Open Cursor/VS Code Chat with the enhanced prompt pre-filled (not auto-sent)
      await vscode.commands.executeCommand(
        "workbench.action.chat.open",
        { query: res.enhancedPrompt, isPartialQuery: true }
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Prompt Enhancer: ${friendlyError(e)}`);
    }
  }));

  // Command: Enhance Clipboard & Fill Chat
  // User copies their rough prompt (from Chat or anywhere), runs this command,
  // and the enhanced version is placed into the Chat input.
  context.subscriptions.push(vscode.commands.registerCommand("promptEnhancer.enhanceClipboardToChat", async () => {
    const clipText = await vscode.env.clipboard.readText();
    const promptText = clipText || (await vscode.window.showInputBox({ prompt: "Clipboard empty. Enter a prompt to enhance and send to chat" })) || "";
    if (!promptText.trim()) return;

    try {
      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Enhancing clipboard for chat...",
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            if (inFlightAbort) inFlightAbort.abort();
          });
          return enhanceFromEditorText(promptText, false);
        }
      );

      await vscode.commands.executeCommand(
        "workbench.action.chat.open",
        { query: res.enhancedPrompt, isPartialQuery: true }
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Prompt Enhancer: ${friendlyError(e)}`);
    }
  }));

  // -------------------------------------------------------------------------
  // Helper commands (used by Chat Participant buttons)
  // -------------------------------------------------------------------------

  // Command: Copy arbitrary text to clipboard (used by participant response buttons)
  context.subscriptions.push(vscode.commands.registerCommand("promptEnhancer.copyText", async (text) => {
    if (typeof text === "string" && text.trim()) {
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage("Prompt Enhancer: copied to clipboard.");
    }
  }));

  // Command: Fill Chat input with given text (used by participant response buttons)
  context.subscriptions.push(vscode.commands.registerCommand("promptEnhancer.fillChat", async (text) => {
    if (typeof text === "string" && text.trim()) {
      await vscode.commands.executeCommand(
        "workbench.action.chat.open",
        { query: text, isPartialQuery: true }
      );
    }
  }));

  // -------------------------------------------------------------------------
  // Chat Participant: @enhance
  // -------------------------------------------------------------------------
  // Users can type "@enhance fix the login bug" directly in Chat to get an
  // enhanced prompt streamed back as a response.

  if (typeof vscode.chat?.createChatParticipant === "function") {
    const participant = vscode.chat.createChatParticipant(
      "promptEnhancer.enhance",
      async (request, _chatContext, stream, token) => {
        const promptText = String(request.prompt || "").trim();
        if (!promptText) {
          stream.markdown("Please provide a prompt to enhance. For example: `@enhance fix the login bug`");
          return;
        }

        stream.progress("Enhancing your prompt...");

        const root = getWorkspaceRoot();
        const editor = vscode.window.activeTextEditor;
        const activeFilePath = editor?.document?.uri?.fsPath;
        const selectionText = editor && editor.selection && !editor.selection.isEmpty
          ? editor.document.getText(editor.selection)
          : "";

        const cfg = getCfg();

        // Create an abort controller that respects the cancellation token
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const timer = setTimeout(() => abort.abort(), ENHANCE_TIMEOUT_MS);

        let res;
        try {
          res = await enhancePrompt({
            prompt: promptText,
            workspaceRoot: root,
            activeFilePath,
            selectionText,
            config: cfg,
            abortSignal: abort.signal,
            callEditorLM: cfg.preferEditorLM ? callEditorLM : undefined,
          });
        } catch (e) {
          clearTimeout(timer);
          stream.markdown("**Error:** " + friendlyError(e));
          return;
        }
        clearTimeout(timer);

        // Stream the enhanced prompt as markdown
        stream.markdown("**Enhanced prompt:**\n\n");
        stream.markdown(res.enhancedPrompt);

        // Meta info
        const kws = Array.isArray(res.keywords) ? res.keywords : [];
        const files = Array.isArray(res.relevantFiles) ? res.relevantFiles : [];
        stream.markdown("\n\n---\n");
        stream.markdown("*Keywords:* " + (kws.length ? kws.join(", ") : "(none)") + "  \n");
        stream.markdown("*Relevant files:* " + (files.length ? files.slice(0, 8).join(", ") : "(none)") + "  \n");
        stream.markdown("*Backend:* " + backendLabel(res.backend) + "\n");

        // Action buttons
        stream.button({
          command: "promptEnhancer.copyText",
          title: "Copy to Clipboard",
          arguments: [res.enhancedPrompt],
        });
        stream.button({
          command: "promptEnhancer.fillChat",
          title: "Use in Chat",
          arguments: [res.enhancedPrompt],
        });
      }
    );
    participant.iconPath = new vscode.ThemeIcon("sparkle");
    context.subscriptions.push(participant);
  }
}

/**
 * Called by VS Code when the extension is deactivated.
 */
function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
