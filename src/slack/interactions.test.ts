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
import { ANTHROPIC_MESSAGES_URL } from "../llm/claude";
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

/* -------------------------------------------------------------------------
 * A fake site + provider for the create_reference authoring path (issue
 * #25). Deliberately minimal next to src/refs/authoring.test.ts's — that
 * suite owns the authoring pipeline's behaviour; this one only needs the
 * pipeline to SUCCEED, so that the ref_drafts row it writes can be
 * checked for the origin job the click carried.
 * ---------------------------------------------------------------------- */

const AUTHORING_SITE_BASE = "https://takazudomodular.com";
const AUTHORING_QUERY = "zt seq";
const AUTHORING_DETAIL_HREF = "/products/zt-seq-intro/";
const AUTHORING_REF_SLUG = "zt-seq";
const AUTHORING_PRODUCT_URL = `${AUTHORING_SITE_BASE}${AUTHORING_DETAIL_HREF}`;

const AUTHORING_PAGE_HTML = [
  "<html><body><h1>ZT Seq</h1>",
  "<h2>マニュアルとガイド</h2>",
  "<a href=/manuals/zt-seq/>ZT Seq マニュアル</a>",
  "</body></html>",
].join("");

const AUTHORING_BODY = [
  "# ZT Seq",
  "",
  "- category: general",
  `- product-url: ${AUTHORING_PRODUCT_URL}`,
  `- aliases: ${AUTHORING_REF_SLUG}, ZT Seq`,
  "",
  "## Manual",
  "",
  `- ZT Seq マニュアル: ${AUTHORING_SITE_BASE}/manuals/zt-seq/`,
  "",
  "Intro text: 英語のマニュアルを以下にて公開しています。お手元に置いてお使いいただけると幸いです。",
  "",
].join("\n");

function authoringEnv(): Env {
  return baseEnv({
    SITE_API_BASE: AUTHORING_SITE_BASE,
    AUTHOR_PROVIDER: "claude",
    ANTHROPIC_API_KEY: "sk-ant-test",
  });
}

/**
 * The Slack fake of createFakeFetch, extended with the catalog/page/provider
 * responses authoring needs.
 *
 * Every intercepted URL is recorded in the same `calls` array the Slack
 * fake uses — without that, an assertion like "the provider was never
 * called" would pass no matter what, since the array would only ever hold
 * Slack traffic. Bodies are dropped for these: the provider's is the
 * authoring prompt.
 */
