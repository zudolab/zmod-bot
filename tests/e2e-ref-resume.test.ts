/**
 * The reply-resume integration gate (issue #28, epic #22). The path was
 * built across two sub-issues that landed independently and were never run
 * together: #25 taught the `create_reference` button to carry an envelope
 * naming the originating reply job, and #26 taught an approval to resume
 * that job's reply once the draft it produced is committed. Neither
 * sub-issue's own tests drive the seam between them — src/slack/
 * reply-resume.test.ts seeds a draft directly (skipping authoring), and
 * src/slack/interactions.test.ts's authoring coverage never approves what
 * it drafts. This file does both, through genuinely signed HTTP requests,
 * exactly the way a real mention/click/click/click sequence would reach the
 * Worker: `app_mention` (miss) -> `create_reference` click -> `ref_approve`
 * click -> (for `general`) `arrival_pick` click.
 *
 * Local only, same shape as tests/e2e-deterministic.test.ts: Miniflare's
 * real D1 (migrations 0001/0003-0006, no seed corpus — every mention here
 * is a deliberate miss), and one injected fake `fetch` per scenario
 * answering Slack's Web API, the site the authoring pipeline reads
 * (`SITE_API_BASE`), and the Claude Messages API the authoring provider
 * calls — no real network, no real model call, no real Slack call.
 * `COMPOSE_PROVIDER` stays "workers-ai" with a guard-tripping `AI` fake
 * (composeReply's real deterministic-fallback path, matching
 * tests/e2e-deterministic.test.ts's default), so every composed reply here
 * is asserted byte-exact against src/reply/render.ts renderDeterministicReply
 * — an independently-computed expectation, not a copy of whatever the
 * pipeline happened to produce.
 *
 * Ingress goes through the real `handleSlackEventsWithDeps` /
 * `handleSlackInteractionsWithDeps` (same functions src/router.ts calls),
 * with db/now/fetch/waitUntil injected — CLAUDE.md's DI convention, and
 * the same pattern tests/e2e-deterministic.test.ts and
 * src/slack/reply-resume.test.ts both already use.
 */
import { describe, expect, it } from "vitest";
import { handleSlackEventsWithDeps, type SlackEventsDeps } from "../src/slack/events";
import { handleSlackInteractionsWithDeps, type SlackInteractionsDeps } from "../src/slack/interactions";
import { ACTION_IDS, computeArrivalPresetOptions, decodeButtonValue } from "../src/slack/commands";
import { CREATE_REFERENCE_ACTION_ID } from "../src/slack/blocks";
import { renderDeterministicReply } from "../src/reply/render";
import { formatArrivalSchedule } from "../src/reply/templates";
import { parseProductRefMarkdown } from "../src/refs/parse";
import { ANTHROPIC_MESSAGES_URL } from "../src/llm/claude";
import type { Env } from "../src/env";
import type { FetchLike, WaitUntilFn } from "../src/types";
import { createTestEnv, type TestEnvHandle } from "./helpers/test-env";

/* -------------------------------------------------------------------------
 * Signing — independently computed, mirroring tests/e2e-deterministic.test.ts
 * and src/slack/reply-resume.test.ts's own helpers (both explain why this
 * is not the sign-then-verify trap CLAUDE.md warns about: the signature
 * math itself is pinned to known-answer vectors in src/slack/verify.test.ts;
 * this file exercises the pipeline behind it).
 * ---------------------------------------------------------------------- */

const SIGNING_SECRET = "e2e-ref-resume-signing-secret";
const BOT_USER_ID = "U0E2ERESUME";
const ADMIN_USER_ID = "U_ADMIN";
const ORIGIN_CHANNEL = "C_E2E_RESUME_ORIGIN";
/** Frozen throughout, per every other test file in this repo — see tests/e2e-deterministic.test.ts. */
const CLOCK_MS = 1_755_129_600_000;
const encoder = new TextEncoder();

