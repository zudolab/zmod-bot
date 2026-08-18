import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLAUDE_MODEL } from "../llm/claude";
import type { LlmProvider, LlmRequest, LlmResult } from "../llm/provider";
import { createMockD1, type MockD1 } from "../db/test-support";
import type { Env } from "../env";
import { GREETING_LINE } from "../reply/templates";
import type { FetchLike } from "../types";
import {
  buildPolicyUpdateRequest,
  computePolicyMaxTokens,
  estimatePolicyTokens,
  updatePolicy,
  validatePolicyCandidate,
  type PolicyValidationReason,
} from "./update";
import {
  POLICY_HEADER,
  POLICY_MAX_BYTES,
  POLICY_MAX_REQUEST_CHARS,
  POLICY_REQUIRED_HEADINGS,
} from "./contract";

const CURRENT_DOCUMENT = `${POLICY_HEADER}

${POLICY_REQUIRED_HEADINGS[0]}

丁寧な日本語で返信します。

${POLICY_REQUIRED_HEADINGS[1]}

段落の間には空行を入れます。

${POLICY_REQUIRED_HEADINGS[2]}
`;

const VALID_EDIT = `${CURRENT_DOCUMENT}必要な場合のみ、簡潔な補足を加えます。\n`;
const FROZEN_NOW = new Date("2026-08-19T03:04:05.000Z");

function result(overrides: Partial<LlmResult> = {}): LlmResult {
  return {
    text: VALID_EDIT,
    model: "test-policy-model",
    raw: {},
    stopReason: "end",
    truncated: false,
    tokensIn: 101,
    tokensOut: 202,
    ...overrides,
  };
}

function createProvider(behaviour: LlmResult | Promise<LlmResult> = result()): {
  provider: LlmProvider;
  calls: LlmRequest[];
} {
  const calls: LlmRequest[] = [];
  return {
    calls,
    provider: {
      id: "claude",
      async run(request) {
        calls.push(request);
        return behaviour;
      },
    },
  };
}

function createEnv(db: D1Database = createMockD1(), overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    AI: { run: async () => ({ response: VALID_EDIT }) } as unknown as Ai,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SLACK_BOT_USER_ID: "U000BOT",
    SLACK_ALLOWED_CHANNEL_IDS: "C1",
    SLACK_ADMIN_USER_IDS: "U1",
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    POLICY_PROVIDER: "claude",
    CLAUDE_MODEL: "",
    POLICY_MODEL: "",
    SITE_API_BASE: "https://example.com",
    ...overrides,
  };
}

const NO_FETCH: FetchLike = async () => {
  throw new Error("policy updater must not fetch outside its selected provider");
};

describe("validatePolicyCandidate", () => {
  const tooLarge = `${CURRENT_DOCUMENT}${"あ".repeat(POLICY_MAX_BYTES)}\n`;
  const reordered = `${POLICY_HEADER}

${POLICY_REQUIRED_HEADINGS[1]}

段落。

${POLICY_REQUIRED_HEADINGS[0]}

文体。

${POLICY_REQUIRED_HEADINGS[2]}
`;

  const cases: Array<{ name: string; candidate: string; reason: PolicyValidationReason }> = [
    { name: "changed immutable header", candidate: VALID_EDIT.replace("bot-editable", "human-editable"), reason: "header_changed" },
    { name: "content before the header", candidate: `前置き\n${VALID_EDIT}`, reason: "header_changed" },
    { name: "missing required heading", candidate: VALID_EDIT.replace(`${POLICY_REQUIRED_HEADINGS[1]}\n`, ""), reason: "required_headings" },
    { name: "required headings out of order", candidate: reordered, reason: "required_headings" },
    { name: "UTF-8 byte cap exceeded", candidate: tooLarge, reason: "too_large" },
    { name: "code fence", candidate: `${VALID_EDIT}\`\`\`text\n禁止\n\`\`\`\n`, reason: "code_fence" },
    { name: "tab control character", candidate: `${VALID_EDIT}\t禁止\n`, reason: "control_character" },
    { name: "carriage return", candidate: `${VALID_EDIT}\r禁止\n`, reason: "control_character" },
    { name: "new URL", candidate: `${VALID_EDIT}https://example.com/new\n`, reason: "new_url" },
    { name: "bare URL protocol marker", candidate: `${VALID_EDIT}https://\n`, reason: "new_url" },
    { name: "non-ASCII URL", candidate: `${VALID_EDIT}https://例.example/\n`, reason: "new_url" },
    { name: "fixed customer-reply clause", candidate: `${VALID_EDIT}${GREETING_LINE}\n`, reason: "fixed_clause" },
  ];

  it.each(cases)("rejects $name with a stable token", ({ candidate, reason }) => {
    expect(validatePolicyCandidate(CURRENT_DOCUMENT, candidate)).toBe(reason);
  });

  it("accepts a valid small edit", () => {
    expect(validatePolicyCandidate(CURRENT_DOCUMENT, VALID_EDIT)).toBeNull();
  });

  it("allows only URLs that already occur byte-for-byte in the current document", () => {
    const currentWithUrl = `${CURRENT_DOCUMENT}既存: https://example.com/guide\n`;
    expect(validatePolicyCandidate(currentWithUrl, `${currentWithUrl}再掲: https://example.com/guide\n`)).toBeNull();
    expect(validatePolicyCandidate(currentWithUrl, `${currentWithUrl}変更: https://example.com/guide/new\n`)).toBe("new_url");
  });
});

