/**
 * Polish mode end to end (issue #16): provider selection, the reused
 * guard envelope (src/llm/guards.ts, driven the same way
 * src/reply/compose.ts drives it — see tests/compose/compose.test.ts for
 * the sibling matrix this mirrors), the length-cap pre-flight check, and
 * the machine-testable preservation assertions.
 *
 * Every provider is a fake — no network, per CLAUDE.md dependency
 * injection convention.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockD1, type MockD1 } from "../../src/db/test-support";
import type { Env } from "../../src/env";
import {
  computePolishDeadlineMs,
  computePolishMaxTokens,
  CONTEXT_SAFETY_MARGIN_TOKENS,
  MAX_POLISH_INPUT_CHARS,
  MODEL_CONTEXT_TOKENS,
  POLISH_MAX_DEADLINE_MS,
  POLISH_MIN_DEADLINE_MS,
  POLISH_MIN_MAX_TOKENS,
  polishText,
  PROMPT_OVERHEAD_TOKENS,
  TOKENS_PER_CHAR,
  type PolishDeps,
} from "../../src/reply/polish";
import type { FetchLike } from "../../src/types";

/* -------------------------------------------------------------------------
 * Fixture text — deliberately shaped so each preservation check can be
 * broken in isolation (see the comments on each BROKEN_* constant below).
 * ---------------------------------------------------------------------- */

const INPUT_LINES = [
  "ご注文ありがとうございます。",
  "",
  "商品の到着予定日は明日です。",
  "",
  // The duplicate URL is inline on one line (not one URL per line) so
  // that dropping one occurrence doesn't also change the line/paragraph
  // count — that isolation is the point of the "multiset, not set" tests
  // below.
  "詳しくはこちらをご確認ください: https://takazudomodular.com/products/example-intro/ https://takazudomodular.com/products/example-intro/",
];
const INPUT_TEXT = INPUT_LINES.join("\n");

const FAITHFUL_OUTPUT_TEXT = [
  "ご注文いただきありがとうございます。",
  "",
  "商品の到着予定日は明日です。",
  "",
  "詳しくはこちらをご確認ください: https://takazudomodular.com/products/example-intro/ https://takazudomodular.com/products/example-intro/",
].join("\n");

/** Same shape as FAITHFUL_OUTPUT_TEXT, but the inline duplicate URL is collapsed to one occurrence — same line/paragraph/newline counts, different URL *count*. */
const BROKEN_URL_MULTISET_TEXT = [
  "ご注文いただきありがとうございます。",
  "",
  "商品の到着予定日は明日です。",
  "",
  "詳しくはこちらをご確認ください: https://takazudomodular.com/products/example-intro/",
].join("\n");

/** Same URLs, one fewer line break than FAITHFUL_OUTPUT_TEXT (the two middle lines merged). */
const BROKEN_NEWLINE_TEXT = [
  "ご注文いただきありがとうございます。 商品の到着予定日は明日です。",
  "",
  "詳しくはこちらをご確認ください: https://takazudomodular.com/products/example-intro/ https://takazudomodular.com/products/example-intro/",
].join("\n");

/**
 * The first two paragraphs of FAITHFUL_OUTPUT_TEXT merged (blank line
 * dropped), and the final line split in two with a plain (non-blank)
 * newline to keep the total newline count at 4 — same as the fixture,
 * one fewer paragraph. `polishText` trims the model's output before
 * checking, so a compensating newline can't sit at the very edge of the
 * string (trim would just strip it back off); it has to be internal,
 * which is why this isolates the paragraph check from the newline check
 * (which runs first in checkPolishPreservation and would otherwise mask
 * it) rather than the simpler "add a trailing blank line" that first
 * looks like it would work.
 */
const BROKEN_PARAGRAPH_TEXT = [
  "ご注文いただきありがとうございます。",
  "商品の到着予定日は明日です。",
  "",
  "詳しくはこちらをご確認ください:",
  "https://takazudomodular.com/products/example-intro/ https://takazudomodular.com/products/example-intro/",
].join("\n");

const BROKEN_DEGOZAIMASU_TEXT = [
  "ご注文いただきありがとうございます。",
  "",
  "商品の到着予定日は明日でございます。",
  "",
  "詳しくはこちらをご確認ください: https://takazudomodular.com/products/example-intro/ https://takazudomodular.com/products/example-intro/",
].join("\n");

/** Plain single-line, no-URL text pair for the length-ratio tests — deliberately shaped so the URL/newline/paragraph checks (which run first) never fire, isolating the ratio check itself. */
const RATIO_BASE_TEXT = "本製品はただいま大変ご好評をいただいており、入荷までにお時間をいただく場合がございます。";
const RATIO_SHORT_TEXT = "了解です。";

