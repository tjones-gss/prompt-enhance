// core/context.js
// Workspace context gathering for prompt enhancement.
//
// Goal: lightweight, dependency-free, cross-platform-ish.
// - Uses git + ripgrep (rg) when available, falls back gracefully.

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories to skip when walking the file tree. */
const DEFAULT_IGNORE_DIRS = new Set([
  ".git", ".hg", ".svn",
  "node_modules",
  "dist", "build", "out", ".next", ".turbo",
  ".venv", "venv", "__pycache__",
  ".idea", ".vscode",
]);

/** Maximum files to discover when walking the workspace tree. */
const MAX_WALK_FILES = 2000;

/** Maximum bytes to read when doing a shallow content scan of small files. */
const MAX_CONTENT_SCAN_BYTES = 40_000;

/** Lines of context to show before the densest keyword cluster in a snippet. */
const SNIPPET_CONTEXT_BEFORE = 6;

/** Lines of context to show after the densest keyword cluster in a snippet. */
const SNIPPET_CONTEXT_AFTER = 20;

/** Default max snippet lines when no keyword match is found. */
const MAX_DEFAULT_SNIPPET_LINES = 60;

/** Maximum keywords to extract from a single prompt. */
const MAX_KEYWORDS = 10;

/** Timeout (ms) for checking whether a CLI tool exists. */
const COMMAND_CHECK_TIMEOUT = 1500;

/** Timeout (ms) for git commands. */
const GIT_COMMAND_TIMEOUT = 4000;

/** Timeout (ms) for ripgrep search per keyword. */
const RIPGREP_TIMEOUT = 4000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run an external command and return { stdout, stderr }.
 * @param {string} file - Executable name or path.
 * @param {string[]} args - Arguments.
 * @param {Object} [opts] - Options forwarded to child_process.execFile.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execFileAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { ...opts, encoding: "utf-8" }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Check if a CLI command is available by running it with the given args.
 * @param {string} command - The command to test.
 * @param {string[]} [args=["--version"]] - Arguments to pass.
 * @returns {Promise<boolean>}
 */
async function commandWorks(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, { timeout: COMMAND_CHECK_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/**
 * Heuristic: does this buffer look like a binary file?
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isProbablyBinary(buf) {
  return buf.includes(0);
}

/**
 * Read up to `maxBytes` of a file as UTF-8. Returns null if the file is
 * binary, inaccessible, or doesn't exist.
 * @param {string} filePath - Absolute path.
 * @param {number} maxBytes - Cap on bytes to read.
 * @returns {string|null}
 */
function readFileUtf8Capped(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null; // permission denied, doesn't exist, symlink loop, etc.
  }
  try {
    const stat = fs.fstatSync(fd);
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, 0);
    if (isProbablyBinary(buf)) return null;
    return buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Keyword Extraction
// ---------------------------------------------------------------------------

/**
 * Split a camelCase or PascalCase token into its constituent parts.
 * e.g. "handleUserLogin" -> ["handleUserLogin", "handle", "user", "login"]
 * @param {string} token
 * @returns {string[]}
 */
function splitCamelCase(token) {
  const parts = token
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(p => p.length >= 3);
  if (parts.length > 1) {
    return [token.toLowerCase(), ...parts];
  }
  return [token.toLowerCase()];
}

/**
 * Detect file-path-like fragments in a prompt string.
 * e.g. "src/utils/auth.ts" -> ["src/utils/auth.ts", "auth.ts", "auth"]
 * @param {string} prompt
 * @returns {string[]}
 */
function extractPathFragments(prompt) {
  const pathPattern = /(?:[\w.-]+\/)+[\w.-]+(?:\.\w+)?/g;
  const fragments = [];
  let match;
  while ((match = pathPattern.exec(prompt)) !== null) {
    const full = match[0].toLowerCase();
    fragments.push(full);
    // Also add the filename portion
    const basename = full.split("/").pop();
    if (basename && basename.length >= 3) {
      fragments.push(basename);
      // And the name without extension
      const noExt = basename.replace(/\.\w+$/, "");
      if (noExt && noExt.length >= 3 && noExt !== basename) {
        fragments.push(noExt);
      }
    }
  }
  return fragments;
}

/**
 * Extract quoted phrases from the prompt to use as high-priority search terms.
 * e.g. '"error handler"' -> ["error handler"]
 * @param {string} prompt
 * @returns {string[]}
 */
function extractQuotedPhrases(prompt) {
  const phrases = [];
  const pattern = /"([^"]{3,60})"/g;
  let match;
  while ((match = pattern.exec(prompt)) !== null) {
    phrases.push(match[1].toLowerCase().trim());
  }
  return phrases;
}

