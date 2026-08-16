/**
 * The compose envelope end to end: provider selection, the three guards,
 * and the deterministic fallback every one of them lands on.
 *
 * **The load-bearing assertion is equivalence, not correctness of prose.**
 * A model that answers faithfully must produce a message byte-identical
 * to the deterministic one, and a model that answers badly must produce
 * the deterministic one exactly. Everything the fixed skeleton owns —
 * greeting, shipping line, arrival sentence, evaluation clause, DIY
 * block, closing — is therefore proven unreachable by the model on both
 * paths, which is the CLAUDE.md non-negotiable this issue exists to
 * uphold.
 *
 * Reads data/seed for its references, never D1: the seed corpus is
 * frozen, D1 is not (see tests/reply/renderer-contract.test.ts). The
 * `usage_log` rows are asserted here against the Map-backed
 * `createMockD1`, which evaluates no SQL — the real storage semantics of
 * the budget count are tests/compose/budget.test.ts's job, against a
 * real D1 binding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockD1, type MockD1 } from "../../src/db/test-support";
import type { Env } from "../../src/env";
import { COMPOSE_DEADLINE_MS } from "../../src/llm/guards";
import { parseProductRefMarkdown } from "../../src/refs/parse";
import type { ProductRef } from "../../src/refs/model";
import {
  composeReply,
  COMPOSE_MAX_TOKENS,
  type ComposeReplyDeps,
  type ComposeReplyInput,
} from "../../src/reply/compose";
import { renderDeterministicReply, renderResourceSectionDeterministic } from "../../src/reply/render";
import {
  DISCORD_BLOCK,
  DIY_BUILD_GUIDE_INTRO,
  EVALUATION_CLAUSE,
  formatArrivalSchedule,
  GREETING_LINE,
  NEKOPOS_SHIPPING_LINES,
  YAMATO_SHIPPING_LINE,
} from "../../src/reply/templates";
import type { FetchLike } from "../../src/types";

/* -------------------------------------------------------------------------
 * Corpus
 * ---------------------------------------------------------------------- */

const refs = new Map<string, ProductRef>(
  Object.entries(
    import.meta.glob("../../data/seed/products/*.md", { query: "?raw", import: "default", eager: true }),
  ).map(([path, markdown]): [string, ProductRef] => {
    const slug = path.replace(/^.*\/(.+)\.md$/, "$1");
    return [slug, parseProductRefMarkdown({ slug, markdown: markdown as string })];
  }),
);

const ref = (slug: string): ProductRef => {
  const found = refs.get(slug);
  if (found === undefined) throw new Error(`no such corpus file: ${slug}.md`);
  return found;
};

/** Fixed, passed in — nothing here reads a clock (see tests/reply/golden.test.ts). */
const ARRIVAL = formatArrivalSchedule({ dayLabel: "明後日月曜", month: 8, day: 18 });

/** `small`: no arrival sentence, and the one product whose customer-facing prose the rule rescues. */
const SMALL_SLUG = "zudo-3u-to-1u";
/** `small` with two literal blocks, one of them variant-gated on "Lite". */
const LITERAL_SLUG = "zudo-rail";
/** `general-diy`: exercises the diy template and its separate `{build_guide}` slot. */
const DIY_SLUG = "addac304";

/* -------------------------------------------------------------------------
 * Fakes
 * ---------------------------------------------------------------------- */

interface AiCall {
  model: string;
  inputs: Record<string, unknown>;
}

/** Records `AI.run` and answers with a queued envelope, or throws. */
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
        // Deliberately not a round number: a round `completion_tokens`
        // is exactly what src/llm/workers-ai.ts reads as a cap hit.
        usage: { prompt_tokens: 812, completion_tokens: behaviour.completionTokens ?? 731 },
      };
    },
  } as unknown as Ai;
  return { ai, calls };
}

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

/** Records outbound HTTP and answers as the Anthropic messages API. */
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
        usage: { input_tokens: 812, output_tokens: 731 },
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

/** Rows the code under test wrote to `usage_log`, read back off the recorded calls. */
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