describe("policy update orchestration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns accepted, supplies the complete prompt and records exactly one policy usage row", async () => {
    const db = createMockD1();
    const fake = createProvider();
    const outcome = await updatePolicy(
      { env: createEnv(db), fetch: NO_FETCH, provider: fake.provider, now: () => FROZEN_NOW },
      { currentDocument: CURRENT_DOCUMENT, request: "追加ガイダンスに簡潔さを追加して" },
    );

    expect(outcome).toEqual({
      kind: "accepted",
      document: VALID_EDIT,
      provider: "claude",
      model: "test-policy-model",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.system).toContain("COMPLETE revised Markdown document");
    expect(fake.calls[0]?.user).toContain(CURRENT_DOCUMENT);
    expect(fake.calls[0]?.user).toContain("追加ガイダンスに簡潔さを追加して");
    expect(fake.calls[0]?.maxTokens).toBeGreaterThanOrEqual(estimatePolicyTokens(CURRENT_DOCUMENT) * 2);

    const inserts = db.calls.filter((call) => call.query.includes("INSERT INTO usage_log"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.bindings).toEqual([
      null,
      "policy",
      "claude",
      "test-policy-model",
      null,
      101,
      202,
      FROZEN_NOW.getTime(),
    ]);
  });

  it("rejects an overlong operator request before budget, provider, or accounting I/O", async () => {
    const db = createMockD1();
    const fake = createProvider();
    const outcome = await updatePolicy(
      { env: createEnv(db), fetch: NO_FETCH, provider: fake.provider, now: () => FROZEN_NOW },
      { currentDocument: CURRENT_DOCUMENT, request: "x".repeat(POLICY_MAX_REQUEST_CHARS + 1) },
    );

    expect(outcome).toEqual({ kind: "rejected", reason: "request_too_long" });
    expect(fake.calls).toHaveLength(0);
    expect(db.calls).toHaveLength(0);
  });

  it("returns no_change for byte-identical output and accounts for the call", async () => {
    const db = createMockD1();
    const fake = createProvider(result({ text: CURRENT_DOCUMENT }));
    const outcome = await updatePolicy(
      { env: createEnv(db), fetch: NO_FETCH, provider: fake.provider, now: () => FROZEN_NOW },
      { currentDocument: CURRENT_DOCUMENT, request: "関係のない依頼" },
    );

    expect(outcome).toEqual({ kind: "no_change", provider: "claude", model: "test-policy-model" });
    expect(db.calls.filter((call) => call.query.includes("INSERT INTO usage_log"))).toHaveLength(1);
  });

  it.each([
    { name: "refusal", llm: result({ text: "", stopReason: "refusal" as const }), reason: "refusal" },
    { name: "max_tokens", llm: result({ stopReason: "max_tokens" as const, truncated: true }), reason: "max_tokens" },
    { name: "provider truncation flag", llm: result({ truncated: true }), reason: "truncated" },
  ])("returns rejected for $name with its distinct reason token", async ({ llm, reason }) => {
    const db = createMockD1();
    const fake = createProvider(llm);
    const outcome = await updatePolicy(
      { env: createEnv(db), fetch: NO_FETCH, provider: fake.provider, now: () => FROZEN_NOW },
      { currentDocument: CURRENT_DOCUMENT, request: "編集" },
    );

    expect(outcome).toMatchObject({ kind: "rejected", reason });
    const insert = db.calls.find((call) => call.query.includes("INSERT INTO usage_log"));
    expect(insert?.bindings[4]).toBe(reason);
  });

  it("returns validator rejection without exposing the document in accounting", async () => {
    const db = createMockD1();
    const fake = createProvider(result({ text: `${VALID_EDIT}https://new.example/private\n` }));
    const outcome = await updatePolicy(
      { env: createEnv(db), fetch: NO_FETCH, provider: fake.provider, now: () => FROZEN_NOW },
      { currentDocument: CURRENT_DOCUMENT, request: "秘密のURLを追加" },
    );

    expect(outcome).toMatchObject({ kind: "rejected", reason: "new_url" });
    expect(JSON.stringify(db.calls)).not.toContain("秘密のURLを追加");
    expect(JSON.stringify(db.calls)).not.toContain("new.example/private");
  });

  it("uses the frozen UTC clock for the policy budget and rejects at the injected cap", async () => {
    const db = createMockD1({
      onQuery: ({ query }) => (query.includes("SELECT COUNT(*) AS calls") ? { results: [{ calls: 2 }] } : undefined),
    });
    const fake = createProvider();
    const outcome = await updatePolicy(
      { env: createEnv(db), fetch: NO_FETCH, provider: fake.provider, now: () => FROZEN_NOW, dailyCap: 2 },
      { currentDocument: CURRENT_DOCUMENT, request: "編集" },
    );

    expect(outcome).toEqual({ kind: "rejected", reason: "budget_exceeded", provider: "claude" });
    expect(fake.calls).toHaveLength(0);
    const budget = db.calls.find((call) => call.query.includes("SELECT COUNT(*) AS calls"));
    expect(budget?.bindings.slice(0, 3)).toEqual([
      "policy",
      Date.UTC(2026, 7, 19),
      Date.UTC(2026, 7, 20),
    ]);
    const insert = db.calls.find((call) => call.query.includes("INSERT INTO usage_log"));
    expect(insert?.bindings[4]).toBe("budget_exceeded");
    expect(insert?.bindings[7]).toBe(FROZEN_NOW.getTime());
  });

  it("rejects on the injected deadline, aborts the provider signal, and records timeout", async () => {
    let signal: AbortSignal | undefined;
    const provider: LlmProvider = {
      id: "claude",
      run(request) {
        signal = request.signal;
        return new Promise(() => {});
      },
    };
    const db = createMockD1();
    const pending = updatePolicy(
      { env: createEnv(db), fetch: NO_FETCH, provider, now: () => FROZEN_NOW, deadlineMs: 25 },
      { currentDocument: CURRENT_DOCUMENT, request: "編集" },
    );

    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({
      kind: "rejected",
      reason: "timeout",
      provider: "claude",
    });
    expect(signal?.aborted).toBe(true);
    expect(db.calls.find((call) => call.query.includes("INSERT INTO usage_log"))?.bindings[4]).toBe("timeout");
  });
});

