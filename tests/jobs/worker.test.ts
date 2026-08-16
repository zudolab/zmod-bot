/**
 * End-to-end delivery-pass tests: claim -> compose -> post -> done (or
 * failed/dead), against the Miniflare test env with an injected fake
 * `fetch` — no real network, no real timers (see CLAUDE.md
 * "Conventions").
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { recordIncomingEvent, upsertProductRef, type RepoDeps } from "../../src/db/repos";
import { runDeliveryPass, runJob, runScheduledSweep } from "../../src/jobs/worker";
import { normalizeAlias } from "../../src/refs/resolve";
import { CREATE_REFERENCE_ACTION_ID } from "../../src/slack/blocks";
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

  it("drives a job pending -> done with exactly one chat.postMessage", async () => {
    await setup();
    await seedSmallProduct();
    await seedReplyJob("ev-happy", "<@U0BOT1> test small widget");
    const { fetch, calls } = createFakeFetch();

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]?.body.channel).toBe("C1");
    expect(calls[0]?.body.thread_ts).toBe("100.000");
    // Confirms this went through the real match+render path, not a
    // resolver miss that also happens to post once and complete.
    const blocksText = JSON.stringify(calls[0]?.body.blocks);
    expect(blocksText).toContain("rich_text_preformatted");
    expect(blocksText).not.toContain(CREATE_REFERENCE_ACTION_ID);

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

    await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });
    // A second delivery pass has nothing left to claim -- the job is done.
    const second = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });

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

    for (let i = 0; i < 5; i++) {
      const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });
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

  it("a general-category match fails loudly (no arrival-date source yet) rather than guessing a delivery date", async () => {
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

    const result = await runDeliveryPass({ env: fakeEnv, fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(calls).toHaveLength(0); // never reached the Slack post

    const row = await env!.db.prepare("SELECT state, last_error FROM jobs WHERE event_id = ?").bind("ev-general").first<{
      state: string;
      last_error: string | null;
    }>();
    expect(row?.state).toBe("failed");
    expect(row?.last_error).toContain("arrival-date");
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

    await runJob(fakeEnv, job, { fetch, now: () => new Date(clockMs), sleep: noWaitSleep() });

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