async function computeSignature(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  return `v0=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function signedRequest(url: string, body: string, contentType?: string): Promise<Request> {
  const timestamp = String(Math.floor(CLOCK_MS / 1000));
  const signature = await computeSignature(body, timestamp);
  const headers: Record<string, string> = {
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": signature,
  };
  if (contentType) headers["content-type"] = contentType;
  return new Request(url, { method: "POST", headers, body });
}

let tsSeq = 1_800_000_000;
function nextSlackTs(): string {
  tsSeq += 1;
  return `${tsSeq}.000001`;
}

let eventSeq = 0;
function nextEventId(label: string): string {
  eventSeq += 1;
  return `ev-${label}-${eventSeq}`;
}

function makeWaitUntil(): { waitUntil: WaitUntilFn; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  return { waitUntil: (promise) => void scheduled.push(promise), scheduled };
}

/* -------------------------------------------------------------------------
 * Two authored-reference fixtures — one `small` (immediate reply, no
 * arrival date), one `general` (needs an arrival date, so approving it
 * resumes into the picker rather than the reply). Both go through the
 * REAL authoring pipeline (src/refs/authoring.ts authorProductRef), so
 * each fixture answers the site + Claude calls that pipeline makes —
 * deliberately minimal, mirroring src/slack/interactions.test.ts's own
 * createAuthoringFetch fixture, which this is a two-fixture generalization
 * of. `product-url` must equal the URL authorProductRef derives from
 * `detailHref` exactly, or checkAuthorOutputGuard refuses to draft
 * (url_mismatch) — see src/refs/authoring.ts's requiredProductUrl check.
 * The body's only content section is `## Notes`, which src/reply/render.ts
 * treats as editorial and never emits — so the expected customer text
 * below is the base template alone, independent of anything this fixture
 * says (renderDeterministicReply computes it the same way the pipeline
 * would, from `ref` + `flags` + `arrivalSchedule` alone, not by echoing
 * the fixture's own prose).
 * ---------------------------------------------------------------------- */

const SITE_BASE = "https://e2e-resume-authoring.test";

interface RefFixture {
  query: string;
  detailHref: string;
  refSlug: string;
  productName: string;
  productUrl: string;
  authoredBody: string;
}

function buildFixture(input: { key: string; category: "small" | "general" }): RefFixture {
  const detailHref = `/products/e2e-resume-${input.key}-intro/`;
  const refSlug = `e2e-resume-${input.key}`;
  const productName = `E2E Resume ${input.key === "small" ? "Small" : "General"} Widget`;
  const query = productName.toLowerCase();
  const productUrl = `${SITE_BASE}${detailHref}`;
  const authoredBody = [
    `# ${productName}`,
    "",
    `- category: ${input.category}`,
    `- product-url: ${productUrl}`,
    `- aliases: ${query}, ${productName}`,
    "",
    "## Notes",
    "",
    `fixture ${input.key} product for issue #28 e2e coverage (editorial only, never reaches the customer).`,
    "",
  ].join("\n");
  return { query, detailHref, refSlug, productName, productUrl, authoredBody };
}

const SMALL_FIXTURE = buildFixture({ key: "small", category: "small" });
const GENERAL_FIXTURE = buildFixture({ key: "general", category: "general" });

/* -------------------------------------------------------------------------
 * Env + fetch fakes.
 * ---------------------------------------------------------------------- */

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    // Every call this test file exercises through the guard-tripping fake
    // AI runs composeReply's real deterministic-fallback path — the same
    // deliberate default tests/e2e-deterministic.test.ts uses, and for the
    // same reason: it makes the byte-exact assertions below hold
    // unconditionally instead of depending on a fake LLM echo.
    AI: {
      run: async () => {
        throw new Error("e2e-ref-resume: AI intentionally unavailable in this local test tier");
      },
    } as unknown as Ai,
    SLACK_BOT_TOKEN: "xoxb-e2e-ref-resume-test",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    ANTHROPIC_API_KEY: "sk-ant-e2e-ref-resume-test",
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_ALLOWED_CHANNEL_IDS: ORIGIN_CHANNEL,
    SLACK_ADMIN_USER_IDS: ADMIN_USER_ID,
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    SITE_API_BASE: SITE_BASE,
    ...overrides,
  };
}

