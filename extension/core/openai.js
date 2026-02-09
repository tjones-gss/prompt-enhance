// core/openai.js
// Minimal OpenAI client (no dependencies).
//
// Supports:
// - Responses API (preferred for new integrations)
// - Chat Completions API (fallback)

const https = require("https");
const http = require("http");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

/**
 * Structured error for OpenAI API failures.
 * Callers can inspect `.status`, `.code`, and `.retryable` to decide how to
 * surface the error to the user or whether to retry.
 */
class OpenAIError extends Error {
  /**
   * @param {string} message - Human-readable error message.
   * @param {Object} [opts]
   * @param {number} [opts.status] - HTTP status code.
   * @param {string} [opts.code] - Machine-readable error code (e.g. "auth_error").
   * @param {boolean} [opts.retryable=false] - Whether the caller should retry.
   * @param {Object} [opts.body] - Raw response body for debugging.
   */
  constructor(message, { status, code, retryable, body } = {}) {
    super(message);
    this.name = "OpenAIError";
    this.status = status;
    this.code = code;
    this.retryable = retryable ?? false;
    this.body = body;
  }
}

/**
 * Map an HTTP status code + response body into a user-friendly OpenAIError.
 * @param {number} status - HTTP status code.
 * @param {Object} json - Parsed response body.
 * @returns {OpenAIError}
 */
function toOpenAIError(status, json) {
  const raw = JSON.stringify(json).slice(0, 500);

  if (status === 401 || status === 403) {
    return new OpenAIError(
      "Authentication failed. Check your API key in Prompt Enhancer settings.",
      { status, code: "auth_error", retryable: false, body: json }
    );
  }
  if (status === 429) {
    return new OpenAIError(
      "Rate limit exceeded. The request will be retried automatically.",
      { status, code: "rate_limit", retryable: true, body: json }
    );
  }
  if (status >= 500) {
    return new OpenAIError(
      `Server error (HTTP ${status}). The request will be retried automatically.`,
      { status, code: "server_error", retryable: true, body: json }
    );
  }
  if (status === 404) {
    return new OpenAIError(
      `Endpoint not found (HTTP 404). Check your baseUrl and model name. ${raw}`,
      { status, code: "not_found", retryable: false, body: json }
    );
  }

  return new OpenAIError(
    `HTTP ${status}: ${raw}`,
    { status, code: "api_error", retryable: false, body: json }
  );
}

// ---------------------------------------------------------------------------
// URL Validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalize an OpenAI-compatible base URL.
 * @param {string} url - The raw base URL string.
 * @returns {URL} Parsed URL object.
 * @throws {OpenAIError} If the URL is malformed or uses an unsupported protocol.
 */
function validateBaseUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new OpenAIError(
        `openaiBaseUrl must use http: or https: protocol, got "${parsed.protocol}"`,
        { code: "invalid_config" }
      );
    }
    return parsed;
  } catch (e) {
    if (e instanceof OpenAIError) throw e;
    throw new OpenAIError(
      `Invalid openaiBaseUrl "${url}": ${e.message}`,
      { code: "invalid_config" }
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP Helpers
// ---------------------------------------------------------------------------

/**
 * @returns {boolean} Whether the global `fetch` API is available.
 */
function hasFetch() {
  return typeof fetch === "function";
}

/**
 * Low-level HTTPS/HTTP request using Node built-ins.
 * Supports abort signal to cancel in-flight requests.
 *
 * @param {string} urlStr - Full URL.
 * @param {Object} options - Request options (method, headers).
 * @param {string} bodyStr - Request body.
 * @param {AbortSignal} [abortSignal] - Optional abort signal.
 * @returns {Promise<Object>} Parsed JSON response.
 */
function httpsJson(urlStr, options, bodyStr, abortSignal) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        method: options.method || "GET",
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        headers: options.headers || {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            json = { _raw: data };
          }
          if (status >= 200 && status < 300) resolve(json);
          else reject(toOpenAIError(status, json));
        });
      }
    );

    // Wire up abort signal
    if (abortSignal) {
      if (abortSignal.aborted) {
        req.destroy();
        reject(new OpenAIError("Request aborted.", { code: "aborted" }));
        return;
      }
      const onAbort = () => {
        req.destroy();
        reject(new OpenAIError("Request aborted.", { code: "aborted" }));
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => abortSignal.removeEventListener("abort", onAbort));
    }

    req.on("error", (e) => {
      if (abortSignal?.aborted) {
        reject(new OpenAIError("Request aborted.", { code: "aborted" }));
      } else {
        reject(new OpenAIError(`Network error: ${e.message}`, { code: "network_error", retryable: true }));
      }
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Make an HTTP request, preferring the global `fetch` API when available,
 * falling back to Node built-in https/http.
 *
 * @param {string} urlStr - Full URL.
 * @param {Object} options - Fetch-compatible options.
 * @param {AbortSignal} [abortSignal] - Optional abort signal.
 * @returns {Promise<Object>} Parsed JSON response.
 */
async function fetchJson(urlStr, options, abortSignal) {
  if (hasFetch()) {
    const fetchOpts = { ...options };
    if (abortSignal) fetchOpts.signal = abortSignal;

    let res;
    try {
      res = await fetch(urlStr, fetchOpts);
    } catch (e) {
      if (abortSignal?.aborted) {
        throw new OpenAIError("Request aborted.", { code: "aborted" });
      }
      throw new OpenAIError(`Network error: ${e.message}`, { code: "network_error", retryable: true });
    }

    const json = await res.json().catch(async () => ({ _raw: await res.text().catch(() => "") }));
    if (!res.ok) throw toOpenAIError(res.status, json);
    return json;
  }

  const bodyStr = options.body ? String(options.body) : "";
  return httpsJson(urlStr, options, bodyStr, abortSignal);
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Retry a function on transient (retryable) errors with exponential backoff.
 *
 * @param {() => Promise<T>} fn - The async function to execute.
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries=1] - Maximum number of retries.
 * @param {AbortSignal} [opts.abortSignal] - Abort signal to cancel retries.
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry(fn, { maxRetries = 1, abortSignal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isRetryable = e instanceof OpenAIError && e.retryable;
      if (!isRetryable || attempt >= maxRetries) throw e;
      if (abortSignal?.aborted) throw e;
      // Exponential backoff: 1s, 2s, ...
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Response Parsing
// ---------------------------------------------------------------------------

/**
 * Extract the text content from an OpenAI Responses API JSON result.
 * @param {Object} json - Raw API response.
 * @returns {string} Extracted text, or empty string if not found.
 */
function extractTextFromResponsesApi(json) {
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text;
  }

  let out = "";
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (!item) continue;

      const content = item.content;
      if (typeof content === "string") {
        out += content;
        continue;
      }

      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c) continue;
          if (typeof c.text === "string") out += c.text;
          else if (typeof c.output_text === "string") out += c.output_text;
          else if (c.type === "output_text" && typeof c.text === "string") out += c.text;
        }
      }
    }
  }

  if (out.trim()) return out;

  // Fallback: if this is actually a chat completion response, try that too.
  if (json?.choices?.[0]?.message?.content) return json.choices[0].message.content;

  return "";
}

// ---------------------------------------------------------------------------
// Main API Call
// ---------------------------------------------------------------------------

/**
 * Call an OpenAI-compatible API to generate text.
 *
 * Tries the Responses API first, then falls back to Chat Completions.
 * Automatically retries on transient (429/5xx) errors.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey - Bearer token.
 * @param {string} opts.baseUrl - API base URL (e.g. "https://api.openai.com").
 * @param {string} opts.model - Model identifier.
 * @param {string} opts.inputText - The combined prompt text.
 * @param {number} [opts.temperature=0.2] - Sampling temperature.
 * @param {AbortSignal} [opts.abortSignal] - Signal to abort the request.
 * @returns {Promise<string>} The generated text.
 * @throws {OpenAIError} On API failure after retries.
 */
async function callOpenAI({ apiKey, baseUrl, model, inputText, temperature = 0.2, abortSignal }) {
  const base = (baseUrl || "https://api.openai.com").replace(/\/+$/, "");
  validateBaseUrl(base);

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };

  // 1) Try Responses API (with retry)
  try {
    const text = await withRetry(async () => {
      const body = JSON.stringify({ model, input: inputText, temperature });
      const json = await fetchJson(`${base}/v1/responses`, { method: "POST", headers, body }, abortSignal);
      const extracted = extractTextFromResponsesApi(json);
      if (extracted && extracted.trim()) return extracted.trim();
      // Empty response isn't an error -- just fall through to chat completions
      return null;
    }, { maxRetries: 1, abortSignal });

    if (text) return text;
  } catch (e) {
    // If it's a 404, the provider doesn't support Responses API -- fall through.
    // For auth errors or aborted, rethrow immediately.
    if (e instanceof OpenAIError && (e.code === "auth_error" || e.code === "aborted")) throw e;
    // Otherwise swallow and fall back to chat completions.
  }

  // 2) Fallback: Chat Completions (with retry)
  const text = await withRetry(async () => {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: inputText }],
      temperature,
    });
    const json = await fetchJson(`${base}/v1/chat/completions`, { method: "POST", headers, body }, abortSignal);
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      throw new OpenAIError(
        `Could not extract text from response: ${JSON.stringify(json).slice(0, 500)}`,
        { code: "parse_error" }
      );
    }
    return String(content).trim();
  }, { maxRetries: 1, abortSignal });

  return text;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  OpenAIError,
  callOpenAI,
};