/** Common stop-words that are too generic to be useful as search keywords. */
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","to","of","in","on","for","with","without","at","by","from",
  "is","are","was","were","be","been","being","do","does","did","doing",
  "fix","bug","issue","add","update","change","make","create","implement","refactor","improve",
  "this","that","these","those","it","its","we","our","you","your",
]);

/**
 * Extract meaningful search keywords from a raw prompt string.
 *
 * Handles camelCase splitting, file path fragments, and quoted phrases.
 *
 * @param {string} prompt - The raw user prompt.
 * @returns {string[]} Up to MAX_KEYWORDS unique keywords, ordered by relevance.
 */
function extractKeywords(prompt) {
  if (!prompt) return [];

  const seen = new Set();
  const results = [];

  function add(token) {
    const t = token.trim().toLowerCase();
    if (t.length >= 3 && !seen.has(t) && !STOP_WORDS.has(t)) {
      seen.add(t);
      results.push(t);
    }
  }

  // 1. Quoted phrases get highest priority (preserved as-is for ripgrep)
  for (const phrase of extractQuotedPhrases(prompt)) {
    add(phrase);
  }

  // 2. File path fragments get next priority
  for (const frag of extractPathFragments(prompt)) {
    add(frag);
  }

  // 3. Regular tokens with camelCase splitting
  const tokens = prompt
    .replace(/[`"'.,;:()[\]{}<>!?/\\|+=\-*]/g, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && /^[a-zA-Z0-9_.-]+$/.test(t));

  for (const token of tokens) {
    for (const part of splitCamelCase(token)) {
      add(part);
    }
  }

  return results.slice(0, MAX_KEYWORDS);
}

// ---------------------------------------------------------------------------
// Git Context
// ---------------------------------------------------------------------------

/**
 * Gather git context for the workspace (status, changed files, last commit).
 * Returns `{ available: false }` if git is not available or the root is not a repo.
 *
 * @param {string} root - Absolute path to workspace root.
 * @returns {Promise<{available: boolean, statusPorcelain?: string, changedFiles?: string[], diffStat?: string, lastCommit?: string}>}
 */
async function getGitContext(root) {
  const gitOk = await commandWorks("git", ["--version"]);
  if (!gitOk) return { available: false };

  try {
    const { stdout: inside } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, timeout: COMMAND_CHECK_TIMEOUT });
    if (!inside.trim().toLowerCase().includes("true")) return { available: false };
  } catch {
    return { available: false };
  }

  const out = { available: true, statusPorcelain: "", changedFiles: [], diffStat: "", lastCommit: "" };

  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: root, timeout: GIT_COMMAND_TIMEOUT });
    out.statusPorcelain = stdout.trim();
  } catch {}

  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only"], { cwd: root, timeout: GIT_COMMAND_TIMEOUT });
    out.changedFiles = stdout.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 50);
  } catch {}

  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat"], { cwd: root, timeout: GIT_COMMAND_TIMEOUT });
    out.diffStat = stdout.trim();
  } catch {}

  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--oneline"], { cwd: root, timeout: 2000 });
    out.lastCommit = stdout.trim();
  } catch {}

  return out;
}

// ---------------------------------------------------------------------------
// Project Signals
// ---------------------------------------------------------------------------

/**
 * Find well-known project config files at the workspace root.
 * @param {string} root - Workspace root.
 * @returns {string[]} Absolute paths of found files.
 */
function findProjectFiles(root) {
  const candidates = [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
    "Pipfile",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "gradle.properties",
  ];
  return candidates
    .map(name => path.join(root, name))
    .filter(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });
}

/**
 * Parse a package.json for dependency hints and script names.
 * @param {string} pkgJsonText - Raw JSON text.
 * @returns {{name: string|null, scripts: string[], depsHints: string[]}|null}
 */
function parsePackageJsonSignals(pkgJsonText) {
  try {
    const pkg = JSON.parse(pkgJsonText);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const keys = Object.keys(deps);
    const known = [
      "next","react","vue","@vue","angular","svelte",
      "express","fastify","koa","nestjs","@nestjs",
      "prisma","sequelize","mongoose",
      "jest","vitest","mocha","playwright","cypress",
      "typescript","eslint","prettier","tailwindcss",
    ];
    const hits = [];
    for (const k of known) {
      if (keys.some(dep => dep === k || dep.startsWith(k + "/") || dep.startsWith(k))) hits.push(k);
    }
    const scripts = Object.keys(pkg.scripts || {});
    return { name: pkg.name || null, scripts: scripts.slice(0, 12), depsHints: Array.from(new Set(hits)).slice(0, 12) };
  } catch {
    return null;
  }
}

/**
 * Parse a requirements.txt for known Python dependency hints.
 * @param {string} text - Raw file text.
 * @returns {{depsHints: string[]}}
 */
function parseRequirementsSignals(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const pkgs = lines.map(l => l.split(/[<>=!~]/)[0]).map(x => x.trim().toLowerCase()).filter(Boolean);
  const known = ["django","flask","fastapi","starlette","sqlalchemy","pytest","requests","pydantic"];
  const hits = known.filter(k => pkgs.includes(k));
  return { depsHints: hits.slice(0, 12) };
}

/**
 * Build a summary of the project from config files at the workspace root.
 * @param {string} root - Workspace root.
 * @returns {{rootName: string, signals: Array<{file: string, [key: string]: any}>}}
 */
function buildProjectSummary(root) {
  const files = findProjectFiles(root);
  const summary = {
    rootName: path.basename(root),
    signals: [],
  };

  for (const f of files) {
    try {
      const text = readFileUtf8Capped(f, 200_000);
      if (!text) continue;
      const base = path.basename(f);
      if (base === "package.json") {
        const sig = parsePackageJsonSignals(text);
        if (sig) summary.signals.push({ file: base, ...sig });
      } else if (base === "requirements.txt") {
        const sig = parseRequirementsSignals(text);
        if (sig) summary.signals.push({ file: base, ...sig });
      } else if (base === "go.mod") {
        const firstLine = text.split(/\r?\n/)[0]?.trim();
        if (firstLine) summary.signals.push({ file: base, module: firstLine.replace(/^module\s+/,"") });
      } else {
        summary.signals.push({ file: base });
      }
    } catch {}
  }
  return summary;
}

// ---------------------------------------------------------------------------
// File Discovery
// ---------------------------------------------------------------------------

/**
 * Use ripgrep to find files matching the given keywords, ranked by hit count.
 * @param {string} root - Workspace root.
 * @param {string[]} keywords - Search keywords.
 * @param {number} maxFiles - Maximum files to return.
 * @returns {Promise<{used: boolean, files: string[]}>}
 */
async function findRelevantFilesWithRipgrep(root, keywords, maxFiles) {
  const scores = new Map();
  const rgOk = await commandWorks("rg", ["--version"]);
  if (!rgOk) return { used: false, files: [] };

  for (const kw of keywords) {
    try {
      const { stdout } = await execFileAsync(
        "rg",
        ["-l", "--hidden", "--glob", "!**/.git/*", kw, "."],
        { cwd: root, timeout: RIPGREP_TIMEOUT }
      );
      const files = stdout.split("\n").map(s => s.trim()).filter(Boolean);
      for (const f of files) {
        scores.set(f, (scores.get(f) || 0) + 1);
      }
    } catch {}
  }

  const ranked = [...scores.entries()]
    .sort((a,b) => b[1]-a[1])
    .map(([f]) => f)
    .slice(0, maxFiles);

  return { used: true, files: ranked };
}

/**
 * Walk the file tree up to MAX_WALK_FILES files, ignoring common junk dirs.
 * @param {string} root - Starting directory.
 * @param {number} [maxTotalFiles=MAX_WALK_FILES] - Cap on total files.
 * @returns {string[]} Absolute paths.
 */
function walkFiles(root, maxTotalFiles = MAX_WALK_FILES) {
  const results = [];
  const stack = [root];
  while (stack.length && results.length < maxTotalFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (results.length >= maxTotalFiles) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Fallback file discovery when ripgrep is unavailable.
 * Ranks files by keyword matches in their path, then optionally by content.
 * @param {string} root - Workspace root.
 * @param {string[]} keywords - Search keywords.
 * @param {number} maxFiles - Maximum files to return.
 * @returns {Promise<{used: boolean, files: string[]}>}
 */
async function findRelevantFilesFallback(root, keywords, maxFiles) {
  const files = walkFiles(root, MAX_WALK_FILES);
  const scores = new Map();

  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    const lower = rel.toLowerCase();
    let s = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) s += 2;
    }
    if (s > 0) scores.set(rel, s);
  }

  // If too few from path matches, do a shallow content scan of small files
  if (scores.size < maxFiles && keywords.length) {
    for (const f of files) {
      if (scores.size >= maxFiles * 10) break;
      let stat;
      try { stat = fs.statSync(f); } catch { continue; }
      if (!stat.isFile() || stat.size > MAX_CONTENT_SCAN_BYTES) continue;
      const rel = path.relative(root, f).replace(/\\/g, "/");
      if (scores.has(rel)) continue;
      const text = readFileUtf8Capped(f, MAX_CONTENT_SCAN_BYTES);
      if (!text) continue;
      const lower = text.toLowerCase();
      let s = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) s += 1;
      }
      if (s > 0) scores.set(rel, s);
    }
  }

  const ranked = [...scores.entries()]
    .sort((a,b) => b[1]-a[1])
    .map(([rel]) => rel)
    .slice(0, maxFiles);

  return { used: false, files: ranked };
}

// ---------------------------------------------------------------------------
// Snippet Extraction
// ---------------------------------------------------------------------------

/**
 * Find the densest cluster of keyword hits in a list of lines.
 * Returns the center index of the best window.
 * @param {string[]} lines - File lines.
 * @param {string[]} kwLower - Lowercased keywords.
 * @param {number} windowSize - The window radius to evaluate density in.
 * @returns {number} Best center line index, or -1 if no match.
 */
function findDensestCluster(lines, kwLower, windowSize) {
  // Collect all matching line indices
  const matchIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (kwLower.some(k => l.includes(k))) {
      matchIndices.push(i);
    }
  }
  if (matchIndices.length === 0) return -1;
  if (matchIndices.length === 1) return matchIndices[0];

  // Sliding window: find the window that contains the most matches
  let bestCount = 0;
  let bestCenter = matchIndices[0];

  for (const idx of matchIndices) {
    const wStart = Math.max(0, idx - windowSize);
    const wEnd = Math.min(lines.length - 1, idx + windowSize);
    let count = 0;
    for (const mi of matchIndices) {
      if (mi >= wStart && mi <= wEnd) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestCenter = idx;
    }
  }

  return bestCenter;
}

/**
 * Read a code snippet from a file, centered on the densest cluster of keyword
 * matches. Adapts window size based on file length.
 *
 * @param {string} root - Workspace root.
 * @param {string} relativePath - Relative path from root.
 * @param {string[]} keywords - Search keywords.
 * @param {number} maxBytes - Max bytes to read from the file.
 * @returns {{relativePath: string, startLine: number, endLine: number, snippet: string}|null}
 */
function readSnippetForRelativeFile(root, relativePath, keywords, maxBytes) {
  const full = path.join(root, relativePath);
  try {
    let stat;
    try { stat = fs.statSync(full); } catch { return null; }
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return null;
    const text = readFileUtf8Capped(full, maxBytes);
    if (!text) return null;

    const lines = text.split(/\r?\n/);
    const kwLower = keywords.map(k => k.toLowerCase());

    // Adaptive window sizing: short files get shown almost entirely
    const totalLines = lines.length;
    let contextBefore, contextAfter, defaultMaxLines;
    if (totalLines <= 80) {
      // Small file: show most of it
      contextBefore = 10;
      contextAfter = 40;
      defaultMaxLines = totalLines;
    } else if (totalLines <= 300) {
      // Medium file: moderate window
      contextBefore = SNIPPET_CONTEXT_BEFORE;
      contextAfter = SNIPPET_CONTEXT_AFTER;
      defaultMaxLines = MAX_DEFAULT_SNIPPET_LINES;
    } else {
      // Large file: tight window
      contextBefore = 4;
      contextAfter = 15;
      defaultMaxLines = 40;
    }

    const clusterCenter = findDensestCluster(lines, kwLower, contextBefore + contextAfter);

    let start = 0;
    let end = Math.min(totalLines, defaultMaxLines);

    if (clusterCenter >= 0) {
      start = Math.max(0, clusterCenter - contextBefore);
      end = Math.min(totalLines, clusterCenter + contextAfter);
    }

    const snippet = lines.slice(start, end).join("\n");
    return { relativePath, startLine: start + 1, endLine: end, snippet };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants (for testing / MCP reuse)
  DEFAULT_IGNORE_DIRS,
  MAX_WALK_FILES,

  // Helpers
  execFileAsync,
  commandWorks,
  readFileUtf8Capped,

  // Keywords
  extractKeywords,

  // Git
  getGitContext,

  // Project
  buildProjectSummary,

  // File discovery
  findRelevantFilesWithRipgrep,
  findRelevantFilesFallback,
  walkFiles,

  // Snippets
  readSnippetForRelativeFile,
};