interface FakeCall {
  url: string;
  body: Record<string, unknown> | null;
}

/**
 * One fetch fake per scenario, answering every I/O boundary the flow can
 * reach: Slack's Web API (chat.postMessage/update/postEphemeral — every
 * call is recorded, so "exactly one reply" and "not a chat.update" are
 * checked against a complete call log, not a partial one), the fixture's
 * site endpoints (`/api/products`, `/api/search`, the product detail
 * page), and the Claude Messages API. Reused across every step of one
 * scenario (mention -> click -> click[ -> click]) so the accumulated
 * `calls` log can be asserted on as one ordered sequence, the way a real
 * bot's single `fetch` binding would see it.
 */
function createE2eFetch(fixture: RefFixture): { fetch: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let postCounter = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const bodyText = init?.body ? String(init.body) : null;
    let body: Record<string, unknown> | null = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        body = null; // the form-encoded interaction requests THIS file sends are never outbound fetch calls
      }
    }
    calls.push({ url, body });

    if (url.startsWith(ANTHROPIC_MESSAGES_URL)) {
      return new Response(
        JSON.stringify({
          model: "claude-haiku-4-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: fixture.authoredBody }],
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
              slug: fixture.refSlug,
              name: fixture.productName,
              brand: "Zudo Test",
              description: "テスト用フィクスチャです。",
              detailHref: fixture.detailHref,
              tags: [],
              price: 12000,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/search")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes(fixture.detailHref)) {
      return new Response(`<html><body><h1>${fixture.productName}</h1></body></html>`, { status: 200 });
    }

    if (url.endsWith("/chat.postMessage")) {
      postCounter += 1;
      return new Response(
        JSON.stringify({ ok: true, channel: body?.channel, ts: `9500.${String(postCounter).padStart(6, "0")}` }),
        { status: 200 },
      );
    }
    if (url.endsWith("/chat.postEphemeral")) {
      return new Response(JSON.stringify({ ok: true, message_ts: "9600.000001" }), { status: 200 });
    }
    // chat.update and anything else this flow calls.
    return new Response(JSON.stringify({ ok: true, ts: body?.ts ?? "9700.000001" }), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function postCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((call) => call.url.endsWith("/chat.postMessage"));
}
function updateCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((call) => call.url.endsWith("/chat.update"));
}
function ephemeralCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((call) => call.url.endsWith("/chat.postEphemeral"));
}

/** Reconstructs the exact byte-for-byte reply text from a postMessage/update payload's `rich_text_preformatted` block(s) — mirrors tests/e2e-deterministic.test.ts's own helper, the inverse of src/slack/blocks.ts buildReplyBlocks. */
function extractReplyText(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new Error("extractReplyText: blocks is not an array");
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "rich_text" || !Array.isArray(b.elements)) continue;
    for (const element of b.elements) {
      if (!element || typeof element !== "object") continue;
      const e = element as Record<string, unknown>;
      if (e.type !== "rich_text_preformatted" || !Array.isArray(e.elements)) continue;
      for (const textNode of e.elements) {
        if (!textNode || typeof textNode !== "object") continue;
        const t = textNode as Record<string, unknown>;
        if (t.type === "text" && typeof t.text === "string") parts.push(t.text);
      }
    }
  }
  return parts.join("");
}

