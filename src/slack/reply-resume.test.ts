/**
 * Approving an authored reference resumes the reply the original mention
 * asked for, posting it into that mention's own thread (issue #26,
 * epic #22) — and the interaction path records what it resolved so a
 * follow-up mention in the same thread has something to inherit.
 *
 * Against real D1 (Miniflare), like src/slack/ref-approval.test.ts: what
 * is under test here is the interaction between the commit's own
 * `consumed_at` fence and a customer-facing post, and the failure modes
 * are a duplicate post and a silently lost one — neither of which a
 * hand-rolled stub can be trusted to reproduce.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createRefDraft,
  getJobById,
  parseResolvedJobContext,
  recordIncomingEvent,
  upsertProductRef,
  type RepoDeps,
} from "../db/repos";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import { normalizeAlias } from "../refs/resolve";
import { ACTION_IDS, decodeButtonValue, encodeArrivalOptionArg, encodeButtonValue } from "./commands";
import { handleSlackInteractionsWithDeps, type SlackInteractionsDeps } from "./interactions";
import type { Env } from "../env";
import type { FetchLike, WaitUntilFn } from "../types";
import type { ComposeReplyInput, ComposeReplyResult } from "../reply/compose";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U0BOT1";
const ADMIN = "U_ADMIN";
const NOW_SECONDS = 1_760_000_000;
const NOW_MS = NOW_SECONDS * 1_000;

/** The mention's own channel/thread — deliberately NOT where the approval preview lives. */
const ORIGIN_CHANNEL = "C_ORIGIN";
const ORIGIN_THREAD = "100.000";
const PREVIEW_CHANNEL = "C_ADMIN";
const PREVIEW_TS = "200.000";

const SMALL_SLUG = "test-resume-small";
const SMALL_ALIAS = "test resume small";
const SMALL_BODY = [
  "# Test Resume Small",
  "",
  "- category: small",
  `- aliases: ${SMALL_ALIAS}`,
  "",
  "## Notes",
  "",
  "fixture",
  "",
].join("\n");

const GENERAL_SLUG = "test-resume-general";
const GENERAL_ALIAS = "test resume general";
const GENERAL_BODY = [
  "# Test Resume General",
  "",
  "- category: general",
  `- aliases: ${GENERAL_ALIAS}`,
  "",
  "## Notes",
  "",
  "fixture",
  "",
].join("\n");

const VARIANT_SLUG = "test-resume-variant";
const VARIANT_ALIAS = "test resume variant";
const VARIANT_BODY = [
  "# Test Resume Variant",
  "",
  "- category: general (built) / diy (kit)",
  `- aliases: ${VARIANT_ALIAS}`,
  "",
  "## Notes",
  "",
  "fixture",
  "",
].join("\n");

const encoder = new TextEncoder();

async function computeSignature(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

async function signedRequest(body: string): Promise<Request> {
  const timestamp = String(NOW_SECONDS);
  return new Request("https://example.com/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": await computeSignature(body, timestamp),
    },
    body,
  });
}