/* -------------------------------------------------------------------------
 * Fakes
 * ---------------------------------------------------------------------- */

interface AiCall {
  model: string;
  inputs: Record<string, unknown>;
}

/** Records `AI.run` and answers with a queued envelope, or throws. Mirrors tests/compose/compose.test.ts createFakeAi. */
function createFakeAi(
  behaviour: { text?: string; completionTokens?: number; throws?: unknown; pending?: boolean } = {},
): { ai: Ai; calls: AiCall[] } {
  const calls: AiCall[] = [];
  const ai = {
    run: async (model: string, inputs: Record<string, unknown>) => {
      calls.push({ model, inputs });
      if (behaviour.throws !== undefined) throw behaviour.throws;
      if (behaviour.pending) return new Promise(() => {});
      return {
        response: behaviour.text ?? "",
        // Deliberately not a round number — a round completion_tokens is
        // exactly what src/llm/workers-ai.ts reads as a cap hit.
        usage: { prompt_tokens: 44, completion_tokens: behaviour.completionTokens ?? 47 },
      };
    },
  } as unknown as Ai;
  return { ai, calls };
}

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

/** Records outbound HTTP and answers as the Anthropic messages API. Mirrors tests/compose/compose.test.ts createFakeFetch. */
function createFakeFetch(
  behaviour: { text?: string; stopReason?: string; status?: number } = {},
): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(input), body });
    const status = behaviour.status ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: "upstream" }), { status });
    return new Response(
      JSON.stringify({
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: behaviour.text ?? "" }],
        stop_reason: behaviour.stopReason ?? "end_turn",
        usage: { input_tokens: 44, output_tokens: 47 },
      }),
      { status: 200 },
    );
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function createEnv(over: Partial<Env> = {}): Env {
  return {
    DB: createMockD1(),
    AI: createFakeAi().ai,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SLACK_BOT_USER_ID: "U000BOT",
    SLACK_ALLOWED_CHANNEL_IDS: "C1",
    SLACK_ADMIN_USER_IDS: "U1",
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    SITE_API_BASE: "https://takazudomodular.com",
    ...over,
  };
}

/** Rows the code under test wrote to `usage_log`, read back off the recorded calls. Mirrors tests/compose/compose.test.ts usageRows. */
function usageRows(db: MockD1): Record<string, unknown>[] {
  return db.calls
    .filter((call) => call.query.includes("INSERT INTO usage_log"))
    .map(({ bindings }) => ({
      slug: bindings[0],
      task: bindings[1],
      provider: bindings[2],
      model: bindings[3],
      fallback: bindings[4],
      tokensIn: bindings[5],
      tokensOut: bindings[6],
    }));
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  const record = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "warn").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
    vi.spyOn(console, "debug").mockImplementation(record),
  ];
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------
 * Happy path
 * ---------------------------------------------------------------------- */