/** Finds a button (inside a `type: "actions"` block) whose `action_id` satisfies `matches`, and returns its `action_id`/`value` — the same shape every builder in src/slack/blocks.ts and src/slack/commands.ts produces. */
function findButton(blocks: unknown, matches: (actionId: string) => boolean): { actionId: string; value: string } | undefined {
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "actions" || !Array.isArray(b.elements)) continue;
    for (const element of b.elements) {
      if (!element || typeof element !== "object") continue;
      const e = element as Record<string, unknown>;
      if (typeof e.action_id === "string" && typeof e.value === "string" && matches(e.action_id)) {
        return { actionId: e.action_id, value: e.value };
      }
    }
  }
  return undefined;
}

const ARRIVAL_TOMORROW = (() => {
  const option = computeArrivalPresetOptions(() => new Date(CLOCK_MS)).find((candidate) => candidate.preset === "tomorrow");
  if (!option) throw new Error("no arrival preset option for tomorrow");
  return formatArrivalSchedule({ dayLabel: option.dayLabel, month: option.month, day: option.day });
})();
const DEFAULT_FLAGS = { direct: false, discord: false };

/* -------------------------------------------------------------------------
 * Step helpers — each posts/clicks through the real handler with a
 * genuinely signed request, exactly as tests/e2e-deterministic.test.ts's
 * runReplyCycle/clickButton do.
 * ---------------------------------------------------------------------- */

/** Step 1: an app_mention that misses. Returns the origin job id, the mention's own ts (== job.thread_ts, per src/slack/events.ts), the "no reference" message's own ts, and the create_reference button's envelope value. */
async function postMissingMention(env: TestEnvHandle, fetch: FetchLike, calls: FakeCall[], fixture: RefFixture): Promise<{
  jobId: number;
  originTs: string;
  missMessageTs: string;
  createReferenceValue: string;
  rawText: string;
}> {
  const { waitUntil, scheduled } = makeWaitUntil();
  const eventId = nextEventId(`miss-${fixture.refSlug}`);
  const ts = nextSlackTs();
  const rawText = `<@${BOT_USER_ID}> ${fixture.query}`;
  const body = JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    event: { type: "app_mention", channel: ORIGIN_CHANNEL, user: "U_HUMAN", text: rawText, ts, event_ts: ts },
  });
  const request = await signedRequest("https://example.com/slack/events", body);
  const deps: SlackEventsDeps = { db: env.db, now: () => new Date(CLOCK_MS), waitUntil, fetch };

  const response = await handleSlackEventsWithDeps(request, makeEnv(env.db), deps);
  expect(response.status).toBe(200);
  expect(scheduled).toHaveLength(1);
  await scheduled[0];

  const jobRow = await env.db
    .prepare("SELECT id FROM jobs WHERE event_id = ?")
    .bind(eventId)
    .first<{ id: number }>();
  expect(jobRow).toBeTruthy();

  const posts = postCalls(calls);
  expect(posts).toHaveLength(1); // the "no reference yet" message, nothing else yet
  expect(posts[0]?.body?.channel).toBe(ORIGIN_CHANNEL);
  expect(posts[0]?.body?.thread_ts).toBe(ts);
  const button = findButton(posts[0]?.body?.blocks, (actionId) => actionId === CREATE_REFERENCE_ACTION_ID);
  expect(button).toBeTruthy();
  const envelope = decodeButtonValue(button!.value);
  expect(envelope?.id).toBe(String(jobRow!.id)); // the offer carries THIS mention's job, per issue #25

  return {
    jobId: jobRow!.id,
    originTs: ts,
    missMessageTs: `9500.${postCallIndex(calls)}`,
    createReferenceValue: button!.value,
    rawText,
  };
}

/** The nth (1-indexed, zero-padded to 6) postMessage ts createE2eFetch's fake would have handed back — derived from the call log rather than re-reading the fake Response, since the counter and the log advance together by construction. */
function postCallIndex(calls: FakeCall[]): string {
  return String(postCalls(calls).length).padStart(6, "0");
}