function clickBody(input: { actionId: string; value: string; userId?: string; actionTs?: string }): string {
  const payload = {
    type: "block_actions",
    user: { id: input.userId ?? ADMIN },
    container: { channel_id: PREVIEW_CHANNEL, message_ts: PREVIEW_TS },
    actions: [{ action_id: input.actionId, action_ts: input.actionTs ?? "1000.000001", value: input.value }],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

interface FakeCall {
  url: string;
  body: Record<string, unknown> | null;
}

/** `failUrlSuffix` fails just that one Slack method, leaving every other call succeeding — the preview-vs-reply independence check. */
function createFakeFetch(failUrlSuffix?: string): { fetch: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (failUrlSuffix !== undefined && url.endsWith(failUrlSuffix)) {
      return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, channel: "C_OK", ts: "999.001" }), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function makeWaitUntil(): { waitUntil: WaitUntilFn; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  return { waitUntil: (promise) => void scheduled.push(promise), scheduled };
}

function slackEnv(): Env {
  return {
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_ADMIN_USER_IDS: ADMIN,
  } as Env;
}

function createFakeComposeReply(): {
  composeReply: SlackInteractionsDeps["composeReply"];
  calls: ComposeReplyInput[];
} {
  const calls: ComposeReplyInput[] = [];
  return {
    calls,
    composeReply: async (_deps, input): Promise<ComposeReplyResult> => {
      calls.push(input);
      return { text: `[fake composed reply for ${input.ref.slug}]`, usedFallback: false };
    },
  };
}

describe("resuming the original reply after an approval", () => {
  let env: TestEnvHandle | undefined;
  let deps: RepoDeps;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    deps = { db: env.db, now: () => new Date(NOW_MS) };
  }

  /** The mention that missed and got offered the create_reference button. */
  async function seedOriginJob(eventId: string, rawText: string): Promise<number> {
    const job = await recordIncomingEvent(deps, {
      eventId,
      eventType: "app_mention",
      kind: "reply",
      channelId: ORIGIN_CHANNEL,
      threadTs: ORIGIN_THREAD,
      actorUserId: "U_HUMAN",
      rawText,
    });
    if (!job) throw new Error(`seedOriginJob: ${eventId} was not created`);
    return job.id;
  }

  function seedDraft(input: { slug: string; bodyMd: string; originJobId: number | null; baseVersion?: number | null; expiresAt?: number }) {
    return createRefDraft(deps, {
      slug: input.slug,
      category: "general",
      productUrl: null,
      bodyMd: input.bodyMd,
      baseVersion: input.baseVersion === undefined ? null : input.baseVersion,
      createdByUserId: ADMIN,
      expiresAt: input.expiresAt ?? NOW_MS + 1_800_000,
      originJobId: input.originJobId,
    });
  }

  async function click(input: {
    actionId: string;
    value: string;
    userId?: string;
    actionTs?: string;
    fetch: FetchLike;
    composeReply?: SlackInteractionsDeps["composeReply"];
  }): Promise<void> {
    const { waitUntil, scheduled } = makeWaitUntil();
    const request = await signedRequest(
      clickBody({
        actionId: input.actionId,
        value: input.value,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        ...(input.actionTs === undefined ? {} : { actionTs: input.actionTs }),
      }),
    );
    const response = await handleSlackInteractionsWithDeps(request, slackEnv(), {
      db: env!.db,
      now: () => new Date(NOW_MS),
      fetch: input.fetch,
      waitUntil,
      ...(input.composeReply === undefined ? {} : { composeReply: input.composeReply }),
    });
    expect(response.status).toBe(200);
    await Promise.all(scheduled);
  }

  function approveValue(draftId: string): string {
    return encodeButtonValue({ v: 1, id: draftId });
  }

  function postCalls(calls: FakeCall[]): FakeCall[] {
    return calls.filter((call) => call.url.endsWith("/chat.postMessage"));
  }

  it("posts the composed reply into the ORIGIN thread — chat.postMessage, not the chat.update that replaces the preview", async () => {
    await setup();
    const jobId = await seedOriginJob("ev-resume-small", `<@${BOT_USER_ID}> ${SMALL_ALIAS}`);
    const draft = await seedDraft({ slug: SMALL_SLUG, bodyMd: SMALL_BODY, originJobId: jobId });
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    await click({ actionId: ACTION_IDS.refApprove, value: approveValue(draft.id), fetch, composeReply });

    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]?.ref.slug).toBe(SMALL_SLUG);

    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body?.channel).toBe(ORIGIN_CHANNEL);
    expect(posts[0]?.body?.thread_ts).toBe(ORIGIN_THREAD);
    expect(JSON.stringify(posts[0]?.body?.blocks)).toContain("rich_text_preformatted");

    // The preview still gets replaced, in the admin's channel — a
    // different message, in a different place, from the reply above.
    const updates = calls.filter((call) => call.url.endsWith("/chat.update"));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body?.channel).toBe(PREVIEW_CHANNEL);
    expect(updates[0]?.body?.ts).toBe(PREVIEW_TS);
  });

  it("posts the ARRIVAL PICKER into the origin thread for a general product with no arrival date, with the origin job on its buttons", async () => {
    await setup();
    const jobId = await seedOriginJob("ev-resume-general", `<@${BOT_USER_ID}> ${GENERAL_ALIAS}`);
    const draft = await seedDraft({ slug: GENERAL_SLUG, bodyMd: GENERAL_BODY, originJobId: jobId });
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    await click({ actionId: ACTION_IDS.refApprove, value: approveValue(draft.id), fetch, composeReply });

    // A newly authored reference is frequently `general`, so this is the
    // COMMON resume, not an edge case: nothing is composed yet.
    expect(composeCalls).toHaveLength(0);

    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body?.channel).toBe(ORIGIN_CHANNEL);
    expect(posts[0]?.body?.thread_ts).toBe(ORIGIN_THREAD);

    const serialized = JSON.stringify(posts[0]?.body?.blocks);
    expect(serialized).toContain(ACTION_IDS.arrivalPick);
    // The buttons must carry the ORIGIN job, so the arrival_pick click
    // that follows finishes that job through the normal path.
    const buttonValue = (posts[0]?.body?.blocks as { elements?: { value?: string }[] }[])
      .flatMap((block) => block.elements ?? [])
      .map((element) => element.value)
      .find((value): value is string => typeof value === "string");
    expect(decodeButtonValue(buttonValue ?? "")?.id).toBe(String(jobId));
  });

  it("posts no reply when the approved draft has no origin job, and does not error", async () => {
    await setup();
    const draft = await seedDraft({ slug: SMALL_SLUG, bodyMd: SMALL_BODY, originJobId: null });
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    await click({ actionId: ACTION_IDS.refApprove, value: approveValue(draft.id), fetch, composeReply });

    expect(postCalls(calls)).toHaveLength(0);
    expect(composeCalls).toHaveLength(0);
    // ... and the approval itself still happened.
    expect(calls.filter((call) => call.url.endsWith("/chat.update"))).toHaveLength(1);
  });

  it("posts no reply when the draft is REJECTED", async () => {
    await setup();
    const jobId = await seedOriginJob("ev-resume-reject", `<@${BOT_USER_ID}> ${SMALL_ALIAS}`);
    const draft = await seedDraft({ slug: SMALL_SLUG, bodyMd: SMALL_BODY, originJobId: jobId });
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    await click({ actionId: ACTION_IDS.refReject, value: approveValue(draft.id), fetch, composeReply });

    expect(postCalls(calls)).toHaveLength(0);
    expect(composeCalls).toHaveLength(0);
  });

  it("posts no reply when the approval is REFUSED as stale — the resume is downstream of the commit, not of the click", async () => {
    await setup();
    await upsertProductRef(deps, {
      slug: SMALL_SLUG,
      category: "small",
      productUrl: null,
      bodyMd: SMALL_BODY,
      aliases: [SMALL_ALIAS].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    const jobId = await seedOriginJob("ev-resume-stale", `<@${BOT_USER_ID}> ${SMALL_ALIAS}`);
    // baseVersion null claims "this creates the product", but v1 already exists.
    const draft = await seedDraft({ slug: SMALL_SLUG, bodyMd: SMALL_BODY, originJobId: jobId, baseVersion: null });
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    await click({ actionId: ACTION_IDS.refApprove, value: approveValue(draft.id), fetch, composeReply });

    expect(calls.filter((call) => call.url.endsWith("/chat.postEphemeral"))).toHaveLength(1); // refused
    expect(postCalls(calls)).toHaveLength(0);
    expect(composeCalls).toHaveLength(0);
  });

  it("posts exactly one reply for a double approve click — the commit's own consumed_at fence, not a second mechanism", async () => {
    await setup();
    const jobId = await seedOriginJob("ev-resume-double", `<@${BOT_USER_ID}> ${SMALL_ALIAS}`);
    const draft = await seedDraft({ slug: SMALL_SLUG, bodyMd: SMALL_BODY, originJobId: jobId });
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    // Distinct action_ts on purpose: an identical one would be swallowed
    // by the interaction receipt, which would prove nothing about the
    // draft-level guard this test exists for.
    await click({ actionId: ACTION_IDS.refApprove, value: approveValue(draft.id), fetch, composeReply, actionTs: "1000.000001" });
    await click({ actionId: ACTION_IDS.refApprove, value: approveValue(draft.id), fetch, composeReply, actionTs: "1000.000002" });

    expect(postCalls(calls)).toHaveLength(1);
    expect(composeCalls).toHaveLength(1);
    // The second click was refused outright, so it never reached the commit.
    expect(calls.filter((call) => call.url.endsWith("/chat.postEphemeral"))).toHaveLength(1);
  });

  it("still posts the origin reply when replacing the preview fails — the two deliveries are independent", async () => {
    await setup();
    const jobId = await seedOriginJob("ev-resume-update-fails", `<@${BOT_USER_ID}> ${SMALL_ALIAS}`);
    const draft = await seedDraft({ slug: SMALL_SLUG, bodyMd: SMALL_BODY, originJobId: jobId });
    const { fetch, calls } = createFakeFetch("/chat.update");
    const { composeReply } = createFakeComposeReply();

    await click({ actionId: ACTION_IDS.refApprove, value: approveValue(draft.id), fetch, composeReply });

    // Attempted exactly once and failed: `ok: false` is not retried
    // (src/slack/api.ts), so this pins that the catch below it really ran.
    expect(calls.filter((call) => call.url.endsWith("/chat.update"))).toHaveLength(1);
    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body?.channel).toBe(ORIGIN_CHANNEL);
  });
});

