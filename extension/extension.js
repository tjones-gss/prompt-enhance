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

/** Callback set by the webview to receive phase progress updates. */
let _progressCallback = null;

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
    cliTimeoutSeconds: cfg.get("cliTimeoutSeconds", 120),
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


/**
 * Open an integrated terminal that installs the Cursor CLI and runs `agent login`.
 * After triggering, the cached CLI path is cleared so the next enhancement attempt
 * will re-detect the freshly installed binary.
 */
function installAndAuthCLI() {
  const isWin = process.platform === "win32";
  const installCmd = isWin
    ? "powershell -NoProfile -Command \"irm 'https://cursor.com/install?win32=true' | iex\""
    : "curl https://cursor.com/install -fsS | bash";

  const loginCmd = isWin
    ? "\"%LOCALAPPDATA%\\cursor-agent\\agent.cmd\" login"
    : "agent login";

  const term = vscode.window.createTerminal({ name: "Cursor CLI Setup" });
  term.show();
  // Chain: install, then login (login only runs if install succeeds)
  term.sendText(`${installCmd} && ${loginCmd}`, true);

  // Invalidate cached path so next call to findAgentCLI() re-searches
  _agentCLIPath = null;

  log("installAndAuthCLI: terminal opened, install + login command sent");
}

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
    candidates.push(path.join(os.homedir(), ".local", "bin", "agent"));
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
    vscode.window
      .showWarningMessage(
        "Cursor CLI not installed. Install now for AI-powered prompt enhancement (no API key needed)?",
        "Install Now",
        "Not Now"
      )
      .then((choice) => {
        if (choice === "Install Now") {
          installAndAuthCLI();
        }
      });
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
      // Quote paths so spaces in usernames (e.g. "Jane Doe") don't break the redirect
      const spawnArgs = ["/c", `"${agentPath}"`, ...args, "<", `"${tmpFile}"`];
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
    const cliTimeout = getCfg().cliTimeoutSeconds * 1000;
    const timer = setTimeout(() => {
      log(`callEditorLM: TIMEOUT (${getCfg().cliTimeoutSeconds}s), killing process`);
      proc.kill();
      cleanup();
      reject(new Error(`Cursor CLI timed out (${getCfg().cliTimeoutSeconds}s). Try a shorter prompt or increase promptEnhancer.cliTimeoutSeconds in settings.`));
    }, cliTimeout);

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
        if (stderr && /auth|login|log in|authenticate|not logged/i.test(stderr)) {
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
      onProgress: _progressCallback,
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
        // Wire up phase-aware progress: the enhancer calls onProgress("phase label")
        // and we forward it to the webview with an elapsed timer
        const startTime = Date.now();
        let currentPhase = "Starting...";

        _progressCallback = (phase) => {
          currentPhase = phase;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          if (panel) {
            panel.webview.postMessage({ type: "status", message: `${phase} (${elapsed}s)`, phase: true });
          }
        };

        // Also tick every 3s so the elapsed time updates even within a long phase
        const tickInterval = setInterval(() => {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          if (panel) {
            panel.webview.postMessage({ type: "status", message: `${currentPhase} (${elapsed}s)`, phase: true });
          }
        }, 3000);

        panel.webview.postMessage({ type: "status", message: "Starting... (0s)", phase: true });

        let res;
        try {
          res = await enhanceFromEditorText(promptText, false);
        } finally {
          clearInterval(tickInterval);
          _progressCallback = null;
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
      } else if (msg?.type === "installCLI") {
        installAndAuthCLI();
        panel.webview.postMessage({ type: "status", message: "Installing Cursor CLI... Check the terminal that opened." });
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
    .status { margin-top: 10px; font-size: 13px; opacity: 0.9; min-height: 20px; display: flex; align-items: center; gap: 8px; }
    .meta { margin-top: 10px; font-size: 12px; opacity: 0.85; }
    .error { color: #cc0000; }
    code { background: rgba(127,127,127,0.15); padding: 2px 4px; border-radius: 4px; }

    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block;
      width: 14px; height: 14px;
      border: 2px solid rgba(127,127,127,0.3);
      border-top-color: var(--vscode-progressBar-background, #0078d4);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    .spinner.hidden { display: none; }

    .tip {
      margin-top: 6px;
      font-size: 11px;
      opacity: 0.6;
      font-style: italic;
      min-height: 16px;
      transition: opacity 0.4s ease;
    }
    .tip.fade-in { opacity: 0.6; }
    .tip.fade-out { opacity: 0; }

    .cli-banner {
      display: none;
      margin-top: 12px;
      padding: 12px 14px;
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 6px;
      background: var(--vscode-editorWarning-background, rgba(204,167,0,0.08));
      font-size: 12px;
      line-height: 1.5;
    }
    .cli-banner.visible { display: block; }
    .cli-banner p { margin: 0 0 8px 0; }
    .cli-banner button {
      padding: 6px 14px;
      font-weight: 600;
      cursor: pointer;
    }
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

  <div id="status" class="status">
    <span id="spinnerEl" class="spinner hidden"></span>
    <span id="statusText"></span>
  </div>
  <div id="tip" class="tip"></div>
  <div id="meta" class="meta"></div>

  <div id="cliBanner" class="cli-banner">
    <p><strong>Cursor CLI not found</strong> &mdash; enhancement used a basic template instead of AI. Install the CLI for full AI-powered results (uses your Cursor subscription, no API key needed).</p>
    <p style="font-size:12px;opacity:0.85;">Alternatively, set an <strong>OpenAI API key</strong> in settings to use AI without the CLI.</p>
    <button id="installCliBtn">Install &amp; Authenticate Cursor CLI</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const promptEl = document.getElementById('prompt');
    const statusTextEl = document.getElementById('statusText');
    const spinnerEl = document.getElementById('spinnerEl');
    const tipEl = document.getElementById('tip');
    const metaEl = document.getElementById('meta');
    const cliBannerEl = document.getElementById('cliBanner');

    document.getElementById('installCliBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'installCLI' });
      cliBannerEl.className = 'cli-banner';
      setStatus('Installing Cursor CLI... Check the terminal that just opened.', false, false);
    });

    let latestEnhanced = '';
    let tipInterval = null;

    const tips = [
      'Tip: Select text in the editor and press Ctrl+Alt+P to enhance inline',
      'Tip: Type @enhance in Chat for quick enhancement',
      'Tip: Shorter prompts tend to get faster responses',
      'Tip: The enhancer uses your git context and workspace files',
      'Tip: Press Ctrl+Shift+E (Cmd+Shift+E on Mac) to open this panel anytime',
      'Tip: Enhanced prompts include relevant file paths from your project',
    ];

    function showSpinner(show) {
      spinnerEl.className = show ? 'spinner' : 'spinner hidden';
    }

    function startTips() {
      stopTips();
      let idx = Math.floor(Math.random() * tips.length);
      tipEl.textContent = tips[idx];
      tipEl.className = 'tip fade-in';
      tipInterval = setInterval(() => {
        tipEl.className = 'tip fade-out';
        setTimeout(() => {
          idx = (idx + 1) % tips.length;
          tipEl.textContent = tips[idx];
          tipEl.className = 'tip fade-in';
        }, 400);
      }, 6000);
    }

    function stopTips() {
      if (tipInterval) { clearInterval(tipInterval); tipInterval = null; }
      tipEl.textContent = '';
      tipEl.className = 'tip';
    }

    function setStatus(msg, isError, isPhase) {
      statusTextEl.textContent = msg || '';
      if (isError) {
        showSpinner(false);
        stopTips();
        statusTextEl.style.color = '#cc0000';
      } else if (isPhase) {
        showSpinner(true);
        statusTextEl.style.color = '';
      } else {
        showSpinner(false);
        stopTips();
        statusTextEl.style.color = '';
      }
    }

    function enhanceNow() {
      const prompt = promptEl.value || '';
      startTips();
      vscode.postMessage({ type: 'enhance', prompt });
    }

    document.getElementById('enhanceBtn').addEventListener('click', enhanceNow);
    document.getElementById('cancelBtn').addEventListener('click', () => { stopTips(); showSpinner(false); vscode.postMessage({ type: 'cancel' }); });
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
        setStatus(msg.message || '', false, !!msg.phase);
        if (!msg.phase) stopTips();
      } else if (msg.type === 'error') {
        setStatus(msg.message || 'Error', true, false);
      } else if (msg.type === 'enhanced') {
        showSpinner(false);
        stopTips();
        latestEnhanced = msg.enhancedPrompt || '';
        promptEl.value = latestEnhanced;
        const files = Array.isArray(msg.relevantFiles) ? msg.relevantFiles : [];
        const kws = Array.isArray(msg.keywords) ? msg.keywords : [];
        metaEl.innerHTML = 
          '<div><strong>Keywords:</strong> ' + (kws.length ? kws.join(', ') : '(none)') + '</div>' +
          '<div><strong>Relevant files:</strong> ' + (files.length ? files.slice(0, 8).join(', ') : '(none)') + '</div>' +
          '<div><strong>Backend:</strong> ' + (msg.backend === 'cursor' ? 'Cursor CLI' : msg.backend === 'openai' ? 'LLM (OpenAI)' : 'Template') + '</div>';
        // Show the CLI install banner when template fallback is used
        cliBannerEl.className = msg.backend === 'template' ? 'cli-banner visible' : 'cli-banner';
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

  // Clear CLI cache when window regains focus (user may have installed CLI in terminal)
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && _agentCLIPath === false) {
        log("Window regained focus — clearing CLI cache to re-detect");
        _agentCLIPath = null;
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
