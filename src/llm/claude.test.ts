import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../types";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  createClaudeProvider,
  DEFAULT_CLAUDE_MODEL,
  type ClaudeProviderDeps,
} from "./claude";
import type { LlmRequest } from "./provider";

interface FakeFetchCall {
  url: string;
  init?: RequestInit;
}

interface FakeResponseSpec {
  status: number;
  /** JSON body. Mutually exclusive with `text`. */
  body?: unknown;
  /** Raw text body — used for error bodies and malformed-JSON cases. */
  text?: string;
}

function createFakeFetch(responses: FakeResponseSpec[]): { fetch: FetchLike; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const spec = responses[Math.min(index, responses.length - 1)];
    index++;
    if (!spec) throw new Error("createFakeFetch: no response spec configured");
    const responseText = spec.text ?? (spec.body !== undefined ? JSON.stringify(spec.body) : "");
    return new Response(responseText, { status: spec.status });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

const API_KEY = "sk-ant-test-000111222";

const request: LlmRequest = { system: "you write JA prose", user: "author a reference", maxTokens: 800 };

function messageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20260101",
    content: [{ type: "text", text: "本文です" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 45 },
    ...overrides,
  };
}

function deps(overrides: Partial<ClaudeProviderDeps> & { fetch: FetchLike }): ClaudeProviderDeps {
  return { apiKey: API_KEY, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createClaudeProvider", () => {
  it("POSTs the messages endpoint with the pinned headers and a minimal body", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: messageBody() }]);

    const result = await createClaudeProvider(deps({ fetch })).run(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ANTHROPIC_MESSAGES_URL);
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers["content-type"]).toBe("application/json");

    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sent.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(sent.max_tokens).toBe(800);
    expect(sent.system).toBe("you write JA prose");
    expect(sent.messages).toEqual([{ role: "user", content: "author a reference" }]);

    expect(result.text).toBe("本文です");
    // The served model, not the requested one — a silent server-side
    // substitution should be visible in the result.
    expect(result.model).toBe("claude-haiku-4-5-20260101");
    expect(result.tokensIn).toBe(120);
    expect(result.tokensOut).toBe(45);
    expect(result.stopReason).toBe("end");
    expect(result.truncated).toBe(false);
    expect(result.raw).toEqual(messageBody());
  });

  it("sends none of the sampling params current models reject", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: messageBody() }]);

    await createClaudeProvider(deps({ fetch })).run(request);

    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    for (const key of ["temperature", "top_p", "top_k", "thinking", "stream", "tools"]) {
      expect(sent).not.toHaveProperty(key);
    }
    expect(Object.keys(sent).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
  });

  it("omits system entirely when the system prompt is blank", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: messageBody() }]);

    await createClaudeProvider(deps({ fetch })).run({ ...request, system: "" });

    const sent = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(sent).not.toHaveProperty("system");
  });

  it("uses the configured model so the tier can be raised without a code change", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: messageBody({ model: undefined }) }]);

    const result = await createClaudeProvider(deps({ fetch, model: "claude-sonnet-5" })).run(request);

    expect(JSON.parse(String(calls[0]?.init?.body)).model).toBe("claude-sonnet-5");
    // Response carried no model — fall back to what we asked for.
    expect(result.model).toBe("claude-sonnet-5");
  });

  it("falls back to the default model when the var is blank", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: messageBody() }]);

    await createClaudeProvider(deps({ fetch, model: "   " })).run(request);

    expect(JSON.parse(String(calls[0]?.init?.body)).model).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it("passes the abort signal to fetch", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: messageBody() }]);
    const controller = new AbortController();

    await createClaudeProvider(deps({ fetch })).run({ ...request, signal: controller.signal });

    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it("returns a typed refusal instead of throwing, and does not read content", async () => {
    const { fetch } = createFakeFetch([
      { status: 200, body: messageBody({ stop_reason: "refusal", content: [] }) },
    ]);

    const result = await createClaudeProvider(deps({ fetch })).run(request);

    expect(result.stopReason).toBe("refusal");
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.tokensOut).toBe(45);
  });

  it("survives a refusal whose content field is missing entirely", async () => {
    const { fetch } = createFakeFetch([
      { status: 200, body: messageBody({ stop_reason: "refusal", content: undefined }) },
    ]);

    const result = await createClaudeProvider(deps({ fetch })).run(request);

    expect(result.stopReason).toBe("refusal");
    expect(result.text).toBe("");
  });

  it("flags stop_reason max_tokens as truncated and still returns the partial text", async () => {
    const { fetch } = createFakeFetch([
      {
        status: 200,
        body: messageBody({ stop_reason: "max_tokens", content: [{ type: "text", text: "途中で" }] }),
      },
    ]);

    const result = await createClaudeProvider(deps({ fetch })).run(request);

    expect(result.truncated).toBe(true);
    expect(result.stopReason).toBe("max_tokens");
    expect(result.text).toBe("途中で");
  });

  it("maps an unrecognised stop_reason to unknown rather than crashing", async () => {
    const { fetch } = createFakeFetch([{ status: 200, body: messageBody({ stop_reason: "pause_turn" }) }]);

    const result = await createClaudeProvider(deps({ fetch })).run(request);

    expect(result.stopReason).toBe("unknown");
    expect(result.text).toBe("本文です");
  });

  it("concatenates text blocks and ignores block types we never requested", async () => {
    const { fetch } = createFakeFetch([
      {
        status: 200,
        body: messageBody({
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "前半" },
            { type: "text", text: "後半" },
          ],
        }),
      },
    ]);

    const result = await createClaudeProvider(deps({ fetch })).run(request);

    expect(result.text).toBe("前半後半");
  });

  it("throws a named configuration error and never calls fetch when the key is missing", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: messageBody() }]);

    for (const apiKey of ["", "   "]) {
      await expect(createClaudeProvider(deps({ fetch, apiKey })).run(request)).rejects.toMatchObject({
        name: "LlmConfigurationError",
        message: expect.stringContaining("ANTHROPIC_API_KEY"),
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("throws and never calls fetch when maxTokens is missing", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: messageBody() }]);
    const untyped = { system: "s", user: "u" } as unknown as LlmRequest;

    await expect(createClaudeProvider(deps({ fetch })).run(untyped)).rejects.toThrow(/maxTokens is required/);
    expect(calls).toHaveLength(0);
  });

  it("raises a typed provider error carrying the HTTP status", async () => {
    const { fetch } = createFakeFetch([
      { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } },
    ]);

    await expect(createClaudeProvider(deps({ fetch })).run(request)).rejects.toMatchObject({
      name: "LlmProviderError",
      provider: "claude",
      status: 429,
    });
  });

  it("raises a typed provider error when the transport itself fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network unreachable");
    }) as FetchLike;

    await expect(createClaudeProvider(deps({ fetch: fetchImpl })).run(request)).rejects.toMatchObject({
      name: "LlmProviderError",
      provider: "claude",
    });
  });

  it("raises a typed provider error on an unreadable body", async () => {
    const { fetch } = createFakeFetch([{ status: 200, text: "not json at all" }]);

    await expect(createClaudeProvider(deps({ fetch })).run(request)).rejects.toThrow(/unreadable response body/);
  });

  it("raises a typed provider error when content is not an array on a non-refusal", async () => {
    const { fetch } = createFakeFetch([{ status: 200, body: messageBody({ content: "本文です" }) }]);

    await expect(createClaudeProvider(deps({ fetch })).run(request)).rejects.toThrow(/content was not an array/);
  });
});