/** Step 2: an admin clicks create_reference. Runs the real authoring pipeline against the fixture's fake site + Claude, drafts, and posts the approve/reject preview threaded off the "no reference" message. Returns the draft's approve-button value and the preview message's own ts. */
async function clickCreateReference(
  env: TestEnvHandle,
  fetch: FetchLike,
  calls: FakeCall[],
  fixture: RefFixture,
  ctx: { channelId: string; missMessageTs: string; value: string },
): Promise<{ approveValue: string; rejectValue: string; previewMessageTs: string }> {
  const { waitUntil, scheduled } = makeWaitUntil();
  const clickPayload = {
    type: "block_actions",
    actions: [{ action_id: CREATE_REFERENCE_ACTION_ID, action_ts: nextSlackTs(), value: ctx.value }],
    user: { id: ADMIN_USER_ID },
    container: { channel_id: ctx.channelId, message_ts: ctx.missMessageTs },
  };
  const form = `payload=${encodeURIComponent(JSON.stringify(clickPayload))}`;
  const request = await signedRequest("https://example.com/slack/interactions", form, "application/x-www-form-urlencoded");
  const deps: SlackInteractionsDeps = { db: env.db, now: () => new Date(CLOCK_MS), fetch, waitUntil };

  const postsBefore = postCalls(calls).length;
  const response = await handleSlackInteractionsWithDeps(request, makeEnv(env.db), deps);
  expect(response.status).toBe(200);
  await Promise.all(scheduled);

  // The interim "working on it" ephemeral, then the draft preview post —
  // proves the pipeline actually ran rather than refusing (a guard trip
  // would post the failure as the SAME kind of message and this file's
  // later approve step would then have no button to click).
  expect(ephemeralCalls(calls).length).toBeGreaterThanOrEqual(1);
  const posts = postCalls(calls);
  expect(posts.length).toBe(postsBefore + 1);
  const preview = posts[posts.length - 1]!;
  expect(preview.body?.channel).toBe(ctx.channelId);
  expect(preview.body?.thread_ts).toBe(ctx.missMessageTs);

  const draftRow = await env.db
    .prepare("SELECT id, slug FROM ref_drafts WHERE slug = ? ORDER BY rowid DESC LIMIT 1")
    .bind(fixture.refSlug)
    .first<{ id: string; slug: string }>();
  expect(draftRow).toBeTruthy();

  const approveButton = findButton(preview.body?.blocks, (actionId) => actionId === ACTION_IDS.refApprove);
  const rejectButton = findButton(preview.body?.blocks, (actionId) => actionId === ACTION_IDS.refReject);
  expect(approveButton).toBeTruthy();
  expect(rejectButton).toBeTruthy();
  expect(decodeButtonValue(approveButton!.value)?.id).toBe(draftRow!.id);

  return { approveValue: approveButton!.value, rejectValue: rejectButton!.value, previewMessageTs: `9500.${postCallIndex(calls)}` };
}

/** A generic block_actions click through the real interactions handler — used for ref_approve/ref_reject (step 3) and arrival_pick (step 4). */
async function clickButton(
  env: TestEnvHandle,
  fetch: FetchLike,
  ctx: { actionId: string; value: string; channelId: string; messageTs: string; actionTs?: string; userId?: string },
): Promise<void> {
  const { waitUntil, scheduled } = makeWaitUntil();
  const clickPayload = {
    type: "block_actions",
    actions: [{ action_id: ctx.actionId, action_ts: ctx.actionTs ?? nextSlackTs(), value: ctx.value }],
    user: { id: ctx.userId ?? ADMIN_USER_ID },
    container: { channel_id: ctx.channelId, message_ts: ctx.messageTs },
  };
  const form = `payload=${encodeURIComponent(JSON.stringify(clickPayload))}`;
  const request = await signedRequest("https://example.com/slack/interactions", form, "application/x-www-form-urlencoded");
  const deps: SlackInteractionsDeps = { db: env.db, now: () => new Date(CLOCK_MS), fetch, waitUntil };

  const response = await handleSlackInteractionsWithDeps(request, makeEnv(env.db), deps);
  expect(response.status).toBe(200);
  await Promise.all(scheduled);
}

