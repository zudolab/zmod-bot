/**
 * Tests for POST /slack/interactions: the signature gate (mirrors
 * src/slack/events.test.ts's pattern), the URL-encoded `payload` form
 * field, idempotency, admin authorization on ref_approve/ref_reject, and
 * a full arrival_pick / arrival_other (modal) click-through against the
 * Miniflare-backed real D1 (storage-semantics territory — see
 * src/db/test-support.ts's two-tier rationale in CLAUDE.md).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createMockD1 } from "../db/test-support";
import { createRefDraft, getProductRefBySlug, recordIncomingEvent, upsertProductRef, type RepoDeps } from "../db/repos";
import { normalizeAlias } from "../refs/resolve";
import { ACTION_IDS, encodeArrivalOptionArg, encodeButtonValue } from "./commands";
import { CREATE_REFERENCE_ACTION_ID } from "./blocks";
import { handleSlackInteractionsWithDeps, type SlackInteractionsDeps } from "./interactions";
import type { Env } from "../env";
import type { FetchLike, WaitUntilFn } from "../types";
import type { ComposeReplyInput, ComposeReplyResult } from "../reply/compose";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U0BOT1";
const NOW_SECONDS = 1_760_000_000;
const NOW_MS = NOW_SECONDS * 1_000;

const encoder = new TextEncoder();

/** Independently-computed known-answer signature, matching src/slack/events.test.ts's pattern — the math under test is verify.ts's, already pinned separately in verify.test.ts; here it's a trusted given for building otherwise-correct requests. */
async function computeSignature(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

async function makeSignedRequest(body: string, overrides: { timestamp?: string; signature?: string } = {}): Promise<Request> {
  const timestamp = overrides.timestamp ?? String(NOW_SECONDS);
  const signature = overrides.signature ?? (await computeSignature(body, timestamp));
  return new Request("https://example.com/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    body,
  });
}

function formEncodedPayload(payload: Record<string, unknown>): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_ADMIN_USER_IDS: "U_ADMIN",
    ...overrides,
  } as Env;
}

function makeWaitUntil(): { waitUntil: WaitUntilFn; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  const waitUntil: WaitUntilFn = (promise) => {
    scheduled.push(promise);
  };
  return { waitUntil, scheduled };
}

interface FakeFetchCall {
  url: string;
  body: Record<string, unknown> | null;
}

