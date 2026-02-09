const path = require("path");

// Mock the openai module so we don't make real API calls
jest.mock("../openai", () => ({
  OpenAIError: class OpenAIError extends Error {
    constructor(msg, opts = {}) {
      super(msg);
      this.name = "OpenAIError";
      Object.assign(this, opts);
    }
  },
  callOpenAI: jest.fn(),
}));

const { enhancePrompt, gatherContext, buildLLMInput } = require("../enhancer");
const { callOpenAI } = require("../openai");

// ---------------------------------------------------------------------------
// gatherContext
// ---------------------------------------------------------------------------

describe("gatherContext", () => {
  const workspaceRoot = path.resolve(__dirname, "../../..");

  test("returns contextText, relevantFiles, and snippets", async () => {
    const result = await gatherContext({
      workspaceRoot,
      keywords: ["context", "enhancer"],
    });
    expect(result).toHaveProperty("contextText");
    expect(result).toHaveProperty("relevantFiles");
    expect(result).toHaveProperty("snippets");
    expect(typeof result.contextText).toBe("string");
    expect(Array.isArray(result.relevantFiles)).toBe(true);
    expect(Array.isArray(result.snippets)).toBe(true);
  });

  test("includes workspace root in contextText", async () => {
    const result = await gatherContext({
      workspaceRoot,
      keywords: ["test"],
    });
    expect(result.contextText).toContain(workspaceRoot);
  });

  test("works with empty keywords", async () => {
    const result = await gatherContext({
      workspaceRoot,
      keywords: [],
    });
    expect(result.relevantFiles).toEqual([]);
    expect(result.snippets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildLLMInput
// ---------------------------------------------------------------------------

describe("buildLLMInput", () => {
  test("includes the original prompt", () => {
    const input = buildLLMInput({
      prompt: "Add dark mode toggle",
      contextText: "Workspace root: /project",
    });
    expect(input).toContain("Add dark mode toggle");
  });

  test("includes the context text", () => {
    const input = buildLLMInput({
      prompt: "test prompt",
      contextText: "Project: my-app\nDeps: react",
    });
    expect(input).toContain("Project: my-app");
    expect(input).toContain("Deps: react");
  });

  test("includes system instruction markers", () => {
    const input = buildLLMInput({
      prompt: "test",
      contextText: "context",
    });
    expect(input).toContain("ORIGINAL PROMPT:");
    expect(input).toContain("PROJECT CONTEXT");
    expect(input).toContain("enhanced prompt");
  });
});

// ---------------------------------------------------------------------------
// enhancePrompt (template fallback path, no API key)
// ---------------------------------------------------------------------------

describe("enhancePrompt – template fallback", () => {
  const workspaceRoot = path.resolve(__dirname, "../../..");

  test("returns enhanced prompt with usedLLM=false and backend=template when no API key", async () => {
    const result = await enhancePrompt({
      prompt: "add a dark mode toggle to the settings page",
      workspaceRoot,
      config: { openaiApiKey: "" },
    });
    expect(result.usedLLM).toBe(false);
    expect(result.backend).toBe("template");
    expect(result.enhancedPrompt).toBeTruthy();
    expect(result.enhancedPrompt).toContain("Goal");
    expect(result.enhancedPrompt).toContain("dark mode toggle");
    expect(Array.isArray(result.keywords)).toBe(true);
    expect(Array.isArray(result.relevantFiles)).toBe(true);
  });

  test("throws on empty prompt", async () => {
    await expect(
      enhancePrompt({ prompt: "", workspaceRoot })
    ).rejects.toThrow("No prompt text provided");
  });

  test("throws on missing workspace root", async () => {
    await expect(
      enhancePrompt({ prompt: "test", workspaceRoot: "" })
    ).rejects.toThrow("No workspace root found");
  });
});

// ---------------------------------------------------------------------------
// enhancePrompt – OpenAI LLM path (mocked)
// ---------------------------------------------------------------------------

describe("enhancePrompt – OpenAI LLM path", () => {
  const workspaceRoot = path.resolve(__dirname, "../../..");

  beforeEach(() => {
    callOpenAI.mockReset();
  });

  test("calls OpenAI when API key is provided and returns backend=openai", async () => {
    callOpenAI.mockResolvedValue("Enhanced: do the thing properly");

    const result = await enhancePrompt({
      prompt: "add tests",
      workspaceRoot,
      config: {
        openaiApiKey: "sk-test-key",
        openaiBaseUrl: "https://api.openai.com",
        openaiModel: "gpt-4o-mini",
      },
    });
    expect(result.usedLLM).toBe(true);
    expect(result.backend).toBe("openai");
    expect(result.enhancedPrompt).toBe("Enhanced: do the thing properly");
    expect(callOpenAI).toHaveBeenCalledTimes(1);

    // Verify the call args shape
    const callArgs = callOpenAI.mock.calls[0][0];
    expect(callArgs.apiKey).toBe("sk-test-key");
    expect(callArgs.model).toBe("gpt-4o-mini");
    expect(callArgs.inputText).toContain("add tests");
  });
});

// ---------------------------------------------------------------------------
// enhancePrompt – callEditorLM injection (editor-native LM)
// ---------------------------------------------------------------------------

describe("enhancePrompt – callEditorLM injection", () => {
  const workspaceRoot = path.resolve(__dirname, "../../..");

  beforeEach(() => {
    callOpenAI.mockReset();
  });

  test("uses callEditorLM when provided and returns backend=cursor", async () => {
    const mockEditorLM = jest.fn().mockResolvedValue("Enhanced via Cursor model");

    const result = await enhancePrompt({
      prompt: "fix the login bug",
      workspaceRoot,
      config: { openaiApiKey: "" },
      callEditorLM: mockEditorLM,
    });

    expect(result.usedLLM).toBe(true);
    expect(result.backend).toBe("cursor");
    expect(result.enhancedPrompt).toBe("Enhanced via Cursor model");
    expect(mockEditorLM).toHaveBeenCalledTimes(1);
    // Should NOT call OpenAI
    expect(callOpenAI).not.toHaveBeenCalled();
  });

  test("callEditorLM takes priority over OpenAI when both available", async () => {
    const mockEditorLM = jest.fn().mockResolvedValue("Cursor result");
    callOpenAI.mockResolvedValue("OpenAI result");

    const result = await enhancePrompt({
      prompt: "add dark mode",
      workspaceRoot,
      config: {
        openaiApiKey: "sk-test-key",
        openaiBaseUrl: "https://api.openai.com",
        openaiModel: "gpt-4o-mini",
      },
      callEditorLM: mockEditorLM,
    });

    expect(result.backend).toBe("cursor");
    expect(result.enhancedPrompt).toBe("Cursor result");
    expect(mockEditorLM).toHaveBeenCalledTimes(1);
    expect(callOpenAI).not.toHaveBeenCalled();
  });

  test("falls through to OpenAI when callEditorLM throws", async () => {
    const mockEditorLM = jest.fn().mockRejectedValue(new Error("LM unavailable"));
    callOpenAI.mockResolvedValue("OpenAI fallback result");

    const result = await enhancePrompt({
      prompt: "refactor auth",
      workspaceRoot,
      config: {
        openaiApiKey: "sk-test-key",
        openaiBaseUrl: "https://api.openai.com",
        openaiModel: "gpt-4o-mini",
      },
      callEditorLM: mockEditorLM,
    });

    expect(result.backend).toBe("openai");
    expect(result.enhancedPrompt).toBe("OpenAI fallback result");
    expect(mockEditorLM).toHaveBeenCalledTimes(1);
    expect(callOpenAI).toHaveBeenCalledTimes(1);
  });

  test("falls through to template when callEditorLM returns null and no API key", async () => {
    const mockEditorLM = jest.fn().mockResolvedValue(null);

    const result = await enhancePrompt({
      prompt: "improve error handling",
      workspaceRoot,
      config: { openaiApiKey: "" },
      callEditorLM: mockEditorLM,
    });

    expect(result.backend).toBe("template");
    expect(result.usedLLM).toBe(false);
    expect(result.enhancedPrompt).toContain("Goal");
    expect(mockEditorLM).toHaveBeenCalledTimes(1);
  });

  test("falls through to template when callEditorLM returns empty string", async () => {
    const mockEditorLM = jest.fn().mockResolvedValue("   ");

    const result = await enhancePrompt({
      prompt: "add logging",
      workspaceRoot,
      config: { openaiApiKey: "" },
      callEditorLM: mockEditorLM,
    });

    expect(result.backend).toBe("template");
    expect(result.usedLLM).toBe(false);
  });

  test("backward compat: works without callEditorLM (undefined)", async () => {
    const result = await enhancePrompt({
      prompt: "add feature flags",
      workspaceRoot,
      config: { openaiApiKey: "" },
      // callEditorLM not provided
    });

    expect(result.backend).toBe("template");
    expect(result.usedLLM).toBe(false);
    expect(result.enhancedPrompt).toContain("Goal");
  });

  test("receives the combined LLM input text as argument", async () => {
    const mockEditorLM = jest.fn().mockResolvedValue("Enhanced result");

    await enhancePrompt({
      prompt: "fix database query",
      workspaceRoot,
      config: { openaiApiKey: "" },
      callEditorLM: mockEditorLM,
    });

    expect(mockEditorLM).toHaveBeenCalledTimes(1);
    const inputText = mockEditorLM.mock.calls[0][0];
    expect(inputText).toContain("fix database query");
    expect(inputText).toContain("ORIGINAL PROMPT:");
    expect(inputText).toContain("PROJECT CONTEXT");
  });
});