describe("the polished path", () => {
  it("returns the model's text, preserves structure, and logs no fallback", async () => {
    const { ai, calls } = createFakeAi({ text: FAITHFUL_OUTPUT_TEXT });
    const db = createMockD1();
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.usedFallback).toBe(false);
    expect(result.fallback).toBeNull();
    expect(result.provider).toBe("workers-ai");
    expect(result.text).toBe(FAITHFUL_OUTPUT_TEXT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.inputs.max_tokens).toBe(computePolishMaxTokens(INPUT_TEXT));
    expect(usageRows(db)).toEqual([
      expect.objectContaining({ slug: null, task: "polish", provider: "workers-ai", fallback: null }),
    ]);
  });

  it("floors max_tokens so a short input still gets room", () => {
    expect(computePolishMaxTokens("短い")).toBe(POLISH_MIN_MAX_TOKENS);
  });

  /**
   * The property that matters is not the arithmetic — it is that prompt and
   * response together fit the model's shared context window. The window is
   * 24,000 tokens and Cloudflare errors the request when it is exceeded, so
   * an input at exactly the cap must still leave room for the output it asks
   * for. The previous formula (`chars * 2 + 256`) failed this at every input
   * near the old 8,000-character cap, and failed silently: the guard trip
   * returned the text unchanged, so polish looked like it had run.
   */
  it("never requests more than the context window can hold, up to the cap", () => {
    for (const chars of [1, 100, 1_000, 2_000, MAX_POLISH_INPUT_CHARS - 1, MAX_POLISH_INPUT_CHARS]) {
      const text = "あ".repeat(chars);
      const inputTokens = Math.ceil(text.length * TOKENS_PER_CHAR);
      const total = inputTokens + computePolishMaxTokens(text) + PROMPT_OVERHEAD_TOKENS;
      expect(total, `${chars} chars overruns the context window`).toBeLessThanOrEqual(MODEL_CONTEXT_TOKENS);
    }
  });

  it("derives the input cap from the context window rather than a chosen number", () => {
    // One character past the cap must not fit, or the cap is not the real boundary.
    const overCap = "あ".repeat(MAX_POLISH_INPUT_CHARS + 1);
    const inputTokens = Math.ceil(overCap.length * TOKENS_PER_CHAR);
    const desired = Math.ceil(inputTokens * 1.5) + 256;
    expect(inputTokens + desired + PROMPT_OVERHEAD_TOKENS).toBeGreaterThan(
      MODEL_CONTEXT_TOKENS - CONTEXT_SAFETY_MARGIN_TOKENS,
    );
  });

  /**
   * Compose's 8s deadline is sized for a section built from a product
   * reference (largest in the corpus: 1,309 characters, 2048 max tokens).
   * Polish asks for many times that output, so sharing the constant would
   * trip the deadline on all but the shortest input — silently, since a trip
   * returns the input unchanged.
   */
  it("scales the deadline with the output requested, and stays inside its clamps", () => {
    const short = computePolishDeadlineMs(computePolishMaxTokens("短い"));
    const long = computePolishDeadlineMs(computePolishMaxTokens("あ".repeat(MAX_POLISH_INPUT_CHARS)));

    expect(short).toBeGreaterThanOrEqual(POLISH_MIN_DEADLINE_MS);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(POLISH_MAX_DEADLINE_MS);
    expect(short).toBeGreaterThan(8_000);
  });

  it("passes max_tokens on every call — Llama truncates silently at 256 without it", async () => {
    const { ai, calls } = createFakeAi({ text: FAITHFUL_OUTPUT_TEXT });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    await polishText(deps, { text: INPUT_TEXT });

    expect(calls[0]?.inputs.max_tokens).toBeGreaterThanOrEqual(POLISH_MIN_MAX_TOKENS);
  });

  it("never logs the polish input or output", async () => {
    const { ai } = createFakeAi({ text: FAITHFUL_OUTPUT_TEXT });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    await polishText(deps, { text: INPUT_TEXT });

    const output = logged.join("\n");
    expect(output).not.toBe("");
    for (const fragment of [
      INPUT_TEXT,
      FAITHFUL_OUTPUT_TEXT,
      "ご注文",
      "https://takazudomodular.com/products/example-intro/",
    ]) {
      expect(output).not.toContain(fragment);
    }
  });

  it("does nothing for empty/whitespace-only input — no provider call, no usage_log row", async () => {
    const { ai, calls } = createFakeAi();
    const db = createMockD1();
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: "   \n  " });

    expect(calls).toHaveLength(0);
    expect(result.usedFallback).toBe(false);
    expect(result.text).toBe("   \n  ");
    expect(usageRows(db)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * The input-cap pre-flight check
 * ---------------------------------------------------------------------- */

describe("the input-length cap", () => {
  it("refuses input over 8,000 chars without calling the provider, and returns it unchanged", async () => {
    const oversized = "あ".repeat(MAX_POLISH_INPUT_CHARS + 1);
    const { ai, calls } = createFakeAi();
    const db = createMockD1();
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: oversized });

    expect(calls).toHaveLength(0);
    expect(result.usedFallback).toBe(true);
    expect(result.text).toBe(oversized);
    expect(result.fallback).toMatchObject({ guard: "input", reason: "input_too_long" });
    // No usage_log row: guards.ts's PRE_CALL_FALLBACK_REASONS doesn't know
    // this token, so logging it would silently inflate the daily budget
    // count for calls that never happened.
    expect(usageRows(db)).toEqual([]);
  });

  it("accepts input at exactly the cap", async () => {
    const atCap = "あ".repeat(MAX_POLISH_INPUT_CHARS);
    const { ai, calls } = createFakeAi({ text: atCap });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: atCap });

    expect(calls).toHaveLength(1);
    expect(result.usedFallback).toBe(false);
    expect(result.fallback).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * The guard-trip matrix — budget / call / output, reused verbatim from
 * src/llm/guards.ts.
 * ---------------------------------------------------------------------- */

describe("every guard trip returns the input unchanged", () => {
  it("budget: trips at the daily cap without calling the provider", async () => {
    const db = createMockD1({ onQuery: () => ({ results: [{ calls: 300 }] }) });
    const { ai, calls } = createFakeAi({ text: FAITHFUL_OUTPUT_TEXT });
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(calls).toHaveLength(0);
    expect(result.usedFallback).toBe(true);
    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "budget", reason: "budget_exceeded" });
    expect(usageRows(db)).toEqual([
      expect.objectContaining({ slug: null, task: "polish", fallback: "budget_exceeded", model: null }),
    ]);
  });

  it("call: trips on the deadline, and the provider's later answer is not used", async () => {
    vi.useFakeTimers();
    const db = createMockD1();
    const { ai } = createFakeAi({ pending: true });
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const pending = polishText(deps, { text: INPUT_TEXT });
    await vi.advanceTimersByTimeAsync(computePolishDeadlineMs(computePolishMaxTokens(INPUT_TEXT)));
    const result = await pending;

    expect(result.usedFallback).toBe(true);
    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "call", reason: "timeout" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "timeout" })]);
  });

  it("call: trips on a provider failure", async () => {
    const db = createMockD1();
    const { ai } = createFakeAi({ throws: new Error("AI binding exploded") });
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "call", reason: "provider_error" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "provider_error" })]);
  });

  it("call: separates an upstream 429 from a generic failure", async () => {
    const db = createMockD1();
    const { fetch } = createFakeFetch({ status: 429 });
    const deps: PolishDeps = { env: createEnv({ DB: db, POLISH_PROVIDER: "claude" }), fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "call", reason: "rate_limited" });
  });

  it("output: trips on a refusal", async () => {
    const db = createMockD1();
    const { fetch } = createFakeFetch({ stopReason: "refusal", text: "" });
    const deps: PolishDeps = { env: createEnv({ DB: db, POLISH_PROVIDER: "claude" }), fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "empty_response" });
  });

  it("output: trips on truncation reported by the provider, not by how the text reads", async () => {
    const db = createMockD1();
    const requested = computePolishMaxTokens(INPUT_TEXT);
    const { ai } = createFakeAi({ text: FAITHFUL_OUTPUT_TEXT, completionTokens: requested });
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "truncated" });
  });

  it("output: trips on an invented URL that changes the URL set, not just the count", async () => {
    const db = createMockD1();
    const { ai } = createFakeAi({
      text: FAITHFUL_OUTPUT_TEXT.replace(
        "https://takazudomodular.com/products/example-intro/ https://takazudomodular.com/products/example-intro/",
        "https://takazudomodular.com/products/example-intro/ https://youtu.be/thisWasNeverGiven",
      ),
    });
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "url_mismatch" });
  });
});

