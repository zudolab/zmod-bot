/**
 * Thread inheritance (issue #27): a follow-up `@`-mention carrying only
 * modifiers (`@bot --discord`) reuses what the thread already resolved,
 * instead of making the operator retype the product name.
 *
 * Driven end-to-end through runDeliveryPass against the Miniflare test
 * env — one pass per turn, so each turn sees the previous turn's
 * committed `jobs.resolved_context` exactly as production would. The
 * assertions that matter are on what reaches composeReply (which product,
 * which flags, which arrival date), because that is what the operator
 * ends up pasting to a customer.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import {
  parseResolvedJobContext,
  recordIncomingEvent,
  upsertProductRef,
  type RepoDeps,
} from "../../src/db/repos";
import type { ProductCategory } from "../../src/db/schema";
import { runDeliveryPass, type ComposeReplyFn } from "../../src/jobs/worker";
import { normalizeAlias } from "../../src/refs/resolve";
import { ACTION_IDS, NO_PRODUCT_QUERY_REASON, USAGE_TEXT } from "../../src/slack/commands";
import { CREATE_REFERENCE_ACTION_ID } from "../../src/slack/blocks";
import type { ComposeReplyInput } from "../../src/reply/compose";
import { renderDeterministicReply } from "../../src/reply/render";
import type { FetchLike, SleepFn } from "../../src/types";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

interface FakeFetchCall {
  body: Record<string, unknown>;
}

function createFakeFetch(): { fetch: FetchLike; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ body });
    return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: "999.001" }), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

const noWaitSleep: SleepFn = async () => {
  /* instant -- see CLAUDE.md "no real timers" */
};

function createFakeComposeReply(): { composeReply: ComposeReplyFn; calls: ComposeReplyInput[] } {
  const calls: ComposeReplyInput[] = [];
  const composeReply: ComposeReplyFn = async (_deps, input) => {
    calls.push(input);
    // The deterministic renderer, not a placeholder: `variant-match`
    // literal blocks are gated inside it (src/reply/render.ts
    // includesLiteralBlock), so a test that only inspected the *inputs*
    // could not tell a dropped notice from a delivered one.
    return {
      text: renderDeterministicReply({
        ref: input.ref,
        flags: { direct: input.direct, discord: input.discord },
        arrivalSchedule: input.arrivalSchedule,
        ...(input.purchased === undefined ? {} : { purchased: input.purchased }),
        ...(input.variantText === undefined ? {} : { variantText: input.variantText }),
      }),
      usedFallback: false,
    };
  };
  return { composeReply, calls };
}