/* -------------------------------------------------------------------------
 * Work item 2 — resolved_context on the interaction path (epic #22).
 * ---------------------------------------------------------------------- */

describe("recording resolved context from a disambiguation click", () => {
  let env: TestEnvHandle | undefined;
  let deps: RepoDeps;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    deps = { db: env.db, now: () => new Date(NOW_MS) };
  }

  async function seedJob(eventId: string, rawText: string): Promise<number> {
    const job = await recordIncomingEvent(deps, {
      eventId,
      eventType: "app_mention",
      kind: "reply",
      channelId: ORIGIN_CHANNEL,
      threadTs: ORIGIN_THREAD,
      actorUserId: "U_HUMAN",
      rawText,
    });
    if (!job) throw new Error(`seedJob: ${eventId} was not created`);
    return job.id;
  }

  async function clickValue(input: { actionId: string; value: string; fetch: FetchLike; composeReply?: SlackInteractionsDeps["composeReply"] }) {
    const { waitUntil, scheduled } = makeWaitUntil();
    const request = await signedRequest(clickBody({ actionId: input.actionId, value: input.value, userId: "U_HUMAN" }));
    const response = await handleSlackInteractionsWithDeps(request, slackEnv(), {
      db: env!.db,
      now: () => new Date(NOW_MS),
      fetch: input.fetch,
      waitUntil,
      ...(input.composeReply === undefined ? {} : { composeReply: input.composeReply }),
    });
    expect(response.status).toBe(200);
    await Promise.all(scheduled);
  }

  /**
   * The variant case specifically: "kit" exists nowhere in `raw_text`, so
   * a thread that inherits from this job can only learn it from
   * `resolved_context`.
   */
  it("a variant_pick click records the clicked variant on the job", async () => {
    await setup();
    await upsertProductRef(deps, {
      slug: VARIANT_SLUG,
      category: "general (built) / diy (kit)",
      productUrl: null,
      bodyMd: VARIANT_BODY,
      aliases: [VARIANT_ALIAS].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    // 明日 keeps the click from chaining into the arrival picker.
    const jobId = await seedJob("ev-ctx-variant", `<@${BOT_USER_ID}> ${VARIANT_ALIAS} 明日`);
    const { fetch } = createFakeFetch();
    const { composeReply } = createFakeComposeReply();

    await clickValue({
      actionId: `${ACTION_IDS.variantPick}_1`,
      value: encodeButtonValue({ v: 1, id: String(jobId), a: "kit" }),
      fetch,
      composeReply,
    });

    const context = parseResolvedJobContext((await getJobById(deps, jobId))?.resolved_context ?? null);
    expect(context?.slug).toBe(VARIANT_SLUG);
    expect(context?.variant).toBe("kit");
    expect(context?.arrivalSchedule).toContain("到着予定になります。");
  });

  it("an arrival_pick click records the date the click chose", async () => {
    await setup();
    await upsertProductRef(deps, {
      slug: GENERAL_SLUG,
      category: "general",
      productUrl: null,
      bodyMd: GENERAL_BODY,
      aliases: [GENERAL_ALIAS].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    const jobId = await seedJob("ev-ctx-arrival", `<@${BOT_USER_ID}> ${GENERAL_ALIAS}`);
    const { fetch } = createFakeFetch();
    const { composeReply } = createFakeComposeReply();

    await clickValue({
      actionId: `${ACTION_IDS.arrivalPick}_0`,
      value: encodeButtonValue({
        v: 1,
        id: String(jobId),
        a: encodeArrivalOptionArg({ dayLabel: "明後日月曜", month: 8, day: 18 }),
      }),
      fetch,
      composeReply,
    });

    const context = parseResolvedJobContext((await getJobById(deps, jobId))?.resolved_context ?? null);
    expect(context).toEqual({
      slug: GENERAL_SLUG,
      variant: "built",
      arrivalSchedule: "明後日月曜（8/18）到着予定になります。",
      // This mention named the product, so its own text is what gates
      // `variant-match` literal blocks for it and for anything inheriting
      // from it (ResolvedJobContext.variantText).
      variantText: `<@${BOT_USER_ID}> ${GENERAL_ALIAS}`,
    });
  });

  it("a variant_pick that chains into the arrival picker records the product before the date is known", async () => {
    await setup();
    await upsertProductRef(deps, {
      slug: VARIANT_SLUG,
      category: "general (built) / diy (kit)",
      productUrl: null,
      bodyMd: VARIANT_BODY,
      aliases: [VARIANT_ALIAS].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    const jobId = await seedJob("ev-ctx-variant-chain", `<@${BOT_USER_ID}> ${VARIANT_ALIAS}`);
    const { fetch } = createFakeFetch();

    await clickValue({
      actionId: `${ACTION_IDS.variantPick}_1`,
      value: encodeButtonValue({ v: 1, id: String(jobId), a: "kit" }),
      fetch,
    });

    const context = parseResolvedJobContext((await getJobById(deps, jobId))?.resolved_context ?? null);
    expect(context).toEqual({
      slug: VARIANT_SLUG,
      variant: "kit",
      arrivalSchedule: null,
      variantText: `<@${BOT_USER_ID}> ${VARIANT_ALIAS}`,
    });
  });
});