describe("provider and model fallback", () => {
  it.each([
    {
      name: "POLICY_MODEL overrides CLAUDE_MODEL",
      env: { POLICY_PROVIDER: "claude" as const, POLICY_MODEL: "policy-sonnet", CLAUDE_MODEL: "shared-haiku" },
      expected: "policy-sonnet",
    },
    {
      name: "blank POLICY_MODEL falls back to CLAUDE_MODEL",
      env: { POLICY_PROVIDER: "claude" as const, POLICY_MODEL: "", CLAUDE_MODEL: "shared-sonnet" },
      expected: "shared-sonnet",
    },
    {
      name: "both blank use the adapter default",
      env: { POLICY_PROVIDER: undefined, POLICY_MODEL: "", CLAUDE_MODEL: "" },
      expected: DEFAULT_CLAUDE_MODEL,
    },
  ])("$name", async ({ env: overrides, expected }) => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          model: expected,
          content: [{ type: "text", text: CURRENT_DOCUMENT }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    };

    await updatePolicy(
      { env: createEnv(createMockD1(), overrides), fetch: fetchImpl, now: () => FROZEN_NOW },
      { currentDocument: CURRENT_DOCUMENT, request: "変更不要" },
    );
    expect(bodies[0]?.model).toBe(expected);
  });

  it("selects Workers AI only when POLICY_PROVIDER explicitly requests it", async () => {
    const aiCalls: Record<string, unknown>[] = [];
    const ai = {
      run: async (_model: string, inputs: Record<string, unknown>) => {
        aiCalls.push(inputs);
        return { response: CURRENT_DOCUMENT, usage: { prompt_tokens: 11, completion_tokens: 13 } };
      },
    } as unknown as Ai;
    await updatePolicy(
      {
        env: createEnv(createMockD1(), { AI: ai, POLICY_PROVIDER: "workers-ai" }),
        fetch: NO_FETCH,
        now: () => FROZEN_NOW,
      },
      { currentDocument: CURRENT_DOCUMENT, request: "変更不要" },
    );
    expect(aiCalls).toHaveLength(1);
  });
});

describe("policy token sizing", () => {
  it("always passes at least twice the estimated current-document tokens", () => {
    for (const document of ["短い", CURRENT_DOCUMENT, "日".repeat(POLICY_MAX_BYTES / 3)]) {
      expect(computePolicyMaxTokens(document)).toBeGreaterThanOrEqual(estimatePolicyTokens(document) * 2);
      expect(buildPolicyUpdateRequest({ currentDocument: document, request: "編集" }).maxTokens).toBe(
        computePolicyMaxTokens(document),
      );
    }
  });
});