/** Steps 1-2 combined, shared by every scenario below: a genuine miss through to an admin-authored, still-pending draft. */
async function authorDraft(env: TestEnvHandle, fetch: FetchLike, calls: FakeCall[], fixture: RefFixture) {
  const mention = await postMissingMention(env, fetch, calls, fixture);
  const draft = await clickCreateReference(env, fetch, calls, fixture, {
    channelId: ORIGIN_CHANNEL,
    missMessageTs: mention.missMessageTs,
    value: mention.createReferenceValue,
  });
  return { ...mention, ...draft };
}

/* -------------------------------------------------------------------------
 * Scenarios.
 * ---------------------------------------------------------------------- */

describe("small shape: miss -> offer -> author -> approve -> immediate reply in the origin thread", () => {
  it("posts the composed reply via chat.postMessage carrying the origin channel/thread_ts, and updates the preview separately", async () => {
    const env = await createTestEnv();
    try {
      const { fetch, calls } = createE2eFetch(SMALL_FIXTURE);
      const flow = await authorDraft(env, fetch, calls, SMALL_FIXTURE);
      const postsBefore = postCalls(calls).length;
      const updatesBefore = updateCalls(calls).length;

      await clickButton(env, fetch, {
        actionId: ACTION_IDS.refApprove,
        value: flow.approveValue,
        channelId: ORIGIN_CHANNEL,
        messageTs: flow.previewMessageTs,
      });

      // The resume: exactly one NEW postMessage, carrying the ORIGIN
      // channel/thread — never the preview's own location.
      const posts = postCalls(calls);
      expect(posts.length).toBe(postsBefore + 1);
      const reply = posts[posts.length - 1]!;
      expect(reply.body?.channel).toBe(ORIGIN_CHANNEL);
      expect(reply.body?.thread_ts).toBe(flow.originTs);
      expect(reply.body?.thread_ts).not.toBe(flow.previewMessageTs);

      const replyText = extractReplyText(reply.body?.blocks);
      const ref = parseProductRefMarkdown({ slug: SMALL_FIXTURE.refSlug, markdown: SMALL_FIXTURE.authoredBody });
      const expected = renderDeterministicReply({ ref, flags: DEFAULT_FLAGS, arrivalSchedule: null, variantText: flow.rawText });
      expect(replyText).toBe(expected);

      // The approval preview is a SEPARATE delivery, via chat.update, in
      // the preview's own location — not the mechanism the reply above
      // used, and not posted into the origin thread.
      const updates = updateCalls(calls);
      expect(updates.length).toBe(updatesBefore + 1);
      expect(updates[updates.length - 1]?.body?.channel).toBe(ORIGIN_CHANNEL);
      expect(updates[updates.length - 1]?.body?.ts).toBe(flow.previewMessageTs);

      // The commit actually happened, product_refs carries the authored slug.
      const committed = await env.db
        .prepare("SELECT slug, category FROM product_refs WHERE slug = ?")
        .bind(SMALL_FIXTURE.refSlug)
        .first<{ slug: string; category: string }>();
      expect(committed?.category).toBe("small");
    } finally {
      await env.dispose();
    }
  });
});

