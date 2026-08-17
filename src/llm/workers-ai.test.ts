import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkersAiProvider,
  looksTruncated,
  readWorkersAiText,
  WORKERS_AI_MODEL,
  type WorkersAiDeps,
} from "./workers-ai";
import type { LlmRequest } from "./provider";

interface FakeAiCall {
  model: string;
  inputs: Record<string, unknown>;
  options: unknown;
}

/**
 * Records every `AI.run` call and answers with a queued envelope. Cast to
 * `Ai` at the boundary — the binding is an abstract class with a dozen
 * unrelated members, and the adapter only ever touches `run`.
 */
function createFakeAi(outputs: unknown[]): { ai: Ai; calls: FakeAiCall[] } {
  const calls: FakeAiCall[] = [];
  let index = 0;
  const ai = {
    run: async (model: string, inputs: Record<string, unknown>, options?: unknown) => {
      calls.push({ model, inputs, options });
      const output = outputs[Math.min(index, outputs.length - 1)];
      index++;
      return output;
    },
  } as unknown as Ai;
  return { ai, calls };
}

function createThrowingAi(error: unknown): { ai: Ai; calls: FakeAiCall[] } {
  const calls: FakeAiCall[] = [];
  const ai = {
    run: async (model: string, inputs: Record<string, unknown>, options?: unknown) => {
      calls.push({ model, inputs, options });
      throw error;
    },
  } as unknown as Ai;
  return { ai, calls };
}

const request: LlmRequest = { system: "you are a helper", user: "compose a section", maxTokens: 700 };

function envelope(response: unknown, usage?: Record<string, number>): Record<string, unknown> {
  return usage ? { response, usage } : { response };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWorkersAiProvider", () => {
  it("always sends max_tokens, and sends the pinned model with system + user messages", async () => {
    const { ai, calls } = createFakeAi([envelope("done", { prompt_tokens: 40, completion_tokens: 61 })]);

    const result = await createWorkersAiProvider({ ai }).run(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(WORKERS_AI_MODEL);
    // The trap this whole adapter exists for: no max_tokens means a
    // silent 256-token cap and truncated prose, never an error.
    expect(calls[0]?.inputs.max_tokens).toBe(700);
    expect(calls[0]?.inputs.messages).toEqual([
      { role: "system", content: "you are a helper" },
      { role: "user", content: "compose a section" },
    ]);
    expect(result.text).toBe("done");
    expect(result.model).toBe(WORKERS_AI_MODEL);
    expect(result.tokensIn).toBe(40);
    expect(result.tokensOut).toBe(61);
    expect(result.truncated).toBe(false);
    expect(result.stopReason).toBe("unknown");
  });

  it("omits the system message when the system prompt is blank", async () => {
    const { ai, calls } = createFakeAi([envelope("done")]);

    await createWorkersAiProvider({ ai }).run({ ...request, system: "   " });

    expect(calls[0]?.inputs.messages).toEqual([{ role: "user", content: "compose a section" }]);
  });

  it("never passes a gateway option — an unprovisioned named gateway is CF error 2001 on every call", async () => {
    const { ai, calls } = createFakeAi([envelope("done")]);

    await createWorkersAiProvider({ ai }).run(request);

    expect(calls[0]?.options).toBeUndefined();
  });

  it("passes an abort signal through as the only option", async () => {
    const { ai, calls } = createFakeAi([envelope("done")]);
    const controller = new AbortController();

    await createWorkersAiProvider({ ai }).run({ ...request, signal: controller.signal });

    expect(calls[0]?.options).toEqual({ signal: controller.signal });
    expect(Object.keys(calls[0]?.options as object)).toEqual(["signal"]);
  });

  it("throws and never calls AI.run when maxTokens is missing", async () => {
    const { ai, calls } = createFakeAi([envelope("done")]);
    // Required at the type level (see the @ts-expect-error case below);
    // this proves the runtime guard holds for an untyped caller too — a
    // JSON job payload, a JSON.parse result.
    const untyped = { system: "s", user: "u" } as unknown as LlmRequest;

    await expect(createWorkersAiProvider({ ai }).run(untyped)).rejects.toThrow(/maxTokens is required/);
    expect(calls).toHaveLength(0);
  });

  it.each([0, -1, 1.5, Number.NaN, "700"])("rejects maxTokens %p before calling AI.run", async (maxTokens) => {
    const { ai, calls } = createFakeAi([envelope("done")]);
    const bad = { ...request, maxTokens } as unknown as LlmRequest;

    await expect(createWorkersAiProvider({ ai }).run(bad)).rejects.toThrow(/maxTokens is required/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a blank user prompt before calling AI.run", async () => {
    const { ai, calls } = createFakeAi([envelope("done")]);

    await expect(createWorkersAiProvider({ ai }).run({ ...request, user: "  " })).rejects.toThrow(
      /user prompt is required/,
    );
    expect(calls).toHaveLength(0);
  });

  it("does not typecheck without maxTokens", async () => {
    const { ai } = createFakeAi([envelope("done")]);
    // @ts-expect-error maxTokens is required — this line failing to error is itself a regression.
    const req: LlmRequest = { system: "s", user: "u" };
    expect(typeof createWorkersAiProvider({ ai }).run).toBe("function");
    expect(req.system).toBe("s");
  });

  it("keeps the whole envelope, usage included, in raw", async () => {
    const raw = envelope("done", { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 });
    const { ai } = createFakeAi([raw]);

    const result = await createWorkersAiProvider({ ai }).run(request);

    expect(result.raw).toEqual(raw);
    expect((result.raw as { usage: unknown }).usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
    });
  });

  it("flags a cap-hit envelope as truncated", async () => {
    const { ai } = createFakeAi([envelope("cut off mid-", { completion_tokens: 700 })]);

    const result = await createWorkersAiProvider({ ai }).run(request);

    expect(result.truncated).toBe(true);
  });

  it("wraps a binding failure in a typed provider error", async () => {
    const { ai } = createThrowingAi(new Error("capacity"));

    await expect(createWorkersAiProvider({ ai }).run(request)).rejects.toMatchObject({
      name: "LlmProviderError",
      provider: "workers-ai",
    });
  });
});