/** The exact `{product_resources}` content the deterministic path produces — what a perfectly faithful model would return. */
function faithfulSection(
  slug: string,
  options: { diy?: boolean; variantText?: string } = {},
): string {
  return renderResourceSectionDeterministic(ref(slug), options);
}

function baseInput(slug: string, over: Partial<ComposeReplyInput> = {}): ComposeReplyInput {
  return {
    ref: ref(slug),
    arrivalSchedule: ref(slug).category === "small" ? null : ARRIVAL,
    discord: false,
    direct: false,
    ...over,
  };
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

describe("the composed path", () => {
  it("returns the model's section, keeps every reference URL, and logs no fallback", async () => {
    const section = faithfulSection(SMALL_SLUG);
    const { ai, calls } = createFakeAi({ text: section });
    const db = createMockD1();
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.usedFallback).toBe(false);
    expect(result.fallback).toBeNull();
    expect(result.provider).toBe("workers-ai");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.inputs.max_tokens).toBe(COMPOSE_MAX_TOKENS);

    for (const resource of ref(SMALL_SLUG).sections.flatMap((s) => s.resources)) {
      expect(result.text).toContain(resource.url);
    }
    expect(usageRows(db)).toEqual([
      {
        slug: SMALL_SLUG,
        task: "compose",
        provider: "workers-ai",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        fallback: null,
        tokensIn: 812,
        tokensOut: 731,
      },
    ]);
  });

  it("produces the deterministic message byte for byte when the model is faithful", async () => {
    const { ai } = createFakeAi({ text: faithfulSection(SMALL_SLUG) });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    // The skeleton is the same skeleton, filled the same way. Only the
    // wording inside the slot is the model's to choose.
    expect(result.text).toBe(
      renderDeterministicReply({
        ref: ref(SMALL_SLUG),
        flags: { direct: false, discord: false },
        arrivalSchedule: null,
      }),
    );
  });

  it("passes max_tokens on every call — Llama truncates silently at 256 without it", async () => {
    const { ai, calls } = createFakeAi({ text: faithfulSection(DIY_SLUG, { diy: true }) });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    await composeReply(deps, baseInput(DIY_SLUG, { purchased: "kit" }));

    expect(calls[0]?.inputs.max_tokens).toBe(2048);
  });

  it("never logs the prompt, the reference body or the model's completion", async () => {
    const section = faithfulSection(SMALL_SLUG);
    const { ai } = createFakeAi({ text: section });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    await composeReply(deps, baseInput(SMALL_SLUG));

    const output = logged.join("\n");
    expect(output).not.toBe("");
    for (const fragment of [
      section,
      ref(SMALL_SLUG).sections[1]!.prose!,
      "本製品は、横に長く空いている穴部分へ",
      "https://takazudomodular.com/products/zudo-3u-to-1u-intro/",
    ]) {
      expect(output).not.toContain(fragment);
    }
  });
});

/* -------------------------------------------------------------------------
 * The guard-trip matrix
 * ---------------------------------------------------------------------- */