function createFakeFetch(): { fetch: FetchLike; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (url.startsWith("https://hooks.slack.com/")) {
      // response_url success is the literal string "ok", not JSON — see src/slack/api.ts postToResponseUrl.
      return new Response("ok", { status: 200 });
    }
    if (url.endsWith("/chat.postEphemeral")) {
      return new Response(JSON.stringify({ ok: true, message_ts: "111.001" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, channel: body?.channel, ts: "999.001" }), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function createFakeComposeReply(): { composeReply: (deps: unknown, input: ComposeReplyInput) => Promise<ComposeReplyResult>; calls: ComposeReplyInput[] } {
  const calls: ComposeReplyInput[] = [];
  return {
    calls,
    composeReply: async (_deps, input) => {
      calls.push(input);
      return { text: `[fake composed reply for ${input.ref.slug}]`, usedFallback: false };
    },
  };
}

function makeDeps(overrides: Pick<SlackInteractionsDeps, "db" | "waitUntil"> & Partial<SlackInteractionsDeps>): SlackInteractionsDeps {
  return {
    now: () => new Date(NOW_MS),
    fetch: (async () => new Response("ok", { status: 200 })) as FetchLike,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------
 * Signature gate — mirrors src/slack/events.test.ts's pattern exactly,
 * against the URL-encoded form body instead of JSON.
 * ---------------------------------------------------------------------- */

describe("handleSlackInteractionsWithDeps -- signature gate", () => {
  it("401s an unsigned block_actions POST and does nothing", async () => {
    const body = formEncodedPayload({ type: "block_actions", actions: [{ action_id: "x", action_ts: "1", value: "v" }] });
    const request = new Request("https://example.com/slack/interactions", { method: "POST", body });
    const mockDb = createMockD1();
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

    expect(response.status).toBe(401);
    expect(mockDb.calls).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("401s a block_actions POST with a wrong signature", async () => {
    const body = formEncodedPayload({ type: "block_actions", actions: [] });
    const request = await makeSignedRequest(body, { signature: `v0=${"0".repeat(64)}` });
    const mockDb = createMockD1();
    const { waitUntil } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

    expect(response.status).toBe(401);
    expect(mockDb.calls).toHaveLength(0);
  });

  it("500s when SLACK_SIGNING_SECRET is not configured -- a deployment error, distinct from a 401", async () => {
    const body = formEncodedPayload({ type: "block_actions", actions: [] });
    const request = new Request("https://example.com/slack/interactions", { method: "POST", body });
    const { waitUntil } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(
      request,
      baseEnv({ SLACK_SIGNING_SECRET: "" }),
      makeDeps({ db: createMockD1(), waitUntil }),
    );

    expect(response.status).toBe(500);
  });

  it("400s a validly-signed request with no `payload` form field", async () => {
    const body = "not=the-right-field";
    const request = await makeSignedRequest(body);
    const mockDb = createMockD1();
    const { waitUntil } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

    expect(response.status).toBe(400);
    expect(mockDb.calls).toHaveLength(0);
  });

  it("400s a validly-signed request whose `payload` field is not valid JSON", async () => {
    const body = new URLSearchParams({ payload: "not json" }).toString();
    const request = await makeSignedRequest(body);
    const mockDb = createMockD1();
    const { waitUntil } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

    expect(response.status).toBe(400);
    expect(mockDb.calls).toHaveLength(0);
  });

  it("200s and does nothing for an interaction type this bot doesn't handle", async () => {
    const body = formEncodedPayload({ type: "shortcut" });
    const request = await makeSignedRequest(body);
    const mockDb = createMockD1();
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

    expect(response.status).toBe(200);
    expect(mockDb.calls).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("200s and does nothing for a block_actions payload with no recognizable action/user", async () => {
    const body = formEncodedPayload({ type: "block_actions", actions: [] });
    const request = await makeSignedRequest(body);
    const mockDb = createMockD1();
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

    expect(response.status).toBe(200);
    expect(mockDb.calls).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------
 * End-to-end against real D1 (Miniflare) -- idempotency, admin gating,
 * and the arrival_pick / arrival_other click-through.
 * ---------------------------------------------------------------------- */

function blockActionsPayload(input: {
  actionId: string;
  value: string;
  userId: string;
  actionTs?: string;
  channelId?: string;
  messageTs?: string;
  responseUrl?: string;
  triggerId?: string;
}): Record<string, unknown> {
  return {
    type: "block_actions",
    user: { id: input.userId },
    channel: { id: input.channelId ?? "C1" },
    message: { ts: input.messageTs ?? "200.000" },
    container: { channel_id: input.channelId ?? "C1", message_ts: input.messageTs ?? "200.000" },
    response_url: input.responseUrl ?? "https://hooks.slack.com/actions/FAKE",
    trigger_id: input.triggerId,
    actions: [{ action_id: input.actionId, action_ts: input.actionTs ?? "1000.000001", value: input.value }],
  };
}

describe("handleSlackInteractionsWithDeps -- against real D1", () => {
  let env: TestEnvHandle | undefined;
  let repoDeps: RepoDeps;
  let fakeEnv: Env;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    repoDeps = { db: env.db, now: () => new Date(NOW_MS) };
    fakeEnv = baseEnv();
  }

  async function seedReplyJob(eventId: string, rawText: string): Promise<number> {
    const job = await recordIncomingEvent(repoDeps, {
      eventId,
      eventType: "app_mention",
      kind: "reply",
      channelId: "C1",
      threadTs: "100.000",
      actorUserId: "U_HUMAN",
      rawText,
    });
    if (!job) throw new Error(`seedReplyJob: ${eventId} was not created`);
    return job.id;
  }

  const GENERAL_PRODUCT_MARKDOWN = `# Test General Widget\n\n- category: general\n- aliases: test general widget\n\n## Notes\n\nfixture\n`;

  async function seedGeneralProduct(slug: string) {
    await upsertProductRef(repoDeps, {
      slug,
      category: "general",
      productUrl: `https://takazudomodular.com/products/${slug}/`,
      bodyMd: GENERAL_PRODUCT_MARKDOWN,
      aliases: ["test general widget"].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
  }

  it("a repeated interaction (same action_ts) performs its effect exactly once", async () => {
    await setup();
    await seedGeneralProduct("test-general-widget-a");
    const jobId = await seedReplyJob("ev-a", "<@U0BOT1> test general widget");
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const value = encodeButtonValue({
      v: 1,
      id: String(jobId),
      a: encodeArrivalOptionArg({ dayLabel: "明後日月曜", month: 8, day: 18 }),
    });
    const body = formEncodedPayload(blockActionsPayload({ actionId: `${ACTION_IDS.arrivalPick}_0`, value, userId: "U_HUMAN" }));

    const first = await makeSignedRequest(body);
    const { waitUntil: waitUntil1, scheduled: scheduled1 } = makeWaitUntil();
    const res1 = await handleSlackInteractionsWithDeps(first, fakeEnv, makeDeps({ db: env!.db, waitUntil: waitUntil1, fetch, composeReply }));
    expect(res1.status).toBe(200);
    await Promise.all(scheduled1);

    const second = await makeSignedRequest(body); // identical action_ts -- a Slack retry or a double-click
    const { waitUntil: waitUntil2, scheduled: scheduled2 } = makeWaitUntil();
    const res2 = await handleSlackInteractionsWithDeps(second, fakeEnv, makeDeps({ db: env!.db, waitUntil: waitUntil2, fetch, composeReply }));
    expect(res2.status).toBe(200);
    await Promise.all(scheduled2);

    expect(composeCalls).toHaveLength(1); // the effect ran exactly once
    expect(calls.filter((call) => call.url.startsWith("https://hooks.slack.com/"))).toHaveLength(1);
  });

  it("arrival_pick click composes and posts the final reply via response_url, with the render-time date, not the click-time one", async () => {
    await setup();
    await seedGeneralProduct("test-general-widget-b");
    const jobId = await seedReplyJob("ev-b", "<@U0BOT1> test general widget");
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const value = encodeButtonValue({
      v: 1,
      id: String(jobId),
      a: encodeArrivalOptionArg({ dayLabel: "明後日月曜", month: 8, day: 18 }),
    });
    const body = formEncodedPayload(blockActionsPayload({ actionId: `${ACTION_IDS.arrivalPick}_1`, value, userId: "U_HUMAN" }));
    const request = await makeSignedRequest(body);
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, fakeEnv, makeDeps({ db: env!.db, waitUntil, fetch, composeReply }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]?.arrivalSchedule).toBe("明後日月曜（8/18）到着予定になります。");
    expect(composeCalls[0]?.purchased).toBe("built");
    expect(composeCalls[0]?.variantText).toBe("<@U0BOT1> test general widget");

    const responseUrlCalls = calls.filter((call) => call.url.startsWith("https://hooks.slack.com/"));
    expect(responseUrlCalls).toHaveLength(1);
    expect(responseUrlCalls[0]?.body?.replace_original).toBe(true);
    expect(JSON.stringify(responseUrlCalls[0]?.body?.blocks)).toContain("rich_text_preformatted");
  });

  it("variant_pick click forwards the clicked built/kit choice and the raw text to composeReply", async () => {
    await setup();
    await upsertProductRef(repoDeps, {
      slug: "test-variant-widget-click",
      category: "general (built) / diy (kit)",
      productUrl: "https://takazudomodular.com/products/test-variant-widget-click/",
      bodyMd: `# Test Variant Widget Click\n\n- category: general (built) / diy (kit)\n- aliases: test variant widget click\n\n## Notes\n\nfixture\n`,
      aliases: ["test variant widget click"].map(normalizeAlias),
      changedByUserId: "seed",
      source: "seed",
    });
    const rawText = "<@U0BOT1> test variant widget click 明日"; // no diy/kit/built signal -- resolver returns variant-ambiguous
    const jobId = await seedReplyJob("ev-variant-click", rawText);
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const value = encodeButtonValue({ v: 1, id: String(jobId), a: "kit" });
    const body = formEncodedPayload(blockActionsPayload({ actionId: `${ACTION_IDS.variantPick}_1`, value, userId: "U_HUMAN" }));
    const request = await makeSignedRequest(body);
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, fakeEnv, makeDeps({ db: env!.db, waitUntil, fetch, composeReply }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]?.purchased).toBe("kit");
    expect(composeCalls[0]?.variantText).toBe(rawText);
    // The original mention already had 明日, so the click resolves
    // straight to the final reply -- no chained arrival picker.
    expect(composeCalls[0]?.arrivalSchedule).toContain("到着予定になります。");
  });

  it("arrival_other opens a modal via views.open using the click's trigger_id", async () => {
    await setup();
    await seedGeneralProduct("test-general-widget-c");
    const jobId = await seedReplyJob("ev-c", "<@U0BOT1> test general widget");
    const { fetch, calls } = createFakeFetch();

    const value = encodeButtonValue({ v: 1, id: String(jobId) });
    const body = formEncodedPayload(
      blockActionsPayload({ actionId: ACTION_IDS.arrivalOther, value, userId: "U_HUMAN", triggerId: "trigger-123" }),
    );
    const request = await makeSignedRequest(body);
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, fakeEnv, makeDeps({ db: env!.db, waitUntil, fetch }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    const viewsOpenCalls = calls.filter((call) => call.url.endsWith("/views.open"));
    expect(viewsOpenCalls).toHaveLength(1);
    expect(viewsOpenCalls[0]?.body?.trigger_id).toBe("trigger-123");
    const view = viewsOpenCalls[0]?.body?.view as Record<string, unknown>;
    expect(view.callback_id).toBe("arrival_other_modal");
    const metadata = JSON.parse(view.private_metadata as string) as { jobId: string };
    expect(metadata.jobId).toBe(String(jobId));
  });

  it("a view_submission for the arrival modal composes and posts the final reply via chat.update", async () => {
    await setup();
    await seedGeneralProduct("test-general-widget-d");
    const jobId = await seedReplyJob("ev-d", "<@U0BOT1> test general widget");
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const payload = {
      type: "view_submission",
      user: { id: "U_HUMAN" },
      view: {
        id: "V_1",
        callback_id: "arrival_other_modal",
        private_metadata: JSON.stringify({ jobId: String(jobId), channelId: "C1", messageTs: "200.000" }),
        state: {
          values: {
            day_label_block: { day_label: { value: "来週月曜" } },
            date_block: { date: { value: "8/25" } },
          },
        },
      },
    };
    const body = formEncodedPayload(payload);
    const request = await makeSignedRequest(body);
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, fakeEnv, makeDeps({ db: env!.db, waitUntil, fetch, composeReply }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]?.arrivalSchedule).toBe("来週月曜（8/25）到着予定になります。");
    const updateCalls = calls.filter((call) => call.url.endsWith("/chat.update"));
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.body?.channel).toBe("C1");
    expect(updateCalls[0]?.body?.ts).toBe("200.000");
  });

  it("a view_submission with an invalid date returns a validation error and never composes", async () => {
    await setup();
    await seedGeneralProduct("test-general-widget-e");
    const jobId = await seedReplyJob("ev-e", "<@U0BOT1> test general widget");
    const { fetch, calls } = createFakeFetch();
    const { composeReply, calls: composeCalls } = createFakeComposeReply();

    const payload = {
      type: "view_submission",
      user: { id: "U_HUMAN" },
      view: {
        id: "V_2",
        callback_id: "arrival_other_modal",
        private_metadata: JSON.stringify({ jobId: String(jobId), channelId: "C1", messageTs: "200.000" }),
        state: {
          values: {
            day_label_block: { day_label: { value: "来週月曜" } },
            date_block: { date: { value: "not-a-date" } },
          },
        },
      },
    };
    const body = formEncodedPayload(payload);
    const request = await makeSignedRequest(body);
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, fakeEnv, makeDeps({ db: env!.db, waitUntil, fetch, composeReply }));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { response_action: string; errors: Record<string, string> };
    expect(json.response_action).toBe("errors");
    expect(json.errors.date_block).toBeTruthy();
    await Promise.all(scheduled);
    expect(composeCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("a non-admin clicking ref_approve is refused and nothing is written", async () => {
    await setup();
    const draft = await createRefDraft(repoDeps, {
      slug: "test-draft-product",
      category: "general",
      productUrl: null,
      bodyMd: GENERAL_PRODUCT_MARKDOWN,
      baseVersion: null,
      createdByUserId: "U_ADMIN",
      expiresAt: NOW_MS + 3_600_000,
    });
    const { fetch, calls } = createFakeFetch();

    const value = encodeButtonValue({ v: 1, id: draft.id });
    const body = formEncodedPayload(blockActionsPayload({ actionId: ACTION_IDS.refApprove, value, userId: "U_NOT_ADMIN" }));
    const request = await makeSignedRequest(body);
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, fakeEnv, makeDeps({ db: env!.db, waitUntil, fetch }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    // Refused with an ephemeral notice ...
    const ephemeralCalls = calls.filter((call) => call.url.endsWith("/chat.postEphemeral"));
    expect(ephemeralCalls).toHaveLength(1);
    expect(ephemeralCalls[0]?.body?.user).toBe("U_NOT_ADMIN");

    // ... and nothing was written: the draft is still unconsumed, and no
    // product_refs row was ever created for its slug.
    const draftRow = await env!.db.prepare("SELECT consumed_at FROM ref_drafts WHERE id = ?").bind(draft.id).first<{
      consumed_at: number | null;
    }>();
    expect(draftRow?.consumed_at).toBeNull();
    const productRow = await getProductRefBySlug(repoDeps, "test-draft-product");
    expect(productRow).toBeNull();
    const updateOrPostCalls = calls.filter((call) => call.url.endsWith("/chat.update") || call.url.endsWith("/chat.postMessage"));
    expect(updateOrPostCalls).toHaveLength(0);
  });

  it("an admin clicking ref_approve consumes the draft and writes the product ref", async () => {
    await setup();
    const draft = await createRefDraft(repoDeps, {
      slug: "test-draft-product-2",
      category: "general",
      productUrl: null,
      bodyMd: GENERAL_PRODUCT_MARKDOWN,
      baseVersion: null,
      createdByUserId: "U_ADMIN",
      expiresAt: NOW_MS + 3_600_000,
    });
    const { fetch, calls } = createFakeFetch();

    const value = encodeButtonValue({ v: 1, id: draft.id });
    const body = formEncodedPayload(blockActionsPayload({ actionId: ACTION_IDS.refApprove, value, userId: "U_ADMIN" }));
    const request = await makeSignedRequest(body);
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, fakeEnv, makeDeps({ db: env!.db, waitUntil, fetch }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    const draftRow = await env!.db.prepare("SELECT consumed_at FROM ref_drafts WHERE id = ?").bind(draft.id).first<{
      consumed_at: number | null;
    }>();
    expect(draftRow?.consumed_at).not.toBeNull();
    const productRow = await getProductRefBySlug(repoDeps, "test-draft-product-2");
    expect(productRow?.slug).toBe("test-draft-product-2");
    expect(productRow?.updated_by).toBe("U_ADMIN");
  });

  it("a non-admin clicking the create_reference button is refused", async () => {
    await setup();
    const body = formEncodedPayload(
      blockActionsPayload({ actionId: CREATE_REFERENCE_ACTION_ID, value: "some search query", userId: "U_NOT_ADMIN" }),
    );
    const request = await makeSignedRequest(body);
    const { fetch, calls } = createFakeFetch();
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, fakeEnv, makeDeps({ db: env!.db, waitUntil, fetch }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    const ephemeralCalls = calls.filter((call) => call.url.endsWith("/chat.postEphemeral"));
    expect(ephemeralCalls).toHaveLength(1);
  });
});