describe("general shape: approve -> arrival picker in the origin thread -> arrival_pick click -> final reply", () => {
  it("posts the arrival picker via chat.postMessage into the origin thread, then the click finishes it with the byte-exact reply", async () => {
    const env = await createTestEnv();
    try {
      const { fetch, calls } = createE2eFetch(GENERAL_FIXTURE);
      const flow = await authorDraft(env, fetch, calls, GENERAL_FIXTURE);
      const postsBefore = postCalls(calls).length;

      await clickButton(env, fetch, {
        actionId: ACTION_IDS.refApprove,
        value: flow.approveValue,
        channelId: ORIGIN_CHANNEL,
        messageTs: flow.previewMessageTs,
      });

      // A freshly authored `general` reference needs an arrival date — the
      // resume posts the PICKER, not a composed reply, into the origin
      // thread (src/slack/interactions.ts resumeOriginReply calls the same
      // buildFinishReplyPayload the initial post would have).
      const posts = postCalls(calls);
      expect(posts.length).toBe(postsBefore + 1);
      const picker = posts[posts.length - 1]!;
      expect(picker.body?.channel).toBe(ORIGIN_CHANNEL);
      expect(picker.body?.thread_ts).toBe(flow.originTs);
      const pickerBlocksText = JSON.stringify(picker.body?.blocks);
      expect(pickerBlocksText).toContain(ACTION_IDS.arrivalPick);
      expect(pickerBlocksText).not.toContain("rich_text_preformatted");
      const pickerMessageTs = `9500.${postCallIndex(calls)}`;

      // The button carries the ORIGIN job, so the click below finishes
      // THAT job through the normal click path — not a second mechanism.
      const arrivalButton = findButton(picker.body?.blocks, (actionId) => actionId === `${ACTION_IDS.arrivalPick}_0`);
      expect(arrivalButton).toBeTruthy();
      expect(decodeButtonValue(arrivalButton!.value)?.id).toBe(String(flow.jobId));

      const updatesBefore = updateCalls(calls).length;
      await clickButton(env, fetch, {
        actionId: `${ACTION_IDS.arrivalPick}_0`,
        value: arrivalButton!.value,
        channelId: ORIGIN_CHANNEL,
        messageTs: pickerMessageTs,
      });

      // Finishing a click always replaces the clicked message — chat.update,
      // not a new postMessage. This is the mirror-image assertion to the
      // small-shape test above: THIS call is legitimately chat.update.
      expect(postCalls(calls).length).toBe(postsBefore + 1); // no new postMessage
      const updates = updateCalls(calls);
      expect(updates.length).toBe(updatesBefore + 1);
      const finished = updates[updates.length - 1]!;
      expect(finished.body?.channel).toBe(ORIGIN_CHANNEL);
      expect(finished.body?.ts).toBe(pickerMessageTs);

      const replyText = extractReplyText(finished.body?.blocks);
      const ref = parseProductRefMarkdown({ slug: GENERAL_FIXTURE.refSlug, markdown: GENERAL_FIXTURE.authoredBody });
      const expected = renderDeterministicReply({
        ref,
        flags: DEFAULT_FLAGS,
        arrivalSchedule: ARRIVAL_TOMORROW,
        variantText: flow.rawText,
      });
      expect(replyText).toBe(expected);
    } finally {
      await env.dispose();
    }
  });
});

describe("exactly one reply per approval", () => {
  it("a double approve click on the same draft posts exactly one reply — the commit's own consumed_at fence, not a second mechanism", async () => {
    const env = await createTestEnv();
    try {
      const { fetch, calls } = createE2eFetch(SMALL_FIXTURE);
      const flow = await authorDraft(env, fetch, calls, SMALL_FIXTURE);
      const postsBefore = postCalls(calls).length;

      // Distinct action_ts on purpose: an identical one would be swallowed
      // by the interaction receipt, which would prove nothing about the
      // draft-level consumed_at guard this test exists for (see
      // src/slack/reply-resume.test.ts's identical reasoning).
      await clickButton(env, fetch, {
        actionId: ACTION_IDS.refApprove,
        value: flow.approveValue,
        channelId: ORIGIN_CHANNEL,
        messageTs: flow.previewMessageTs,
        actionTs: "1800000101.000001",
      });
      await clickButton(env, fetch, {
        actionId: ACTION_IDS.refApprove,
        value: flow.approveValue,
        channelId: ORIGIN_CHANNEL,
        messageTs: flow.previewMessageTs,
        actionTs: "1800000102.000001",
      });

      expect(postCalls(calls).length).toBe(postsBefore + 1); // not 2
      // The second click was refused outright (already committed) — a
      // "gone" outcome, surfaced only as an ephemeral to the clicker.
      expect(ephemeralCalls(calls).length).toBeGreaterThanOrEqual(1);
    } finally {
      await env.dispose();
    }
  });
});