describe("every guard trip falls back to the deterministic render", () => {
  const deterministic = (slug: string) =>
    renderDeterministicReply({
      ref: ref(slug),
      flags: { direct: false, discord: false },
      arrivalSchedule: null,
    });

  it("budget: trips at the daily cap without calling the provider", async () => {
    const db = createMockD1({ onQuery: () => ({ results: [{ calls: 300 }] }) });
    const { ai, calls } = createFakeAi({ text: faithfulSection(SMALL_SLUG) });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(calls).toHaveLength(0);
    expect(result.usedFallback).toBe(true);
    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.fallback).toMatchObject({ guard: "budget", reason: "budget_exceeded" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "budget_exceeded", model: null })]);
  });

  it("call: trips on the deadline, and the provider's later answer is not used", async () => {
    vi.useFakeTimers();
    const db = createMockD1();
    const { ai } = createFakeAi({ pending: true });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const pending = composeReply(deps, baseInput(SMALL_SLUG));
    await vi.advanceTimersByTimeAsync(COMPOSE_DEADLINE_MS);
    const result = await pending;

    expect(result.usedFallback).toBe(true);
    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.fallback).toMatchObject({ guard: "call", reason: "timeout" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "timeout" })]);
  });

  it("call: trips on a provider failure", async () => {
    const db = createMockD1();
    const { ai } = createFakeAi({ throws: new Error("AI binding exploded") });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.fallback).toMatchObject({ guard: "call", reason: "provider_error" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "provider_error" })]);
  });

  it("call: separates an upstream 429 from a generic failure", async () => {
    const db = createMockD1();
    const { fetch } = createFakeFetch({ status: 429 });
    const deps: ComposeReplyDeps = {
      env: createEnv({ DB: db, COMPOSE_PROVIDER: "claude" }),
      fetch,
    };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.fallback).toMatchObject({ guard: "call", reason: "rate_limited" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "rate_limited" })]);
  });

  it("output: trips on a refusal", async () => {
    const db = createMockD1();
    const { fetch } = createFakeFetch({ stopReason: "refusal", text: "" });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, COMPOSE_PROVIDER: "claude" }), fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.fallback).toMatchObject({ guard: "output", reason: "empty_response" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "empty_response" })]);
  });

  it("output: trips on truncation reported by the provider, not by how the text reads", async () => {
    const db = createMockD1();
    // A complete-looking section that nonetheless hit the cap — the
    // round completion_tokens is the only tell (src/llm/workers-ai.ts).
    const { ai } = createFakeAi({ text: faithfulSection(SMALL_SLUG), completionTokens: COMPOSE_MAX_TOKENS });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.fallback).toMatchObject({ guard: "output", reason: "truncated" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "truncated" })]);
  });

  it("output: trips on an invented URL — the worst failure this system can produce", async () => {
    const db = createMockD1();
    const { ai } = createFakeAi({
      text: `${faithfulSection(SMALL_SLUG)}\n\n公式デモ動画:\nhttps://youtu.be/thisWasNeverGiven`,
    });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.text).not.toContain("thisWasNeverGiven");
    expect(result.fallback).toMatchObject({ guard: "output", reason: "url_mismatch" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "url_mismatch" })]);
  });

  it("output: trips on a URL that should have been there and was dropped", async () => {
    const db = createMockD1();
    const dropped = faithfulSection(SMALL_SLUG).replace(
      /https:\/\/takazudomodular\.com\/products\/zudo-3u-to-1u-intro\/\n?/g,
      "",
    );
    const { ai } = createFakeAi({ text: dropped });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.fallback).toMatchObject({ guard: "output", reason: "url_mismatch" });
  });

  it("output: trips when a mandatory literal notice is paraphrased", async () => {
    const db = createMockD1();
    const notice = ref(LITERAL_SLUG).sections.flatMap((s) => s.literalBlocks).find((b) => b.rule.kind === "always")!;
    const paraphrased = faithfulSection(LITERAL_SLUG).replace(
      notice.text,
      "レールは折れやすいのでお気をつけください。",
    );
    const { ai } = createFakeAi({ text: paraphrased });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(LITERAL_SLUG));

    expect(result.text).toBe(deterministic(LITERAL_SLUG));
    expect(result.text).toContain(notice.text);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
  });

  it("output: trips when the model restates a fixed clause the skeleton already supplies", async () => {
    const db = createMockD1();
    const { ai } = createFakeAi({ text: `${GREETING_LINE}\n\n${faithfulSection(SMALL_SLUG)}` });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.text.split(GREETING_LINE)).toHaveLength(2);
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
  });

  it("output: trips when the model restates the DIY build-guide paragraph", async () => {
    // The constant begins with a `{product_name}` slot, so what reaches
    // a customer is its slot-free remainder — checking for the raw
    // template would catch nothing.
    const restated = DIY_BUILD_GUIDE_INTRO.split("{product_name}")[1]!;
    const { ai } = createFakeAi({ text: `ADDAC304${restated}\n\n${faithfulSection(DIY_SLUG, { diy: true })}` });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(DIY_SLUG, { purchased: "kit" }));

    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(result.text.split(restated)).toHaveLength(2);
  });

  it("output: trips rather than rejecting when the composed section breaks slot filling", async () => {
    const db = createMockD1();
    const { ai } = createFakeAi({ text: `${faithfulSection(SMALL_SLUG)}\n\n{product_resources}` });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.text).toBe(deterministic(SMALL_SLUG));
    expect(result.text).not.toContain("{product_resources}");
    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(usageRows(db)).toEqual([expect.objectContaining({ fallback: "schema_invalid" })]);
  });

  it("never rejects for a guard trip", async () => {
    const db = createMockD1();
    const { ai } = createFakeAi({ throws: new Error("everything is on fire") });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    await expect(composeReply(deps, baseInput(SMALL_SLUG))).resolves.toMatchObject({ usedFallback: true });
  });

  it("still produces the reply when the usage_log write itself fails", async () => {
    const db = createMockD1({
      onQuery: (call) => {
        if (call.query.includes("INSERT INTO usage_log")) throw new Error("D1 write failed");
        return null;
      },
    });
    const { ai } = createFakeAi({ text: faithfulSection(SMALL_SLUG) });
    const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.usedFallback).toBe(false);
    expect(result.text).toContain("https://takazudomodular.com/products/zudo-3u-to-1u-intro/");
  });
});