function createAuthoringFetch(): { fetch: FetchLike; calls: FakeFetchCall[] } {
  const slack = createFakeFetch();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ANTHROPIC_MESSAGES_URL) || url.includes("/api/products") || url.includes("/api/search") || url.includes(AUTHORING_DETAIL_HREF)) {
      slack.calls.push({ url, body: null });
    }
    if (url.startsWith(ANTHROPIC_MESSAGES_URL)) {
      return new Response(
        JSON.stringify({
          model: "claude-haiku-4-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: AUTHORING_BODY }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/products")) {
      return new Response(
        JSON.stringify({
          success: true,
          products: [
            {
              slug: "zt-seq-black",
              name: "ZT Seq (black)",
              brand: "Zudo Test",
              description: "テスト用のシーケンサーです。",
              detailHref: AUTHORING_DETAIL_HREF,
              tags: ["sequencer"],
              price: 48000,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/search")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes(AUTHORING_DETAIL_HREF)) {
      return new Response(AUTHORING_PAGE_HTML, { status: 200 });
    }
    return slack.fetch(input, init);
  }) as FetchLike;
  return { fetch: fetchImpl, calls: slack.calls };
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

  /**
   * The implicit authoring path (issue #17): a mention that resolves to no
   * reference offers this button, and clicking it drafts one. Until #17 was
   * wired the handler answered with a "not implemented" ephemeral, and
   * nothing asserted that — so the button could have stayed dark
   * indefinitely without a single test going red.
   *
   * The fake fetch cannot satisfy the authoring provider, so the pipeline
   * trips a guard and reports the failure. That is the correct behaviour for
   * this path (authoring never falls back — an invented reference is worse
   * than none), and it still proves the wiring: the interim notice goes out
   * and the outcome is posted in-thread.
   */
  it("an admin clicking create_reference runs the authoring pipeline and reports in-thread", async () => {
    await setup();
    const body = formEncodedPayload(
      blockActionsPayload({ actionId: CREATE_REFERENCE_ACTION_ID, value: "some new product", userId: "U_ADMIN" }),
    );
    const request = await makeSignedRequest(body);
    const { fetch, calls } = createFakeFetch();
    const { waitUntil, scheduled } = makeWaitUntil();

    // baseEnv() casts `as Env`, so vars it omits are undefined at runtime
    // with no type error — the authoring pipeline needs these three.
    const authoringEnv: Env = {
      ...fakeEnv,
      SITE_API_BASE: "https://site.test",
      AUTHOR_PROVIDER: "claude",
      ANTHROPIC_API_KEY: "test-key",
    };
    const response = await handleSlackInteractionsWithDeps(request, authoringEnv, makeDeps({ db: env!.db, waitUntil, fetch }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    // The interim "working on it" notice — a button that sits silent for
    // tens of seconds reads as broken and gets clicked again.
    const ephemeralCalls = calls.filter((call) => call.url.endsWith("/chat.postEphemeral"));
    expect(ephemeralCalls).toHaveLength(1);

    // The outcome, in the thread the button was posted in.
    const postCalls = calls.filter((call) => call.url.endsWith("/chat.postMessage"));
    expect(postCalls).toHaveLength(1);

    const everything = JSON.stringify(calls.map((call) => call.body));
    expect(everything, "the placeholder must be gone, not merely unreferenced").not.toContain("まだ実装されていません");
  });

  /* ----------------------------------------- create_reference origin job */

  /**
   * Issue #25. The button's value went from a bare query string to an
   * envelope carrying the originating reply job, so the draft a click
   * produces knows which mention asked for it (epic #22).
   *
   * Both value shapes are exercised here rather than only the new one:
   * buttons rendered before this change are still sitting in channel
   * history, and decodeButtonValue returns null for them rather than
   * throwing, so that path has to keep working — including the receipt
   * key, which falls back to the raw value for exactly that case.
   */
  async function clickCreateReference(input: {
    value: string;
    actionTs?: string;
    env?: Env;
  }): Promise<{ calls: FakeFetchCall[] }> {
    const body = formEncodedPayload(
      blockActionsPayload({
        actionId: CREATE_REFERENCE_ACTION_ID,
        value: input.value,
        userId: "U_ADMIN",
        ...(input.actionTs === undefined ? {} : { actionTs: input.actionTs }),
      }),
    );
    const request = await makeSignedRequest(body);
    const { fetch, calls } = createAuthoringFetch();
    const { waitUntil, scheduled } = makeWaitUntil();

    const response = await handleSlackInteractionsWithDeps(request, input.env ?? authoringEnv(), makeDeps({ db: env!.db, waitUntil, fetch }));
    expect(response.status).toBe(200);
    await Promise.all(scheduled);
    return { calls };
  }

  async function draftRows(): Promise<{ slug: string; origin_job_id: number | null }[]> {
    const result = await env!.db.prepare("SELECT slug, origin_job_id FROM ref_drafts ORDER BY rowid").all<{
      slug: string;
      origin_job_id: number | null;
    }>();
    return result.results ?? [];
  }

  it("an envelope-valued create_reference click drafts with the originating job recorded", async () => {
    await setup();
    const jobId = await seedReplyJob("ev-origin-1", `<@${BOT_USER_ID}> ${AUTHORING_QUERY}`);

    await clickCreateReference({ value: encodeButtonValue({ v: 1, id: String(jobId), a: AUTHORING_QUERY }) });

    expect(await draftRows()).toEqual([{ slug: AUTHORING_REF_SLUG, origin_job_id: jobId }]);
  });

  it("a legacy plain-string button still authors, with no origin to record", async () => {
    await setup();
    await seedReplyJob("ev-origin-legacy", `<@${BOT_USER_ID}> ${AUTHORING_QUERY}`);

    await clickCreateReference({ value: AUTHORING_QUERY });

    expect(await draftRows()).toEqual([{ slug: AUTHORING_REF_SLUG, origin_job_id: null }]);
  });

  it("recovers the query from the envelope's `a`, not from the raw JSON value", async () => {
    await setup();
    const jobId = await seedReplyJob("ev-origin-query", `<@${BOT_USER_ID}> ${AUTHORING_QUERY}`);

    const { calls } = await clickCreateReference({
      value: encodeButtonValue({ v: 1, id: String(jobId), a: AUTHORING_QUERY }),
    });

    const interim = calls.find((call) => call.url.endsWith("/chat.postEphemeral"));
    expect(JSON.stringify(interim?.body)).toContain(`「${AUTHORING_QUERY}」`);
    expect(JSON.stringify(interim?.body)).not.toContain('\\"v\\":1');
  });

  /* --------- the four pinned idempotency cases (issue #25) */

  it("the same origin clicked twice at the same action_ts drafts exactly once", async () => {
    await setup();
    const jobId = await seedReplyJob("ev-origin-dedupe", `<@${BOT_USER_ID}> ${AUTHORING_QUERY}`);
    const value = encodeButtonValue({ v: 1, id: String(jobId), a: AUTHORING_QUERY });

    await clickCreateReference({ value, actionTs: "1000.000009" });
    await clickCreateReference({ value, actionTs: "1000.000009" });

    expect(await draftRows()).toHaveLength(1);
  });

  /**
   * The case the old plain-string value could not express: two mentions
   * that missed on the SAME text are two independent offers, and Slack
   * gives no guarantee their `action_ts` differ. Keyed on the query alone
   * the second click was swallowed as a duplicate and the operator got
   * nothing at all.
   */
  it("two different origins clicked at the same action_ts do not collide", async () => {
    await setup();
    const firstJob = await seedReplyJob("ev-origin-a", `<@${BOT_USER_ID}> ${AUTHORING_QUERY}`);
    const secondJob = await seedReplyJob("ev-origin-b", `<@${BOT_USER_ID}> ${AUTHORING_QUERY}`);
    expect(secondJob).not.toBe(firstJob);

    await clickCreateReference({
      value: encodeButtonValue({ v: 1, id: String(firstJob), a: AUTHORING_QUERY }),
      actionTs: "1000.000009",
    });
    await clickCreateReference({
      value: encodeButtonValue({ v: 1, id: String(secondJob), a: AUTHORING_QUERY }),
      actionTs: "1000.000009",
    });

    expect((await draftRows()).map((row) => row.origin_job_id)).toEqual([firstJob, secondJob]);
  });

  it("a legacy plain-string click still dedupes on its raw value at the same action_ts", async () => {
    await setup();
    await seedReplyJob("ev-origin-legacy-dedupe", `<@${BOT_USER_ID}> ${AUTHORING_QUERY}`);

    await clickCreateReference({ value: AUTHORING_QUERY, actionTs: "1000.000009" });
    await clickCreateReference({ value: AUTHORING_QUERY, actionTs: "1000.000009" });

    expect(await draftRows()).toHaveLength(1);
  });

  /**
   * The other half of the fallback contract: two legacy buttons offering
   * DIFFERENT queries are different targets, and the raw value is the
   * only thing that can tell them apart. Asserted on the receipt keys
   * rather than on drafts, so it holds regardless of whether either query
   * happens to resolve to a product.
   */
  it("two legacy plain-string clicks with different queries do not collide at the same action_ts", async () => {
    await setup();

    await clickCreateReference({ value: "one product", actionTs: "1000.000009" });
    await clickCreateReference({ value: "another product", actionTs: "1000.000009" });

    const receipts = await env!.db
      .prepare("SELECT event_id FROM slack_event_receipts WHERE event_id LIKE ? ORDER BY event_id")
      .bind(`interaction:${CREATE_REFERENCE_ACTION_ID}:%`)
      .all<{ event_id: string }>();
    expect(receipts.results?.map((row) => row.event_id)).toEqual([
      `interaction:${CREATE_REFERENCE_ACTION_ID}:another product:1000.000009`,
      `interaction:${CREATE_REFERENCE_ACTION_ID}:one product:1000.000009`,
    ]);
  });

  it("an envelope whose id is not a job number refuses instead of drafting against a bogus origin", async () => {
    await setup();

    const { calls } = await clickCreateReference({ value: encodeButtonValue({ v: 1, id: "not-a-job", a: AUTHORING_QUERY }) });

    expect(await draftRows()).toEqual([]);
    const ephemeral = calls.filter((call) => call.url.endsWith("/chat.postEphemeral"));
    expect(ephemeral).toHaveLength(1);
    expect(JSON.stringify(ephemeral[0]?.body)).toContain("読み取れませんでした");
    // Nothing was authored, so the provider was never called either.
    expect(calls.some((call) => call.url.startsWith(ANTHROPIC_MESSAGES_URL))).toBe(false);
  });
});
