const path = require("path");
const {
  extractKeywords,
  buildProjectSummary,
  readFileUtf8Capped,
  walkFiles,
  DEFAULT_IGNORE_DIRS,
} = require("../context");

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------

describe("extractKeywords", () => {
  test("returns empty array for empty/null input", () => {
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords(undefined)).toEqual([]);
  });

  test("extracts simple tokens and filters stop words", () => {
    const kw = extractKeywords("fix the authentication handler");
    // "fix" and "the" are stop words
    expect(kw).toContain("authentication");
    expect(kw).toContain("handler");
    expect(kw).not.toContain("fix");
    expect(kw).not.toContain("the");
  });

  test("splits camelCase tokens", () => {
    const kw = extractKeywords("refactor handleUserLogin");
    expect(kw).toContain("handleuserlogin");
    expect(kw).toContain("handle");
    expect(kw).toContain("user");
    expect(kw).toContain("login");
  });

  test("extracts file path fragments", () => {
    const kw = extractKeywords("look at src/utils/auth.ts");
    expect(kw).toContain("src/utils/auth.ts");
    expect(kw).toContain("auth.ts");
    expect(kw).toContain("auth");
  });

  test("extracts quoted phrases", () => {
    const kw = extractKeywords('find the "error handler" function');
    expect(kw).toContain("error handler");
  });

  test("respects MAX_KEYWORDS limit (10)", () => {
    const longPrompt = Array.from({ length: 30 }, (_, i) => `keyword${i}`).join(" ");
    const kw = extractKeywords(longPrompt);
    expect(kw.length).toBeLessThanOrEqual(10);
  });

  test("filters tokens shorter than 3 characters", () => {
    const kw = extractKeywords("go do it now ab cd xyz");
    expect(kw).not.toContain("go");
    expect(kw).not.toContain("do");
    expect(kw).not.toContain("it");
    expect(kw).not.toContain("ab");
    expect(kw).not.toContain("cd");
    expect(kw).toContain("now");
    expect(kw).toContain("xyz");
  });
});

// ---------------------------------------------------------------------------
// readFileUtf8Capped
// ---------------------------------------------------------------------------

describe("readFileUtf8Capped", () => {
  test("reads this test file without error", () => {
    const content = readFileUtf8Capped(__filename, 100_000);
    expect(content).toBeTruthy();
    expect(content).toContain("readFileUtf8Capped");
  });

  test("returns null for non-existent file", () => {
    const result = readFileUtf8Capped("/no/such/file/ever.txt", 1024);
    expect(result).toBeNull();
  });

  test("caps output at maxBytes", () => {
    const content = readFileUtf8Capped(__filename, 64);
    expect(content).toBeTruthy();
    expect(Buffer.byteLength(content, "utf-8")).toBeLessThanOrEqual(64);
  });
});

// ---------------------------------------------------------------------------
// buildProjectSummary
// ---------------------------------------------------------------------------

describe("buildProjectSummary", () => {
  test("returns a summary object for the repo root", () => {
    const root = path.resolve(__dirname, "../../..");
    const summary = buildProjectSummary(root);
    expect(summary).toHaveProperty("rootName");
    expect(summary).toHaveProperty("signals");
    expect(Array.isArray(summary.signals)).toBe(true);
  });

  test("includes package.json signal when present", () => {
    const root = path.resolve(__dirname, "../../..");
    const summary = buildProjectSummary(root);
    const pkgSignal = summary.signals.find((s) => s.file === "package.json");
    expect(pkgSignal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// walkFiles
// ---------------------------------------------------------------------------

describe("walkFiles", () => {
  test("finds files under the extension/core directory", () => {
    const coreDir = path.resolve(__dirname, "..");
    const files = walkFiles(coreDir, 100);
    expect(files.length).toBeGreaterThan(0);
    const basenames = files.map((f) => path.basename(f));
    expect(basenames).toContain("context.js");
    expect(basenames).toContain("openai.js");
    expect(basenames).toContain("enhancer.js");
  });

  test("respects maxTotalFiles cap", () => {
    const coreDir = path.resolve(__dirname, "..");
    const files = walkFiles(coreDir, 2);
    expect(files.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_IGNORE_DIRS
// ---------------------------------------------------------------------------

describe("DEFAULT_IGNORE_DIRS", () => {
  test("includes common directories to ignore", () => {
    expect(DEFAULT_IGNORE_DIRS.has("node_modules")).toBe(true);
    expect(DEFAULT_IGNORE_DIRS.has(".git")).toBe(true);
    expect(DEFAULT_IGNORE_DIRS.has("dist")).toBe(true);
  });
});
