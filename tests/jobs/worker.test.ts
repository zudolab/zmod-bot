/**
 * End-to-end delivery-pass tests: claim -> compose -> post -> done (or
 * failed/dead), against the Miniflare test env with an injected fake
 * `fetch` — no real network, no real timers (see CLAUDE.md
 * "Conventions").
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { recordIncomingEvent, upsertProductRef, type RepoDeps } from "../../src/db/repos";
import { runDeliveryPass, runJob, runScheduledSweep, type ComposeReplyFn } from "../../src/jobs/worker";
import { normalizeAlias } from "../../src/refs/resolve";
import { ACTION_IDS } from "../../src/slack/commands";
import { CREATE_REFERENCE_ACTION_ID } from "../../src/slack/blocks";
import type { ComposeReplyInput } from "../../src/reply/compose";
import type { FetchLike, SleepFn } from "../../src/types";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

interface FakeFetchCall {
  url: string;
  body: Record<string, unknown>;
}

/** Every call succeeds as chat.postMessage, unless `fail` is set. */
function createFakeFetch(options: { fail?: boolean } = {}): { fetch: FetchLike; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(input), body });
    if (options.fail) throw new Error("simulated network failure");
    return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: "999.001" }), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function noWaitSleep(): SleepFn {
  return async () => {
    /* instant -- see CLAUDE.md "no real timers" */
  };
}

/**
 * src/reply/compose.ts composeReply is issue #13's responsibility and its
 * real implementation throws `not implemented` until that branch merges
 * — src/jobs/worker.ts injects it (ComposeReplyFn) exactly so this test
 * can supply a deterministic fake instead of depending on it. See
 * src/jobs/worker.ts's module comment.
 */
function createFakeComposeReply(): { composeReply: ComposeReplyFn; calls: ComposeReplyInput[] } {
  const calls: ComposeReplyInput[] = [];
  const composeReply: ComposeReplyFn = async (_deps, input) => {
    calls.push(input);
    return { text: `[fake composed reply for ${input.ref.slug}]`, usedFallback: false };
  };
  return { composeReply, calls };
}

const SMALL_PRODUCT_MARKDOWN = `# Test Small Widget

- category: small
- product-url: https://takazudomodular.com/products/test-small-widget/
- aliases: test small widget, tsw

## Notes

Test fixture body for issue #10's delivery-worker tests.
`;