/* -------------------------------------------------------------------------
 * The machine-testable preservation assertions — the load-bearing part of
 * issue #16. Each has a positive case (folded into the happy-path test
 * above, which uses exactly this fixture) and a negative case here.
 * ---------------------------------------------------------------------- */

describe("preservation: URL multiset", () => {
  it("passes when every URL occurs the same number of times, order aside", async () => {
    const { ai } = createFakeAi({ text: FAITHFUL_OUTPUT_TEXT });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.usedFallback).toBe(false);
  });

  it("trips when a URL's occurrence count changes even though the set of distinct URLs does not", async () => {
    const db = createMockD1();
    const { ai } = createFakeAi({ text: BROKEN_URL_MULTISET_TEXT });
    const deps: PolishDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(result.fallback?.detail).toContain("URL multiset");
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "schema_invalid" })]);
  });
});

describe("preservation: newline count", () => {
  it("trips when two lines are merged into one", async () => {
    const { ai } = createFakeAi({ text: BROKEN_NEWLINE_TEXT });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(result.fallback?.detail).toContain("newline count");
  });
});

describe("preservation: paragraph count", () => {
  it("trips when a blank line separating two paragraphs is dropped", async () => {
    const { ai } = createFakeAi({ text: BROKEN_PARAGRAPH_TEXT });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(result.fallback?.detail).toContain("paragraph count");
  });
});

describe("preservation: no ～でございます", () => {
  it("trips when the output contains でございま, the too-formal form this mode exists to avoid", async () => {
    const { ai } = createFakeAi({ text: BROKEN_DEGOZAIMASU_TEXT });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.text).toBe(INPUT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(result.fallback?.detail).toContain("でございま");
  });
});

describe("preservation: output length ratio", () => {
  it("trips when the output is under 0.5x the input length", async () => {
    const { ai } = createFakeAi({ text: RATIO_SHORT_TEXT });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: RATIO_BASE_TEXT });

    expect(result.text).toBe(RATIO_BASE_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(result.fallback?.detail).toContain("length ratio");
  });

  it("trips when the output is over 2.0x the input length", async () => {
    // No newlines and no URLs, same as RATIO_SHORT_TEXT — only the ratio
    // check can fire.
    const bloated = "承知いたしました。".repeat(20);
    const { ai } = createFakeAi({ text: bloated });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: RATIO_SHORT_TEXT });

    expect(result.text).toBe(RATIO_SHORT_TEXT);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(result.fallback?.detail).toContain("length ratio");
  });

  it("passes when a faithful polish keeps output roughly input-sized", async () => {
    const { ai } = createFakeAi({ text: FAITHFUL_OUTPUT_TEXT });
    const deps: PolishDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await polishText(deps, { text: INPUT_TEXT });

    expect(result.usedFallback).toBe(false);
  });
});