/* -------------------------------------------------------------------------
 * The fixed clauses, on both paths
 * ---------------------------------------------------------------------- */

describe("the fixed clauses are unreachable by the model", () => {
  /** A model that rewords freely but respects every URL and literal — the realistic good case. */
  const reworded = (slug: string, options: { diy?: boolean; variantText?: string } = {}): string =>
    faithfulSection(slug, options).replace(
      /^(?!https?:)(.+)$/m,
      (line) => `${line}どうぞご確認くださいませ。`,
    );

  const cases: { name: string; slug: string; arrival: string | null; purchased?: "built" | "kit" }[] = [
    { name: "small", slug: SMALL_SLUG, arrival: null },
    { name: "general", slug: "oxi-one", arrival: ARRIVAL },
    { name: "diy", slug: DIY_SLUG, arrival: ARRIVAL, purchased: "kit" },
  ];

  it.each(cases)(
    "$name: composed and fallback carry the same fixed clauses, and the same URLs",
    async ({ slug, arrival, purchased }) => {
      const diy = purchased === "kit" && ref(slug).category === "general-diy";
      const { ai } = createFakeAi({ text: reworded(slug, { diy }) });
      const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };
      const input = baseInput(slug, {
        arrivalSchedule: arrival,
        discord: true,
        ...(purchased === undefined ? {} : { purchased }),
      });

      const composed = await composeReply(deps, input);
      const fallbackText = renderDeterministicReply({
        ref: ref(slug),
        flags: { direct: false, discord: true },
        arrivalSchedule: arrival,
        ...(purchased === undefined ? {} : { purchased }),
      });

      expect(composed.usedFallback).toBe(false);
      expect(composed.text).not.toBe(fallbackText);

      const shipping = ref(slug).category === "small" ? NEKOPOS_SHIPPING_LINES : YAMATO_SHIPPING_LINE;
      for (const clause of [GREETING_LINE, shipping, EVALUATION_CLAUSE, DISCORD_BLOCK]) {
        expect(composed.text).toContain(clause);
        expect(fallbackText).toContain(clause);
      }
      if (arrival !== null) {
        expect(composed.text).toContain(arrival);
        expect(fallbackText).toContain(arrival);
      }

      const urls = (text: string) => [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]).sort();
      expect(urls(composed.text)).toEqual(urls(fallbackText));
    },
  );

  it("drops the evaluation clause on --direct on both paths", async () => {
    const { ai } = createFakeAi({ text: reworded(SMALL_SLUG) });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const composed = await composeReply(deps, baseInput(SMALL_SLUG, { direct: true }));

    expect(composed.usedFallback).toBe(false);
    expect(composed.text).not.toContain(EVALUATION_CLAUSE);
  });
});