describe("delivery worker (issue #10)", () => {
  let env: TestEnvHandle | undefined;
  let clockMs = 1_700_000_000_000;
  let deps: RepoDeps;
  let fakeEnv: Env;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
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

  async function seedSmallProduct() {
    await upsertProductRef(deps, {
      slug: "test-small-widget",
      category: "small",
      productUrl: "https://takazudomodular.com/products/test-small-widget/",
      bodyMd: SMALL_PRODUCT_MARKDOWN,
      // upsertProductRef stores aliases verbatim -- normalize here the
      // same way seed/write time would (see src/refs/resolve.ts
      // normalizeAlias), so a query at lookup time can actually match.
      aliases: ["test small widget", "tsw"].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
  }

  async function seedReplyJob(eventId: string, rawText: string) {
    const job = await recordIncomingEvent(deps, {
      eventId,
      eventType: "app_mention",
      kind: "reply",
      channelId: "C1",
      threadTs: "100.000",
      actorUserId: "U1",
      rawText,
    });
    if (!job) throw new Error(`seedReplyJob: ${eventId} was not created`);
    return job;
  }

  it("drives a job pending -> done with exactly one chat.postMessage, no arrival buttons", async () => {
    await setup();
    await seedSmallProduct();
    await seedReplyJob("ev-happy", "<@U0BOT1> test small widget");
    const { fetch, calls } = createFakeFetch();
    const { composeReply } = createFakeComposeReply();

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]?.body.channel).toBe("C1");
    expect(calls[0]?.body.thread_ts).toBe("100.000");
    // Confirms this went through the real match+compose path, not a
    // resolver miss that also happens to post once and complete.
    const blocksText = JSON.stringify(calls[0]?.body.blocks);
    expect(blocksText).toContain("rich_text_preformatted");
    expect(blocksText).not.toContain(CREATE_REFERENCE_ACTION_ID);
    // `small` skips the arrival question entirely (issue #14) -- no
    // arrival-picker buttons on a small-category reply.
    expect(blocksText).not.toContain(ACTION_IDS.arrivalPick);
    expect(blocksText).not.toContain(ACTION_IDS.arrivalOther);

    const row = await env!.db.prepare("SELECT state, completed_at FROM jobs WHERE event_id = ?").bind("ev-happy").first<{
      state: string;
      completed_at: number | null;
    }>();
    expect(row?.state).toBe("done");
    expect(row?.completed_at).not.toBeNull();
  });

  it("re-delivering the same event is a no-op (recordIncomingEvent already de-dups)", async () => {
    await setup();
    await seedSmallProduct();
    await seedReplyJob("ev-dedup", "<@U0BOT1> test small widget");
    const { fetch, calls } = createFakeFetch();
    const { composeReply } = createFakeComposeReply();

    await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });
    // A second delivery pass has nothing left to claim -- the job is done.
    const second = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });

    expect(second).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(calls).toHaveLength(1);
  });

  it("a resolver miss posts the 'no reference yet' message with a create-reference button and completes the job", async () => {
    await setup();
    // Deliberately no product seeded -- every query misses.
    await seedReplyJob("ev-miss", "<@U0BOT1> some totally unknown product xyz");
    const { fetch, calls } = createFakeFetch();

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    const blocks = JSON.stringify(calls[0]?.body.blocks);
    expect(blocks).toContain(CREATE_REFERENCE_ACTION_ID);

    const row = await env!.db.prepare("SELECT state FROM jobs WHERE event_id = ?").bind("ev-miss").first<{
      state: string;
    }>();
    expect(row?.state).toBe("done");
  });

  it("drives 5 consecutive failures to dead and makes no 6th attempt", async () => {
    await setup();
    await seedSmallProduct();
    const job = await seedReplyJob("ev-always-fails", "<@U0BOT1> test small widget");
    const { fetch, calls } = createFakeFetch({ fail: true });
    const { composeReply } = createFakeComposeReply();

    for (let i = 0; i < 5; i++) {
      const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });
      expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
      clockMs += 31 * 60_000; // past the max 30min backoff, regardless of which attempt this was
    }

    const row = await env!.db
      .prepare("SELECT state, attempts, last_error FROM jobs WHERE id = ?")
      .bind(job.id)
      .first<{ state: string; attempts: number; last_error: string | null }>();
    expect(row?.state).toBe("dead");
    expect(row?.attempts).toBe(5);
    expect(row?.last_error).toBeTruthy();

    const sixth = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });
    expect(sixth).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(calls).toHaveLength(5); // no 6th chat.postMessage attempt
  });

  it("a general-category match with no arrival date typed posts the arrival-date picker instead of guessing", async () => {
    await setup();
    await upsertProductRef(deps, {
      slug: "test-general-widget",
      category: "general",
      productUrl: "https://takazudomodular.com/products/test-general-widget/",
      bodyMd: `# Test General Widget\n\n- category: general\n- aliases: test general widget\n\n## Notes\n\nfixture\n`,
      aliases: ["test general widget"].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    await seedReplyJob("ev-general", "<@U0BOT1> test general widget");
    const { fetch, calls } = createFakeFetch();
    // Never reaches composeReply -- the arrival picker short-circuits
    // before compose is called (see src/jobs/worker.ts composeMatchPayload).
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(composeCalls).toHaveLength(0);
    const blocksText = JSON.stringify(calls[0]?.body.blocks);
    expect(blocksText).toContain(ACTION_IDS.arrivalPick);
    expect(blocksText).toContain(ACTION_IDS.arrivalOther);
    expect(blocksText).not.toContain("rich_text_preformatted"); // not the final reply yet

    const row = await env!.db.prepare("SELECT state FROM jobs WHERE event_id = ?").bind("ev-general").first<{
      state: string;
    }>();
    expect(row?.state).toBe("done"); // asking a question is a completed response, not a dead end
  });

  it("a general-category match with an arrival date typed in the mention composes the final reply directly", async () => {
    await setup();
    await upsertProductRef(deps, {
      slug: "test-general-widget-2",
      category: "general",
      productUrl: "https://takazudomodular.com/products/test-general-widget-2/",
      bodyMd: `# Test General Widget 2\n\n- category: general\n- aliases: test general widget 2\n\n## Notes\n\nfixture\n`,
      aliases: ["test general widget 2"].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    await seedReplyJob("ev-general-arrival", "<@U0BOT1> test general widget 2 明後日");
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]?.arrivalSchedule).toContain("到着予定になります。");
    expect(composeCalls[0]?.discord).toBe(false);
    expect(composeCalls[0]?.direct).toBe(false);
    // A plain `general` match (not general-diy): purchased defaults to
    // "built", and the raw mention text is forwarded as variantText
    // regardless (src/reply/compose.ts gates variant-match literal
    // blocks on it; harmless when the product has none).
    expect(composeCalls[0]?.purchased).toBe("built");
    expect(composeCalls[0]?.variantText).toBe("<@U0BOT1> test general widget 2 明後日");
    const blocksText = JSON.stringify(calls[0]?.body.blocks);
    expect(blocksText).toContain("rich_text_preformatted");
    expect(blocksText).not.toContain(ACTION_IDS.arrivalPick);
  });

  it("a general-diy match forwards the resolved kit/built variant and the raw text to composeReply", async () => {
    await setup();
    await upsertProductRef(deps, {
      slug: "test-diy-widget",
      category: "general (built) / diy (kit)",
      productUrl: "https://takazudomodular.com/products/test-diy-widget/",
      bodyMd: `# Test DIY Widget\n\n- category: general (built) / diy (kit)\n- aliases: test diy widget\n\n## Notes\n\nfixture\n`,
      aliases: ["test diy widget"].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    const rawText = "<@U0BOT1> test diy widget kit 明日";
    await seedReplyJob("ev-diy-kit", rawText);
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(composeCalls).toHaveLength(1);
    // src/refs/resolve.ts detectVariant reads "kit" out of the raw
    // mention text -> ResolveResult.variant === "kit" -> forwarded here
    // as `purchased`, and the exact raw text is forwarded as
    // `variantText` so a variant-match literal block (e.g. zudo-rail's
    // Lite notice) could gate on it too.
    expect(composeCalls[0]?.purchased).toBe("kit");
    expect(composeCalls[0]?.variantText).toBe(rawText);
  });

  it("a general-diy match with no built/kit signal asks (variant_pick) rather than defaulting to built", async () => {
    await setup();
    await upsertProductRef(deps, {
      slug: "test-variant-widget",
      category: "general (built) / diy (kit)",
      productUrl: "https://takazudomodular.com/products/test-variant-widget/",
      bodyMd: `# Test Variant Widget\n\n- category: general (built) / diy (kit)\n- aliases: test variant widget\n\n## Notes\n\nfixture\n`,
      // Deliberately no "diy"/"kit"/"built" substring in the alias or the
      // mention text below -- src/refs/resolve.ts detectVariant must
      // return undefined here (variant-ambiguous), never guess "built".
      aliases: ["test variant widget"].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    await seedReplyJob("ev-variant-ambiguous", "<@U0BOT1> test variant widget");
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(composeCalls).toHaveLength(0); // never guessed a variant and composed
    const blocksText = JSON.stringify(calls[0]?.body.blocks);
    expect(blocksText).toContain(ACTION_IDS.variantPick);
    expect(blocksText).not.toContain("rich_text_preformatted");
  });

  it("polish/ref job kinds fail with a clear not-implemented-yet error (issues #16/#17)", async () => {
    await setup();
    const job = await seedReplyJob("ev-polish", "<@U0BOT1> polish something");
    // recordIncomingEvent's kind param drives this, not the raw_text --
    // stamp it directly to exercise runJob's kind dispatch.
    await env!.db.prepare("UPDATE jobs SET kind = 'polish' WHERE id = ?").bind(job.id).run();
    const { fetch, calls } = createFakeFetch();

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(calls).toHaveLength(0);
    const row = await env!.db.prepare("SELECT last_error FROM jobs WHERE id = ?").bind(job.id).first<{
      last_error: string | null;
    }>();
    expect(row?.last_error).toContain("not implemented yet");
  });

  it("runJob alone (no claim/state bookkeeping) composes and posts for a reply job", async () => {
    await setup();
    await seedSmallProduct();
    const job = await seedReplyJob("ev-runjob-direct", "<@U0BOT1> test small widget");
    const { fetch, calls } = createFakeFetch();
    const { composeReply } = createFakeComposeReply();

    await runJob(fakeEnv, job, { fetch, now: () => new Date(clockMs), sleep: noWaitSleep(), composeReply });

    expect(calls).toHaveLength(1);
    // runJob itself never touches job state -- deliverClaimedJob (inside
    // runDeliveryPass) owns every transition.
    const row = await env!.db.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.id).first<{ state: string }>();
    expect(row?.state).toBe("pending");
  });

  it("runScheduledSweep never rejects, even when the delivery pass fails outright", async () => {
    await setup();
    // env.DB pointing at a disposed Miniflare instance -- delivery pass
    // and retention sweep should both throw internally and be caught.
    await env!.dispose();
    env = undefined;

    await expect(
      runScheduledSweep({ env: fakeEnv, fetch: createFakeFetch().fetch, now: () => new Date(clockMs) }),
    ).resolves.toBeUndefined();
  });
});
