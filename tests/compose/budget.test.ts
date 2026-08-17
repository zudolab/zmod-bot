/**
 * The budget guard against a REAL D1 binding.
 *
 * This is the tier split from src/db/test-support.ts: what is under test
 * here is not branching, it is the count query itself — the UTC-day
 * cutoff, the task filter, and the `NOT IN` that keeps a fallback row
 * which never reached a provider out of the tally. A Map-backed stub
 * evaluates no SQL and would agree with any of those written wrong.
 *
 * The counterpart is issue #13's reason for counting in D1 at all: KV's
 * read-modify-write is not atomic and its reads are edge-cached for up
 * to 60 s, so it silently loses increments under exactly the burst a
 * budget guard exists to catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendUsageLog, type RepoDeps } from "../../src/db/repos";
import type { Env } from "../../src/env";
import { checkBudgetGuard, countComposeCallsToday, utcDayStartMs } from "../../src/llm/guards";
import type { UsageTask } from "../../src/db/schema";
import { parseProductRefMarkdown } from "../../src/refs/parse";
import { composeReply, type ComposeReplyDeps } from "../../src/reply/compose";
import { renderResourceSectionDeterministic } from "../../src/reply/render";
import type { FetchLike } from "../../src/types";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

const PRODUCT_MARKDOWN = `# Budget Fixture Widget

- category: small
- product-url: https://takazudomodular.com/products/budget-fixture/
- aliases: budget fixture

## Notes

Fixture body for the budget-guard tests. Not part of the frozen corpus.

## Guides

- Takazudo Modular: 紹介記事: https://takazudomodular.com/products/budget-fixture/

Intro text: 詳しい使い方については、当店サイトの紹介記事にもまとめております。
`;

const productRef = parseProductRefMarkdown({ slug: "budget-fixture", markdown: PRODUCT_MARKDOWN });
const FAITHFUL_SECTION = renderResourceSectionDeterministic(productRef);

const NOON = new Date("2026-08-18T12:00:00Z");

let handle: TestEnvHandle;
let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(async () => {
  handle = await createTestEnv();
  consoleSpies = (["log", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
});

afterEach(async () => {
  for (const spy of consoleSpies) spy.mockRestore();
  vi.restoreAllMocks();
  await handle.dispose();
});

const repoAt = (at: Date): RepoDeps => ({ db: handle.db, now: () => at });

async function seedRow(
  at: Date,
  over: { task?: UsageTask; fallback?: string | null } = {},
): Promise<void> {
  await appendUsageLog(repoAt(at), {
    slug: "budget-fixture",
    task: over.task ?? "compose",
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    fallback: over.fallback ?? null,
    tokensIn: 800,
    tokensOut: 700,
  });
}

describe("the daily budget count", () => {
  it("counts only rows for this task, on this UTC day", async () => {
    await seedRow(NOON);
    await seedRow(NOON, { task: "polish" });
    await seedRow(new Date("2026-08-17T23:59:59.999Z"));
    await seedRow(new Date("2026-08-19T00:00:00Z"));

    expect(await countComposeCallsToday(repoAt(NOON), "compose")).toBe(1);
  });

  it("opens a fresh window exactly at UTC midnight", async () => {
    const midnight = new Date(utcDayStartMs(NOON));
    await seedRow(midnight);
    await seedRow(new Date(midnight.getTime() - 1));

    expect(await countComposeCallsToday(repoAt(NOON), "compose")).toBe(1);
  });

  it("excludes fallbacks that never reached a provider, and counts the ones that did", async () => {
    await seedRow(NOON, { fallback: "budget_exceeded" });
    await seedRow(NOON, { fallback: "circuit_open" });
    // These three cost real tokens: the call was made, the answer was
    // just unusable.
    await seedRow(NOON, { fallback: "rate_limited" });
    await seedRow(NOON, { fallback: "url_mismatch" });
    await seedRow(NOON, { fallback: "timeout" });

    expect(await countComposeCallsToday(repoAt(NOON), "compose")).toBe(3);
  });

  it("trips only once the cap is reached", async () => {
    await seedRow(NOON);
    await seedRow(NOON);

    expect(await checkBudgetGuard(repoAt(NOON), { task: "compose", cap: 3 })).toBeNull();
    expect(await checkBudgetGuard(repoAt(NOON), { task: "compose", cap: 2 })).toMatchObject({
      reason: "budget_exceeded",
    });
  });
});

describe("composeReply against the cap", () => {
  function createDeps(cap: number): { deps: ComposeReplyDeps; aiCalls: number[] } {
    const aiCalls: number[] = [];
    const ai = {
      run: async () => {
        aiCalls.push(1);
        return {
          response: FAITHFUL_SECTION,
          usage: { prompt_tokens: 812, completion_tokens: 731 },
        };
      },
    } as unknown as Ai;

    const env = {
      DB: handle.db,
      AI: ai,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
      ANTHROPIC_API_KEY: "sk-ant-test",
      SLACK_BOT_USER_ID: "U000BOT",
      SLACK_ALLOWED_CHANNEL_IDS: "C1",
      SLACK_ADMIN_USER_IDS: "U1",
      COMPOSE_PROVIDER: "workers-ai",
      AUTHOR_PROVIDER: "claude",
      POLISH_PROVIDER: "workers-ai",
      CLAUDE_MODEL: "",
      SITE_API_BASE: "https://takazudomodular.com",
    } satisfies Env;

    const fetchImpl = (async () => {
      throw new Error("compose must not reach the network on the workers-ai path");
    }) as FetchLike;

    return { deps: { env, fetch: fetchImpl, now: () => NOON, dailyCap: cap }, aiCalls };
  }

  const input = { ref: productRef, arrivalSchedule: null, discord: false, direct: false };

  /**
   * The regression a naive count would cause: every trip writes its own
   * `usage_log` row, so counting rows rather than *calls* would keep the
   * budget tripped off its own logging — and, symmetrically, excluding
   * every fallback would let a burst of failed calls run uncapped.
   */
  it("spends the cap, then falls back for the rest of the day without calling the provider again", async () => {
    const { deps, aiCalls } = createDeps(2);

    const first = await composeReply(deps, input);
    const second = await composeReply(deps, input);
    const third = await composeReply(deps, input);
    const fourth = await composeReply(deps, input);

    expect([first.usedFallback, second.usedFallback]).toEqual([false, false]);
    expect(third.fallback).toMatchObject({ guard: "budget", reason: "budget_exceeded" });
    expect(fourth.fallback).toMatchObject({ guard: "budget", reason: "budget_exceeded" });
    expect(aiCalls).toHaveLength(2);

    const rows = await handle.db
      .prepare("SELECT fallback FROM usage_log ORDER BY id")
      .all<{ fallback: string | null }>();
    expect(rows.results.map((row) => row.fallback)).toEqual([null, null, "budget_exceeded", "budget_exceeded"]);
    expect(await countComposeCallsToday(repoAt(NOON), "compose")).toBe(2);
  });

  it("starts the next UTC day with the full cap", async () => {
    const { deps, aiCalls } = createDeps(1);
    await composeReply(deps, input);
    expect((await composeReply(deps, input)).usedFallback).toBe(true);

    const tomorrow: ComposeReplyDeps = { ...deps, now: () => new Date("2026-08-19T00:00:00Z") };
    expect((await composeReply(tomorrow, input)).usedFallback).toBe(false);
    expect(aiCalls).toHaveLength(2);
  });
});