describe("thread inheritance (issue #27)", () => {
  let env: TestEnvHandle | undefined;
  const clockMs = 1_700_000_000_000;
  let deps: RepoDeps;
  let fakeEnv: Env;
  let eventSeq = 0;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    eventSeq = 0;
    deps = { db: env.db, now: () => new Date(clockMs) };
    fakeEnv = {
      DB: env.db,
      AI: {} as Ai,
      SLACK_BOT_TOKEN: "xoxb-test-token",
      SLACK_SIGNING_SECRET: "test-signing-secret",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      SLACK_BOT_USER_ID: "U0BOT1",
      SLACK_ALLOWED_CHANNEL_IDS: "",
      SLACK_ADMIN_USER_IDS: "",
      COMPOSE_PROVIDER: "workers-ai",
      AUTHOR_PROVIDER: "claude",
      POLISH_PROVIDER: "workers-ai",
      CLAUDE_MODEL: "",
      SITE_API_BASE: "https://takazudomodular.com/api",
    };
  }

  async function seedProduct(slug: string, category: ProductCategory, alias: string, bodyMd?: string) {
    await upsertProductRef(deps, {
      slug,
      category,
      productUrl: `https://takazudomodular.com/products/${slug}/`,
      bodyMd: bodyMd ?? `# ${slug}\n\n- category: ${category}\n- aliases: ${alias}\n\n## Notes\n\nfixture\n`,
      aliases: [alias].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
  }

  async function seedJob(options: {
    rawText: string;
    kind?: "reply" | "polish" | "ref";
    channelId?: string;
    threadTs?: string;
  }) {
    eventSeq += 1;
    const job = await recordIncomingEvent(deps, {
      eventId: `ev-${eventSeq}`,
      eventType: "app_mention",
      kind: options.kind ?? "reply",
      channelId: options.channelId ?? "C1",
      threadTs: options.threadTs ?? "100.000",
      actorUserId: "U1",
      rawText: options.rawText,
    });
    if (!job) throw new Error(`seedJob: ev-${eventSeq} was not created`);
    return job;
  }

  /** One delivery pass — i.e. one turn — with a fresh compose/fetch spy. */
  async function runTurn() {
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();
    const result = await runDeliveryPass({
      env: fakeEnv,
      fetch,
      now: () => new Date(clockMs),
      sleep: noWaitSleep,
      composeReply,
    });
    return { result, postCalls: calls, composeCalls };
  }

  async function readContext(jobId: number) {
    const row = await env!.db
      .prepare("SELECT resolved_context FROM jobs WHERE id = ?")
      .bind(jobId)
      .first<{ resolved_context: string | null }>();
    return parseResolvedJobContext(row?.resolved_context ?? null);
  }

  /** The exact message a modifier-only mention got before inheritance existed. */
  function expectDegradedToTodaysBehaviour(turn: Awaited<ReturnType<typeof runTurn>>) {
    expect(turn.result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(turn.composeCalls).toHaveLength(0); // above all: no reply for a guessed product
    const posted = JSON.stringify(turn.postCalls[0]?.body);
    expect(posted).toContain(NO_PRODUCT_QUERY_REASON);
    expect(posted).toContain(USAGE_TEXT.split("\n")[0]);
    expect(posted).not.toContain("rich_text_preformatted");
  }

  /* -----------------------------------------------------------------
   * Recording — the memory inheritance reads.
   * -------------------------------------------------------------- */

  it("a reply job that resolved a product records its slug/variant/arrival into resolved_context", async () => {
    await setup();
    await seedProduct("diy-widget", "general (built) / diy (kit)", "diy widget");
    const job = await seedJob({ rawText: "<@U0BOT1> diy widget kit 明後日" });

    await runTurn();

    expect(await readContext(job.id)).toEqual({
      slug: "diy-widget",
      variant: "kit",
      arrivalSchedule: expect.stringContaining("到着予定になります。"),
      variantText: "<@U0BOT1> diy widget kit 明後日",
    });
  });

  it("a reply job that only got as far as asking for an arrival date still records the product", async () => {
    // The product IS resolved even though the reply is not composed yet —
    // a follow-up must be able to inherit it from a turn that only asked.
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    const job = await seedJob({ rawText: "<@U0BOT1> general widget" });

    const turn = await runTurn();

    expect(JSON.stringify(turn.postCalls[0]?.body)).toContain(ACTION_IDS.arrivalPick);
    expect(await readContext(job.id)).toEqual({
      slug: "general-widget",
      variant: null,
      arrivalSchedule: null,
      variantText: "<@U0BOT1> general widget",
    });
  });

  /* -----------------------------------------------------------------
   * The three-turn chain — the case a naive "re-resolve the prior
   * mention's raw_text" design breaks.
   * -------------------------------------------------------------- */

  it("product -> --discord -> --direct keeps the product, and flags never accumulate", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");

    await seedJob({ rawText: "<@U0BOT1> general widget 明後日" });
    const first = await runTurn();
    expect(first.composeCalls).toHaveLength(1);
    expect(first.composeCalls[0]?.discord).toBe(false);
    expect(first.composeCalls[0]?.direct).toBe(false);
    const arrival = first.composeCalls[0]?.arrivalSchedule;
    expect(arrival).toContain("到着予定になります。");

    await seedJob({ rawText: "<@U0BOT1> --discord" });
    const second = await runTurn();
    expect(second.composeCalls).toHaveLength(1);
    expect(second.composeCalls[0]?.ref.slug).toBe("general-widget");
    expect(second.composeCalls[0]?.discord).toBe(true);
    expect(second.composeCalls[0]?.direct).toBe(false);
    expect(second.composeCalls[0]?.arrivalSchedule).toBe(arrival);

    // The third turn's prior job is the `--discord` one, whose raw_text
    // names no product at all — inheritance reads resolved_context, not
    // that text, which is the whole point of the chain.
    await seedJob({ rawText: "<@U0BOT1> --direct" });
    const third = await runTurn();
    expect(third.composeCalls).toHaveLength(1);
    expect(third.composeCalls[0]?.ref.slug).toBe("general-widget");
    expect(third.composeCalls[0]?.direct).toBe(true);
    expect(third.composeCalls[0]?.discord).toBe(false); // NOT carried over from turn 2
    expect(third.composeCalls[0]?.arrivalSchedule).toBe(arrival);
  });

  /**
   * Regression (epic #22 cross-wave seam): `variant-match` literal blocks
   * are byte-exact customer-facing business text — the operator pastes the
   * reply into Mercari Shops verbatim — and they are gated by the text
   * that named the purchased variant. Inheritance originally re-read that
   * text from the *immediately prior* turn's `raw_text`, which on turn 3
   * of a chain is itself modifier-only (`@bot --discord`) and carries no
   * needle, so the notice silently vanished from turn 3 onward with no
   * error anywhere. Fixed by carrying the naming turn's text forward in
   * ResolvedJobContext.variantText.
   */
  it("a variant-match literal block still ships on turn 3 of product -> --discord -> --direct", async () => {
    await setup();
    const notice = "（Lite版レールのリニューアルについてのご案内）";
    await seedProduct(
      "rail-widget",
      "small",
      "rail widget",
      [
        "# rail-widget",
        "",
        "- category: small",
        "- aliases: rail widget",
        "",
        "## Assembly Guide",
        "",
        "- rail-widget 組み立て方法: https://takazudomodular.com/guides/how-to-build-rail-widget/",
        "",
        "Intro text: 組み立てにつきましては、以下をご参考にお願い致します。",
        "",
        "## Lite Version Renewal Notice",
        "",
        "When the purchased product is a **Lite** variant, ALWAYS append the following notice after the assembly guide section.",
        "",
        "```",
        notice,
        "```",
        "",
      ].join("\n"),
    );

    // Turn 1 names the variant — "lite" is the needle, and this is the
    // only turn in the chain whose own text contains it.
    await seedJob({ rawText: "<@U0BOT1> rail widget lite" });
    const first = await runTurn();
    expect(first.composeCalls).toHaveLength(1);
    expect(first.composeCalls[0]?.variantText).toContain("lite");

    await seedJob({ rawText: "<@U0BOT1> --discord" });
    const second = await runTurn();
    expect(second.composeCalls).toHaveLength(1);
    expect(second.composeCalls[0]?.ref.slug).toBe("rail-widget");

    await seedJob({ rawText: "<@U0BOT1> --direct" });
    const third = await runTurn();
    expect(third.composeCalls).toHaveLength(1);
    expect(third.composeCalls[0]?.ref.slug).toBe("rail-widget");
    // The bug: turn 3's predecessor is the `--discord` turn, so the
    // gating text used to become "<@U0BOT1> --discord" here.
    expect(third.composeCalls[0]?.variantText).toContain("lite");

    // What the operator actually copies — asserted on all three turns, so
    // this cannot pass by the notice being absent everywhere.
    for (const turn of [first, second, third]) {
      expect(JSON.stringify(turn.postCalls[0]?.body)).toContain(notice);
    }

    // And the memory itself keeps pointing at the naming turn's text
    // rather than walking forward one turn at a time.
    const contexts = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const row = await env!.db
          .prepare("SELECT resolved_context FROM jobs WHERE event_id = ?")
          .bind(`ev-${n}`)
          .first<{ resolved_context: string | null }>();
        return parseResolvedJobContext(row?.resolved_context ?? null);
      }),
    );
    expect(contexts.map((context) => context?.variantText)).toEqual([
      "<@U0BOT1> rail widget lite",
      "<@U0BOT1> rail widget lite",
      "<@U0BOT1> rail widget lite",
    ]);
  });

  it("an inherited built/kit variant is carried, not re-guessed", async () => {
    await setup();
    await seedProduct("diy-widget", "general (built) / diy (kit)", "diy widget");
    await seedJob({ rawText: "<@U0BOT1> diy widget kit 明日" });
    await runTurn();

    await seedJob({ rawText: "<@U0BOT1> --direct" });
    const second = await runTurn();

    expect(second.composeCalls).toHaveLength(1);
    expect(second.composeCalls[0]?.ref.slug).toBe("diy-widget");
    expect(second.composeCalls[0]?.purchased).toBe("kit");
  });

  /* -----------------------------------------------------------------
   * Arrival date.
   * -------------------------------------------------------------- */

  it("a follow-up naming an arrival overrides the inherited one; one naming none inherits it", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedJob({ rawText: "<@U0BOT1> general widget 明日" });
    const first = await runTurn();
    const tomorrow = first.composeCalls[0]?.arrivalSchedule;

    await seedJob({ rawText: "<@U0BOT1> --discord 明々後日" });
    const overridden = await runTurn();
    expect(overridden.composeCalls[0]?.arrivalSchedule).not.toBe(tomorrow);
    expect(overridden.composeCalls[0]?.arrivalSchedule).toContain("明々後日");

    await seedJob({ rawText: "<@U0BOT1> --direct" });
    const inherited = await runTurn();
    // Falls back to the *latest* recorded arrival, i.e. the overridden one.
    expect(inherited.composeCalls[0]?.arrivalSchedule).toBe(overridden.composeCalls[0]?.arrivalSchedule);
  });

  it("a follow-up in a thread whose product never got an arrival date asks, rather than composing without one", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedJob({ rawText: "<@U0BOT1> general widget" });
    await runTurn(); // posts the arrival picker, records slug with a null arrival

    await seedJob({ rawText: "<@U0BOT1> --discord" });
    const second = await runTurn();

    expect(second.composeCalls).toHaveLength(0);
    expect(JSON.stringify(second.postCalls[0]?.body)).toContain(ACTION_IDS.arrivalPick);
  });

  /* -----------------------------------------------------------------
   * Inherits nothing when the mention names a product.
   * -------------------------------------------------------------- */

  it("a follow-up naming a different product resolves to that product and inherits nothing", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedProduct("other-widget", "general", "other widget");
    await seedJob({ rawText: "<@U0BOT1> general widget 明後日" });
    await runTurn();

    await seedJob({ rawText: "<@U0BOT1> other widget" });
    const second = await runTurn();

    // Names its own product, so it inherits neither the slug nor the
    // arrival date — with no arrival of its own it must ask, exactly as
    // it would in a thread with no history at all.
    expect(second.composeCalls).toHaveLength(0);
    expect(JSON.stringify(second.postCalls[0]?.body)).toContain(ACTION_IDS.arrivalPick);

    await seedJob({ rawText: "<@U0BOT1> other widget 明日" });
    const third = await runTurn();
    expect(third.composeCalls[0]?.ref.slug).toBe("other-widget");
  });

  /* -----------------------------------------------------------------
   * Degradation — every miss falls back to exactly today's behaviour.
   * -------------------------------------------------------------- */

  it("a modifier-only mention in a thread with no prior resolved job degrades to today's error", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedJob({ rawText: "<@U0BOT1> --discord" });

    expectDegradedToTodaysBehaviour(await runTurn());
  });

  it("a top-level mention never inherits, even from a resolved thread in the same channel", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedJob({ rawText: "<@U0BOT1> general widget 明後日", threadTs: "100.000" });
    await runTurn();

    // src/slack/events.ts normalises a top-level mention to
    // thread_ts = event.ts, so it is alone in a thread of its own.
    await seedJob({ rawText: "<@U0BOT1> --discord", threadTs: "555.000" });

    expectDegradedToTodaysBehaviour(await runTurn());
  });

  it("a polish or ref job in the thread is never treated as prior reply context", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedJob({ rawText: "<@U0BOT1> polish\nお世話になります。", kind: "polish" });
    await seedJob({ rawText: "<@U0BOT1> ref show general-widget", kind: "ref" });
    await runTurn(); // both complete, neither resolves a reply context

    await seedJob({ rawText: "<@U0BOT1> --discord" });

    expectDegradedToTodaysBehaviour(await runTurn());
  });

  it("a polish job posted after the reply does not shadow the reply's context", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedJob({ rawText: "<@U0BOT1> general widget 明後日" });
    await runTurn();
    await seedJob({ rawText: "<@U0BOT1> polish\nお世話になります。", kind: "polish" });
    await runTurn();

    await seedJob({ rawText: "<@U0BOT1> --discord" });
    const third = await runTurn();

    expect(third.composeCalls[0]?.ref.slug).toBe("general-widget");
  });

  it("a prior job whose resolved_context is malformed JSON degrades to no inheritance", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    const first = await seedJob({ rawText: "<@U0BOT1> general widget 明後日" });
    await runTurn();
    await env!.db
      .prepare("UPDATE jobs SET resolved_context = ? WHERE id = ?")
      .bind('{"slug": ', first.id)
      .run();

    await seedJob({ rawText: "<@U0BOT1> --discord" });

    expectDegradedToTodaysBehaviour(await runTurn());
  });

  it("a remembered slug that no longer exists degrades instead of replying about nothing", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    const first = await seedJob({ rawText: "<@U0BOT1> general widget 明後日" });
    await runTurn();
    await env!.db
      .prepare("UPDATE jobs SET resolved_context = ? WHERE id = ?")
      .bind(JSON.stringify({ slug: "retired-widget", variant: null, arrivalSchedule: null }), first.id)
      .run();

    await seedJob({ rawText: "<@U0BOT1> --discord" });

    expectDegradedToTodaysBehaviour(await runTurn());
  });

  /* -----------------------------------------------------------------
   * Parse before resolve — the reordering inheritance required.
   * -------------------------------------------------------------- */

  it("a product turn and its follow-up claimed in the SAME delivery pass still inherit", async () => {
    // The cron sweep claims up to CLAIM_BATCH_SIZE jobs at once, so two
    // mentions typed seconds apart are routinely delivered in one pass.
    // Inheritance then depends on the first job's resolved_context being
    // committed before the second is composed, which only holds because
    // deliverClaimedJob runs them in id order, one after the other.
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedJob({ rawText: "<@U0BOT1> general widget 明後日" });
    await seedJob({ rawText: "<@U0BOT1> --discord" });

    const turn = await runTurn();

    expect(turn.result).toEqual({ claimed: 2, succeeded: 2, failed: 0 });
    expect(turn.composeCalls).toHaveLength(2);
    expect(turn.composeCalls[1]?.ref.slug).toBe("general-widget");
    expect(turn.composeCalls[1]?.discord).toBe(true);
  });

  it("`help` reaches the usage text — the mention is parsed before it is resolved", async () => {
    // Resolving first (the pre-#27 order) answered `@bot help` with the
    // missing-reference card, because "help" matches no product. A
    // modifier-only mention would have hit the same dead end, which is
    // why the order had to change.
    await setup();
    await seedJob({ rawText: "<@U0BOT1> help" });

    const turn = await runTurn();

    const posted = JSON.stringify(turn.postCalls[0]?.body);
    expect(posted).toContain(USAGE_TEXT.split("\n")[0]);
    expect(posted).not.toContain(CREATE_REFERENCE_ACTION_ID);
  });

  /* -----------------------------------------------------------------
   * Isolation — two threads live at once.
   * -------------------------------------------------------------- */

  it("inheritance never crosses threads or channels, with two threads live at once", async () => {
    await setup();
    await seedProduct("general-widget", "general", "general widget");
    await seedProduct("other-widget", "general", "other widget");

    // Thread A in C1 and thread B in C2, both resolved, interleaved.
    await seedJob({ rawText: "<@U0BOT1> general widget 明日", channelId: "C1", threadTs: "100.000" });
    await seedJob({ rawText: "<@U0BOT1> other widget 明後日", channelId: "C2", threadTs: "200.000" });
    // A third thread in C1 sharing thread B's thread_ts — proves the
    // lookup keys on the channel too, not on thread_ts alone.
    await seedJob({ rawText: "<@U0BOT1> other widget 明日", channelId: "C1", threadTs: "200.000" });
    await runTurn();

    await seedJob({ rawText: "<@U0BOT1> --discord", channelId: "C1", threadTs: "100.000" });
    const inA = await runTurn();
    expect(inA.composeCalls).toHaveLength(1);
    expect(inA.composeCalls[0]?.ref.slug).toBe("general-widget");

    await seedJob({ rawText: "<@U0BOT1> --direct", channelId: "C2", threadTs: "200.000" });
    const inB = await runTurn();
    expect(inB.composeCalls).toHaveLength(1);
    expect(inB.composeCalls[0]?.ref.slug).toBe("other-widget");
    expect(inB.composeCalls[0]?.direct).toBe(true);
    expect(inB.composeCalls[0]?.discord).toBe(false);

    // A thread that exists in one channel only must not leak into the
    // same thread_ts in another channel.
    await seedJob({ rawText: "<@U0BOT1> --discord", channelId: "C3", threadTs: "200.000" });
    expectDegradedToTodaysBehaviour(await runTurn());
  });
});