describe("claude logging", () => {
  it("logs the model and token counts but never the prompt, the completion, or the key", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const secretPrompt = "お客様の商品説明本文";
    const secretCompletion = "生成された返信本文";
    const { fetch } = createFakeFetch([
      { status: 200, body: messageBody({ content: [{ type: "text", text: secretCompletion }] }) },
    ]);

    await createClaudeProvider(deps({ fetch })).run({
      system: secretPrompt,
      user: secretPrompt,
      maxTokens: 800,
    });

    const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("claude-haiku-4-5-20260101");
    expect(logged).toContain('"tokensIn":120');
    expect(logged).not.toContain(secretPrompt);
    expect(logged).not.toContain(secretCompletion);
    expect(logged).not.toContain(API_KEY);
  });

  it("redacts an API key echoed back inside an upstream error body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetch } = createFakeFetch([
      { status: 401, text: `{"error":{"message":"invalid x-api-key ${API_KEY}"}}` },
    ]);

    let caught: unknown;
    try {
      await createClaudeProvider(deps({ fetch })).run(request);
    } catch (thrown) {
      caught = thrown;
    }

    const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("401");
    expect(logged).not.toContain(API_KEY);
    // The thrown error travels to the caller's own logger — it must be clean too.
    expect(String((caught as Error).message)).not.toContain(API_KEY);
    expect(String((caught as Error).message)).toContain("[redacted]");
  });

  it("does not log the parser's quoted bytes when a 200 body is not JSON", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // A 200 whose body is malformed still contains the model's
    // completion — the JSON parser quotes it back inside its own message.
    const secretCompletion = "生成された返信本文";
    const { fetch } = createFakeFetch([{ status: 200, text: `not json ${secretCompletion}` }]);

    await expect(createClaudeProvider(deps({ fetch })).run(request)).rejects.toThrow(/invalid JSON/);

    const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("not valid JSON");
    expect(logged).not.toContain(secretCompletion);
  });

  it("truncates a long upstream error body instead of logging all of it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const longBody = `overload: ${"顧客の本文".repeat(200)}`;
    const { fetch } = createFakeFetch([{ status: 529, text: longBody }]);

    await expect(createClaudeProvider(deps({ fetch })).run(request)).rejects.toThrow();

    const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("overload");
    expect(logged).toContain("(truncated)");
    expect(logged.length).toBeLessThan(longBody.length);
  });
});