describe("a rejected or refused approval posts nothing", () => {
  it("ref_reject posts no reply, only cancels the preview", async () => {
    const env = await createTestEnv();
    try {
      const { fetch, calls } = createE2eFetch(SMALL_FIXTURE);
      const flow = await authorDraft(env, fetch, calls, SMALL_FIXTURE);
      const postsBefore = postCalls(calls).length;

      await clickButton(env, fetch, {
        actionId: ACTION_IDS.refReject,
        value: flow.rejectValue,
        channelId: ORIGIN_CHANNEL,
        messageTs: flow.previewMessageTs,
      });

      expect(postCalls(calls).length).toBe(postsBefore); // no reply posted
      const updates = updateCalls(calls);
      expect(updates[updates.length - 1]?.body?.ts).toBe(flow.previewMessageTs); // the preview was cancelled in place

      const draftRow = await env.db
        .prepare("SELECT consumed_at FROM ref_drafts WHERE slug = ?")
        .bind(SMALL_FIXTURE.refSlug)
        .first<{ consumed_at: number | null }>();
      expect(draftRow?.consumed_at).not.toBeNull();
      const committed = await env.db.prepare("SELECT slug FROM product_refs WHERE slug = ?").bind(SMALL_FIXTURE.refSlug).first();
      expect(committed).toBeNull(); // nothing was ever written
    } finally {
      await env.dispose();
    }
  });

  it("a stale approval (the product was created out from under it) is refused and posts no reply", async () => {
    const env = await createTestEnv();
    try {
      const { fetch, calls } = createE2eFetch(SMALL_FIXTURE);
      const flow = await authorDraft(env, fetch, calls, SMALL_FIXTURE);

      // Simulates a race: something else committed this slug after the
      // draft was authored (mode "new" -> base_version null) but before
      // this approve click reaches D1 — approveRefDraft's own base_version
      // fence must catch this, the same fence src/slack/reply-resume.test.ts
      // pins directly against a seeded draft. Reached here via a real
      // authored draft instead, proving the fence still holds once the
      // draft came from the full click-through pipeline.
      await env.db
        .prepare(
          "INSERT INTO product_refs (slug, category, product_url, body_md, version, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, 'race', ?)",
        )
        .bind(SMALL_FIXTURE.refSlug, "small", SMALL_FIXTURE.productUrl, SMALL_FIXTURE.authoredBody, CLOCK_MS)
        .run();

      const postsBefore = postCalls(calls).length;
      await clickButton(env, fetch, {
        actionId: ACTION_IDS.refApprove,
        value: flow.approveValue,
        channelId: ORIGIN_CHANNEL,
        messageTs: flow.previewMessageTs,
      });

      expect(postCalls(calls).length).toBe(postsBefore); // no reply posted
      expect(ephemeralCalls(calls).length).toBeGreaterThanOrEqual(1); // refused, told to the clicker

      const draftRow = await env.db
        .prepare("SELECT consumed_at FROM ref_drafts WHERE slug = ? ORDER BY rowid DESC LIMIT 1")
        .bind(SMALL_FIXTURE.refSlug)
        .first<{ consumed_at: number | null }>();
      // A refusal writes nothing at all — not even consumed_at (src/slack/
      // interactions.ts handleRefDraftDecision's own doc comment) — so the
      // SAME draft could still be approved again once the cause is fixed.
      expect(draftRow?.consumed_at).toBeNull();
    } finally {
      await env.dispose();
    }
  });
});