describe("looksTruncated", () => {
  it("treats a round completion_tokens as a cap hit", () => {
    expect(looksTruncated({ usage: { completion_tokens: 256 } })).toBe(true);
    expect(looksTruncated({ usage: { completion_tokens: 512 } })).toBe(true);
    expect(looksTruncated({ usage: { completion_tokens: 1024 } })).toBe(true);
  });

  it("treats a non-round completion_tokens as real model output", () => {
    expect(looksTruncated({ usage: { completion_tokens: 247 } })).toBe(false);
    expect(looksTruncated({ usage: { completion_tokens: 61 } })).toBe(false);
  });

  it("treats reaching the requested budget as a cap hit even when the number is not round", () => {
    expect(looksTruncated({ usage: { completion_tokens: 700 } }, 700)).toBe(true);
    expect(looksTruncated({ usage: { completion_tokens: 699 } }, 700)).toBe(false);
  });

  it("is false when the envelope reports no usage at all", () => {
    expect(looksTruncated({ response: "text" })).toBe(false);
    expect(looksTruncated({ usage: {} })).toBe(false);
    expect(looksTruncated(undefined)).toBe(false);
    expect(looksTruncated("bare string output")).toBe(false);
  });
});

describe("readWorkersAiText", () => {
  const payload = { section: ["a", "b"], note: "text" };

  it("accepts response as a JSON string", () => {
    const text = readWorkersAiText({ response: JSON.stringify(payload) });
    expect(JSON.parse(text)).toEqual(payload);
  });

  it("accepts response as an already-parsed object", () => {
    const text = readWorkersAiText({ response: payload });
    expect(JSON.parse(text)).toEqual(payload);
  });

  it("accepts a bare string envelope", () => {
    expect(readWorkersAiText("plain")).toBe("plain");
  });

  it("throws a typed provider error on an unreadable envelope", () => {
    expect(() => readWorkersAiText({ usage: { completion_tokens: 5 } })).toThrow(/unreadable response envelope/);
    expect(() => readWorkersAiText(42)).toThrow(/unreadable response envelope/);
  });

  it("round-trips both response_format shapes through the adapter", async () => {
    const asString = createFakeAi([{ response: JSON.stringify(payload) }]);
    const asObject = createFakeAi([{ response: payload }]);

    const fromString = await createWorkersAiProvider({ ai: asString.ai }).run(request);
    const fromObject = await createWorkersAiProvider({ ai: asObject.ai }).run(request);

    expect(JSON.parse(fromString.text)).toEqual(payload);
    expect(JSON.parse(fromObject.text)).toEqual(payload);
  });
});

describe("workers-ai logging", () => {
  it("logs the model and token counts but never the prompt or the completion", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const secretPrompt = "お客様の商品説明本文";
    const secretCompletion = "生成された返信本文";
    const { ai } = createFakeAi([envelope(secretCompletion, { prompt_tokens: 11, completion_tokens: 22 })]);

    await createWorkersAiProvider({ ai }).run({ system: secretPrompt, user: secretPrompt, maxTokens: 300 });

    const logged = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(WORKERS_AI_MODEL);
    expect(logged).toContain('"tokensOut":22');
    expect(logged).not.toContain(secretPrompt);
    expect(logged).not.toContain(secretCompletion);
  });

  it("logs a binding failure without leaking the prompt", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const secretPrompt = "お客様の商品説明本文";
    const { ai } = createThrowingAi(new Error("upstream exploded"));

    await expect(
      createWorkersAiProvider({ ai }).run({ system: "", user: secretPrompt, maxTokens: 300 }),
    ).rejects.toThrow();

    const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("upstream exploded");
    expect(logged).not.toContain(secretPrompt);
  });
});
