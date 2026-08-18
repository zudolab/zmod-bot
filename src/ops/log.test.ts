import { afterEach, describe, expect, it, vi } from "vitest";
import {
  errorSnippet,
  log,
  logLlmCall,
  logLlmError,
  MAX_LOG_SNIPPET_LENGTH,
  redactCredentials,
  redactSnippet,
} from "./log";

afterEach(() => {
  vi.restoreAllMocks();
});

function captured(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("redactCredentials", () => {
  it.each([
    ["sk-ant-api03-AbCd_1234-XYZ", "an Anthropic key"],
    ["xoxb-1234567890-abcdefg", "a Slack bot token"],
    ["xapp-1-A01-999-deadbeef", "a Slack app token"],
    ["ghp_abcdefghijklmnopqrstuvwxyz1234567890", "a classic GitHub PAT"],
    ["github_pat_11ABCDEF_abcdefghijklmnopqrstuvwxyz", "a fine-grained GitHub PAT"],
    ["Bearer eyJhbGciOi.J9.sig-Value", "a bearer header value"],
  ])("masks %s (%s)", (credential) => {
    const masked = redactCredentials(`upstream said: ${credential} is invalid`);
    expect(masked).not.toContain(credential);
    expect(masked).toContain("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactCredentials("rate_limit_error: slow down")).toBe("rate_limit_error: slow down");
  });
});

describe("redactSnippet", () => {
  it("hard-truncates past the cap and marks it", () => {
    const long = "x".repeat(MAX_LOG_SNIPPET_LENGTH + 50);

    const snippet = redactSnippet(long);

    expect(snippet).toContain("(truncated)");
    expect(snippet.startsWith("x".repeat(MAX_LOG_SNIPPET_LENGTH))).toBe(true);
    expect(snippet.length).toBeLessThan(long.length);
  });

  it("keeps a short string intact and collapses whitespace", () => {
    expect(redactSnippet("  rate limit\n  hit  ")).toBe("rate limit hit");
  });

  it("masks a credential before truncation, so no usable prefix survives", () => {
    const key = "sk-ant-api03-SECRETSECRETSECRET";

    const snippet = redactSnippet(`${key} ${"tail".repeat(200)}`);

    expect(snippet).not.toContain("sk-ant-");
    expect(snippet).toContain("[redacted]");
  });

  it("describes a non-string by type rather than serializing it", () => {
    // Serializing an unknown object is exactly how a response body ends
    // up in a log line by accident.
    expect(redactSnippet({ prompt: "顧客の本文" })).toBe("[object]");
    expect(redactSnippet(null)).toBe("null");
    expect(redactSnippet(undefined)).toBe("undefined");
    expect(redactSnippet(42)).toBe("42");
  });
});

describe("errorSnippet", () => {
  it("names the error and keeps the message short", () => {
    expect(errorSnippet(new TypeError("network unreachable"))).toBe("TypeError: network unreachable");
  });

  it("handles a thrown non-error", () => {
    expect(errorSnippet("plain string throw")).toBe("plain string throw");
    expect(errorSnippet({ weird: true })).toBe("[object]");
  });

  it("masks a credential inside an error message", () => {
    const snippet = errorSnippet(new Error("bad key sk-ant-api03-LEAKED"));
    expect(snippet).not.toContain("LEAKED");
  });
});

describe("log", () => {
  it("emits one JSON line with the level and message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    log("info", "llm.call", { provider: "claude", tokensOut: 12, truncated: false });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(captured(spy))).toEqual({
      level: "info",
      msg: "llm.call",
      provider: "claude",
      tokensOut: 12,
      truncated: false,
    });
  });

  it("routes each level to its own console method", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    log("debug", "d");
    log("info", "i");
    log("warn", "w");
    log("error", "e");

    expect(debug).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("drops undefined fields instead of emitting nulls", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    log("info", "llm.call", { provider: "claude", tokensIn: undefined });

    expect(JSON.parse(captured(spy))).toEqual({ level: "info", msg: "llm.call", provider: "claude" });
  });

  it("does not let a field overwrite the envelope's own keys", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    log("info", "llm.call", { level: "debug", msg: "spoofed", provider: "claude" });

    expect(JSON.parse(captured(spy))).toEqual({ level: "info", msg: "llm.call", provider: "claude" });
  });

  it("truncates and masks string field values, so a careless caller leaks a fragment at worst", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const prompt = "顧客の本文".repeat(100);

    log("info", "oops", { slipped: prompt, key: "sk-ant-api03-SECRET" });

    const line = captured(spy);
    expect(line).not.toContain(prompt);
    expect(line).not.toContain("sk-ant-");
    expect(line).toContain("(truncated)");
  });
});

describe("logLlmCall / logLlmError", () => {
  it("logs the diagnostic fields that make a silent cap-hit visible", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logLlmCall({
      provider: "workers-ai",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      tokensIn: 100,
      tokensOut: 256,
      stopReason: "unknown",
      truncated: true,
    });

    expect(JSON.parse(captured(spy))).toEqual({
      level: "info",
      msg: "llm.call",
      provider: "workers-ai",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      tokensIn: 100,
      tokensOut: 256,
      stopReason: "unknown",
      truncated: true,
    });
  });

  it("snippets the error and keeps the status", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logLlmError({
      provider: "claude",
      model: "claude-haiku-4-5",
      status: 401,
      error: new Error(`invalid x-api-key sk-ant-api03-SECRET ${"pad".repeat(200)}`),
    });

    const parsed = JSON.parse(captured(spy)) as Record<string, unknown>;
    expect(parsed.level).toBe("error");
    expect(parsed.status).toBe(401);
    expect(String(parsed.error)).not.toContain("sk-ant-");
    expect(String(parsed.error)).toContain("(truncated)");
  });
});