/* -------------------------------------------------------------------------
 * The section-prose rule
 * ---------------------------------------------------------------------- */

describe("the section-prose rule", () => {
  const USAGE_PROSE = ref(SMALL_SLUG).sections.find((s) => s.heading.startsWith("Usage Guide"))!.prose!;
  const NOTES_PROSE = ref(SMALL_SLUG).sections.find((s) => s.heading === "Notes")!.prose!;

  it("emits zudo-3u-to-1u's 取り付け方法 and withholds its Notes, on the composed path", async () => {
    const { ai, calls } = createFakeAi({ text: faithfulSection(SMALL_SLUG) });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.usedFallback).toBe(false);
    expect(result.text).toContain(USAGE_PROSE);
    expect(result.text).not.toContain(NOTES_PROSE);

    // The Notes prose still reaches the model — it is written as
    // guidance to whoever composes the reply, and that is its use.
    const prompt = String((calls[0]?.inputs.messages as { content: string }[])[1]?.content);
    expect(prompt).toContain(NOTES_PROSE);
  });

  it("emits it on the fallback path too — a tripped guard must not drop installation steps", async () => {
    const { ai } = createFakeAi({ throws: new Error("provider down") });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.usedFallback).toBe(true);
    expect(result.text).toContain(USAGE_PROSE);
    expect(result.text).not.toContain(NOTES_PROSE);
  });

  it("trips the guard when the model reproduces the guidance it was given", async () => {
    // The other half of the rule, and the half that is this module's:
    // the renderer keeps editorial prose out of the deterministic path,
    // but only the output guard can keep it out of a completion.
    const { ai } = createFakeAi({ text: `${faithfulSection(SMALL_SLUG)}\n\n${NOTES_PROSE}` });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(SMALL_SLUG));

    expect(result.fallback).toMatchObject({ guard: "output", reason: "schema_invalid" });
    expect(result.text).not.toContain(NOTES_PROSE);
  });

  /**
   * ai-mult's own Notes: "For the **built** version, no product
   * resources / guide links are needed in the reply — just the base
   * template." All three of these references are editorial prose and
   * nothing else, so there is genuinely nothing to compose.
   */
  it.each(["ai-mult", "oxi-pipe-mk2", "x0x-heart"])(
    "%s has no resources section, so no provider call is made at all",
    async (slug) => {
      const db = createMockD1();
      const { ai, calls } = createFakeAi({ text: "the model should never have been asked" });
      const deps: ComposeReplyDeps = { env: createEnv({ DB: db, AI: ai }), fetch: createFakeFetch().fetch };

      const result = await composeReply(deps, baseInput(slug));

      expect(calls).toHaveLength(0);
      expect(result.fallback).toBeNull();
      // No call, so nothing to account for — a `usage_log` row here
      // would spend budget on a call that never happened.
      expect(usageRows(db)).toEqual([]);
      expect(result.model).toBeUndefined();
    },
  );

  /**
   * The failure mode the derivation exists to prevent, checked against
   * the whole frozen corpus rather than argued for.
   *
   * `withheldProse` is read off the deterministic rendering — "prose the
   * renderer did not emit" — precisely so it can never name text the
   * renderer DOES emit. A hand-copied `Notes` predicate here could drift
   * from src/reply/render.ts's, and the symptom would be silent: every
   * faithful completion for the affected product falling back forever,
   * with a `schema_invalid` row and a message that still reads fine.
   */
  it.each([...refs.keys()])("%s: a faithful completion passes every guard", async (slug) => {
    const source = ref(slug);
    const variants: ("built" | "kit")[] = source.category === "general-diy" ? ["built", "kit"] : ["built"];

    for (const purchased of variants) {
      const diy = source.category === "general-diy" && purchased === "kit";
      const arrivalSchedule = source.category === "small" ? null : ARRIVAL;
      const { ai } = createFakeAi({ text: faithfulSection(slug, { diy }) });
      const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

      const result = await composeReply(deps, baseInput(slug, { arrivalSchedule, purchased }));

      expect(result.fallback, `${slug} (${purchased})`).toBeNull();
      expect(result.text).toBe(
        renderDeterministicReply({
          ref: source,
          flags: { direct: false, discord: false },
          arrivalSchedule,
          purchased,
        }),
      );
    }
  });
});

