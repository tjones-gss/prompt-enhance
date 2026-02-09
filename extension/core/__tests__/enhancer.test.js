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

  test("returns enhanced prompt with usedLLM=false when no API key", async () => {
    const result = await enhancePrompt({
      prompt: "add a dark mode toggle to the settings page",
      workspaceRoot,
      config: { openaiApiKey: "" },
    });
    expect(result.usedLLM).toBe(false);
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
// enhancePrompt – LLM path (mocked)
// ---------------------------------------------------------------------------

describe("enhancePrompt – LLM path", () => {
  const workspaceRoot = path.resolve(__dirname, "../../..");

  beforeEach(() => {
    callOpenAI.mockReset();
  });

  test("calls LLM when API key is provided and returns usedLLM=true", async () => {
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
    expect(result.enhancedPrompt).toBe("Enhanced: do the thing properly");
    expect(callOpenAI).toHaveBeenCalledTimes(1);

    // Verify the call args shape
    const callArgs = callOpenAI.mock.calls[0][0];
    expect(callArgs.apiKey).toBe("sk-test-key");
    expect(callArgs.model).toBe("gpt-4o-mini");
    expect(callArgs.inputText).toContain("add tests");
  });
});
