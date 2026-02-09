const { OpenAIError } = require("../openai");

// ---------------------------------------------------------------------------
// OpenAIError
// ---------------------------------------------------------------------------

describe("OpenAIError", () => {
  test("is an instance of Error", () => {
    const err = new OpenAIError("test error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OpenAIError);
  });

  test("stores message correctly", () => {
    const err = new OpenAIError("something went wrong");
    expect(err.message).toBe("something went wrong");
  });

  test("has name set to OpenAIError", () => {
    const err = new OpenAIError("test");
    expect(err.name).toBe("OpenAIError");
  });

  test("stores optional properties", () => {
    const body = { error: { message: "bad key" } };
    const err = new OpenAIError("auth failed", {
      status: 401,
      code: "auth_error",
      retryable: false,
      body,
    });
    expect(err.status).toBe(401);
    expect(err.code).toBe("auth_error");
    expect(err.retryable).toBe(false);
    expect(err.body).toBe(body);
  });

  test("defaults retryable to false", () => {
    const err = new OpenAIError("test");
    expect(err.retryable).toBe(false);
  });

  test("retryable can be set to true", () => {
    const err = new OpenAIError("rate limit", {
      status: 429,
      code: "rate_limit",
      retryable: true,
    });
    expect(err.retryable).toBe(true);
  });

  test("has a useful stack trace", () => {
    const err = new OpenAIError("stack check");
    expect(err.stack).toBeTruthy();
    expect(err.stack).toContain("OpenAIError");
  });

  test("handles missing opts gracefully", () => {
    const err = new OpenAIError("no opts");
    expect(err.status).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(err.body).toBeUndefined();
  });
});