/* -------------------------------------------------------------------------
 * Provider selection
 * ---------------------------------------------------------------------- */

describe("COMPOSE_PROVIDER", () => {
  it("picks the adapter and changes nothing else", async () => {
    const section = faithfulSection(SMALL_SLUG);

    const workersAi = createFakeAi({ text: section });
    const workersAiFetch = createFakeFetch({ text: section });
    const viaWorkersAi = await composeReply(
      { env: createEnv({ AI: workersAi.ai, COMPOSE_PROVIDER: "workers-ai" }), fetch: workersAiFetch.fetch },
      baseInput(SMALL_SLUG),
    );

    const claudeAi = createFakeAi({ text: section });
    const claudeFetch = createFakeFetch({ text: section });
    const viaClaude = await composeReply(
      { env: createEnv({ AI: claudeAi.ai, COMPOSE_PROVIDER: "claude" }), fetch: claudeFetch.fetch },
      baseInput(SMALL_SLUG),
    );

    expect(workersAi.calls).toHaveLength(1);
    expect(workersAiFetch.calls).toHaveLength(0);
    expect(claudeAi.calls).toHaveLength(0);
    expect(claudeFetch.calls).toHaveLength(1);
    expect(claudeFetch.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");

    expect(viaWorkersAi.provider).toBe("workers-ai");
    expect(viaClaude.provider).toBe("claude");
    expect(viaClaude.text).toBe(viaWorkersAi.text);
    expect(claudeFetch.calls[0]?.body.max_tokens).toBe(COMPOSE_MAX_TOKENS);
  });

  it("falls back to the documented default on an unrecognized value rather than taking replies down", async () => {
    const { ai, calls } = createFakeAi({ text: faithfulSection(SMALL_SLUG) });
    const env = createEnv({ AI: ai });
    (env as { COMPOSE_PROVIDER: string }).COMPOSE_PROVIDER = "gpt-9";

    const result = await composeReply({ env, fetch: createFakeFetch().fetch }, baseInput(SMALL_SLUG));

    expect(calls).toHaveLength(1);
    expect(result.provider).toBe("workers-ai");
    expect(logged.join("\n")).toContain("unrecognized COMPOSE_PROVIDER");
  });
});

/* -------------------------------------------------------------------------
 * Variant gating
 * ---------------------------------------------------------------------- */

describe("variant gating reaches both paths", () => {
  const liteNotice = ref(LITERAL_SLUG)
    .sections.flatMap((s) => s.literalBlocks)
    .find((b) => b.rule.kind === "variant-match")!;

  it("ships the Lite renewal notice when the variant text names Lite", async () => {
    const variantText = "zudo-rail lite 60 set1";
    const { ai } = createFakeAi({ text: faithfulSection(LITERAL_SLUG, { variantText }) });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(LITERAL_SLUG, { variantText }));

    expect(result.usedFallback).toBe(false);
    expect(result.text).toContain(liteNotice.text);
  });

  it("withholds it when no variant is named", async () => {
    const { ai } = createFakeAi({ text: faithfulSection(LITERAL_SLUG) });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    const result = await composeReply(deps, baseInput(LITERAL_SLUG));

    expect(result.usedFallback).toBe(false);
    expect(result.text).not.toContain(liteNotice.text);
  });

  it("keeps a withheld notice out of the prompt, so the model cannot reintroduce it", async () => {
    const { ai, calls } = createFakeAi({ text: faithfulSection(LITERAL_SLUG) });
    const deps: ComposeReplyDeps = { env: createEnv({ AI: ai }), fetch: createFakeFetch().fetch };

    await composeReply(deps, baseInput(LITERAL_SLUG));

    const prompt = String((calls[0]?.inputs.messages as { content: string }[])[1]?.content);
    expect(prompt).not.toContain(liteNotice.text);
  });
});
