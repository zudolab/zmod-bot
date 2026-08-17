/**
 * The end-to-end confirmation for epic #22 thread continuity (issue #29).
 * tests/jobs/thread-inheritance.test.ts already proves the inheritance
 * *logic* exhaustively (degradation, isolation, malformed data, the
 * three-turn chain) by seeding jobs directly and driving runDeliveryPass
 * with a fake composeReply. tests/e2e-deterministic.test.ts's "picker
 * click on a modifier-only follow-up" section proves the click-through
 * half of the real seam. Neither proves the seam this issue asks for:
 * a modifier-only follow-up that composes and posts a reply **directly**
 * — no picker click involved — reached through the real HTTP entry point
 * (a genuinely HMAC-signed `POST /slack/events`, verified by
 * src/slack/verify.ts) across multiple turns of the same thread, exactly
 * as a real Slack retry/immediate-delivery cycle would deliver them.
 *
 * Same fakes-at-the-boundary discipline as tests/e2e-deterministic.test.ts
 * (no network, no real model call): the `AI` binding always fails
 * (createGuardTrippingAi), which deterministically drives
 * composeReply's real guard-trip -> deterministic-fallback path, making
 * every byte-exact assertion below hold unconditionally.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleSlackEventsWithDeps, type SlackEventsDeps } from "../src/slack/events";
import { computeArrivalPresetOptions } from "../src/slack/commands";
import { parseProductRefMarkdown } from "../src/refs/parse";
import type { ProductRef } from "../src/refs/model";
import { renderDeterministicReply } from "../src/reply/render";
import { formatArrivalSchedule } from "../src/reply/templates";
import type { FetchLike, WaitUntilFn } from "../src/types";
import { createTestEnv, type TestEnvHandle } from "./helpers/test-env";
import migration0002 from "../migrations/0002_seed_product_refs.sql?raw";

/* -------------------------------------------------------------------------
 * Corpus — read from data/seed directly, exactly like
 * tests/e2e-deterministic.test.ts (see that file's comment for why: D1 is
 * not frozen, so a golden expectation pointed at the database would fail
 * on data drift rather than on a real regression).
 * ---------------------------------------------------------------------- */

const sources = new Map(
  Object.entries(
    import.meta.glob("../data/seed/products/*.md", { query: "?raw", import: "default", eager: true }),
  ).map(([path, markdown]): [string, string] => [path.replace(/^.*\/(.+)\.md$/, "$1"), markdown as string]),
);

function ref(slug: string): ProductRef {
  const markdown = sources.get(slug);
  if (markdown === undefined) throw new Error(`no such corpus file: ${slug}.md`);
  return parseProductRefMarkdown({ slug, markdown });
}

/* -------------------------------------------------------------------------
 * Signing — independently computed, mirroring
 * tests/e2e-deterministic.test.ts's own helper.
 * ---------------------------------------------------------------------- */

const SIGNING_SECRET = "e2e-thread-inheritance-signing-secret";
const BOT_USER_ID = "U0INHERITBOT";
const CHANNEL = "C0INHERIT";
/** Frozen throughout, like every other test file in this repo — a real clock would make the arrival-date expectations below flaky across a day boundary. */
const CLOCK_MS = 1_755_043_200_000;
const encoder = new TextEncoder();

async function computeSignature(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  return `v0=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function signedRequest(body: string): Promise<Request> {
  const timestamp = String(Math.floor(CLOCK_MS / 1000));
  const signature = await computeSignature(body, timestamp);
  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
      "content-type": "application/json",
    },
    body,
  });
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

/* -------------------------------------------------------------------------
 * Fakes — every I/O boundary composeReply/postMessage could reach.
 * ---------------------------------------------------------------------- */

/** Drives composeReply's real guard-trip -> deterministic-fallback path, exactly like tests/e2e-deterministic.test.ts's own helper of the same name. No network. */
function createGuardTrippingAi(): Ai {
  return {
    run: async () => {
      throw new Error("e2e-thread-inheritance: AI intentionally unavailable in this local test tier");
    },
  } as unknown as Ai;
}

interface FakeFetchCall {
  url: string;
  body: Record<string, unknown>;
}

/** Records every outbound Slack Web API call and answers success. No real network. */
function createFakeSlackFetch(): { fetch: FetchLike; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let postCounter = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url.endsWith("/chat.postMessage")) {
      postCounter += 1;
      return new Response(
        JSON.stringify({ ok: true, channel: body.channel, ts: `9500.${String(postCounter).padStart(6, "0")}` }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, message_ts: "9501.000001" }), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function makeWaitUntil(): { waitUntil: WaitUntilFn; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  return { waitUntil: (promise) => void scheduled.push(promise), scheduled };
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    AI: createGuardTrippingAi(),
    SLACK_BOT_TOKEN: "xoxb-e2e-inherit-test",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    ANTHROPIC_API_KEY: "sk-ant-e2e-inherit-test",
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_ALLOWED_CHANNEL_IDS: CHANNEL,
    SLACK_ADMIN_USER_IDS: "",
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    SITE_API_BASE: "https://takazudomodular.com/api",
  };
}

/** The inverse of src/slack/blocks.ts buildReplyBlocks — reconstructs the exact byte-for-byte reply text from a chat.postMessage payload's rich_text_preformatted block(s). Identical to tests/e2e-deterministic.test.ts's own helper. */
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

/** The arrival sentence a typed preset resolves to under the frozen clock — computed via the same function production code calls. */
function arrivalFor(preset: "tomorrow" | "day_after_tomorrow"): string {
  const option = computeArrivalPresetOptions(() => new Date(CLOCK_MS)).find((candidate) => candidate.preset === preset);
  if (!option) throw new Error(`no arrival preset option for ${preset}`);
  return formatArrivalSchedule({ dayLabel: option.dayLabel, month: option.month, day: option.day });
}

const ARRIVAL_TOMORROW = arrivalFor("tomorrow");

/* -------------------------------------------------------------------------
 * Shared env — one Miniflare D1 binding, seeded once with the full
 * 34-product corpus. Every scenario below uses a unique event_id and its
 * own thread_ts, so nothing here collides across `it()` blocks; nothing
 * writes to product_refs/product_ref_aliases, so reusing one seeded
 * instance is safe (matches tests/e2e-deterministic.test.ts's rationale).
 * ---------------------------------------------------------------------- */

let env: TestEnvHandle;

beforeAll(async () => {
  env = await createTestEnv({ migrations: [migration0002] });
});

afterAll(async () => {
  await env.dispose();
});

/**
 * Posts a genuinely HMAC-signed `app_mention` through the real events
 * handler (src/slack/events.ts handleSlackEventsWithDeps — the same
 * function src/router.ts calls), then awaits the immediate-delivery
 * promise the handler itself schedules via `waitUntil` — i.e. the real
 * runDeliveryPass, never a second, separately-invoked one. Returns the
 * single chat.postMessage call this turn produced.
 */
async function postMentionAndDeliver(opts: { eventId: string; text: string; threadTs: string }): Promise<{
  post: FakeFetchCall;
}> {
  const { fetch: fakeFetch, calls } = createFakeSlackFetch();
  const testEnv = makeEnv(env.db);
  const { waitUntil, scheduled } = makeWaitUntil();
  const ts = nextSlackTs();
  const body = JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event: {
      type: "app_mention",
      channel: CHANNEL,
      user: "U_HUMAN",
      text: `<@${BOT_USER_ID}> ${opts.text}`,
      ts,
      event_ts: ts,
      thread_ts: opts.threadTs,
    },
  });
  const request = await signedRequest(body);
  const deps: SlackEventsDeps = { db: env.db, now: () => new Date(CLOCK_MS), waitUntil, fetch: fakeFetch };

  const response = await handleSlackEventsWithDeps(request, testEnv, deps);
  expect(response.status).toBe(200);
  expect(scheduled).toHaveLength(1);
  await scheduled[0];

  expect(calls).toHaveLength(1);
  const post = calls[0]!;
  expect(post.url).toBe("https://slack.com/api/chat.postMessage");
  return { post };
}

/* -------------------------------------------------------------------------
 * Two-turn: a modifier-only follow-up composes DIRECTLY (no picker) for
 * the same product, with the new turn's flag applied and the prior
 * turn's arrival date inherited.
 * ---------------------------------------------------------------------- */

describe("a modifier-only follow-up composes directly for the thread's product (no picker)", () => {
  it("ADDAC107 明日 -> --discord: same product, discord applied, arrival inherited", async () => {
    const threadTs = nextSlackTs();

    const firstEventId = nextEventId("addac-1");
    const { post: firstPost } = await postMentionAndDeliver({
      eventId: firstEventId,
      text: "ADDAC107 明日",
      threadTs,
    });
    // Turn 1 already carries an arrival date, so it composes immediately —
    // no picker, exactly what a naive re-implementation would need to get
    // right before turn 2 can inherit anything meaningful.
    expect(JSON.stringify(firstPost.body.blocks)).toContain("rich_text_preformatted");
    const firstReplyText = extractReplyText(firstPost.body.blocks);
    const firstExpected = renderDeterministicReply({
      ref: ref("addac107"),
      flags: { direct: false, discord: false },
      arrivalSchedule: ARRIVAL_TOMORROW,
    });
    expect(firstReplyText).toBe(firstExpected);

    const secondEventId = nextEventId("addac-2");
    const { post: secondPost } = await postMentionAndDeliver({
      eventId: secondEventId,
      text: "--discord",
      threadTs,
    });
    // The defining assertion: a bare `--discord` follow-up, naming no
    // product at all, still resolves straight to a composed reply — not
    // an arrival picker, not the "specify a product" error.
    expect(JSON.stringify(secondPost.body.blocks)).toContain("rich_text_preformatted");
    const secondReplyText = extractReplyText(secondPost.body.blocks);
    const secondExpected = renderDeterministicReply({
      ref: ref("addac107"),
      // Same product, this turn's flag applied, no accumulation from turn 1.
      flags: { direct: false, discord: true },
      // Inherited: turn 2 named no arrival date of its own.
      arrivalSchedule: ARRIVAL_TOMORROW,
      // addac107 carries no variant-match block, so this pins the exact
      // gating input (turn 1's raw text) rather than a visible difference.
      variantText: `<@${BOT_USER_ID}> ADDAC107 明日`,
    });
    expect(secondReplyText).toBe(secondExpected);
    // Proof this is not vacuous: turn 1 and turn 2's bodies genuinely
    // differ (the discord block only appears in turn 2's).
    expect(secondReplyText).not.toBe(firstReplyText);
  });
});

/* -------------------------------------------------------------------------
 * The three-turn chain (product -> --discord -> --direct) — the case a
 * naive implementation breaks. zudo-rail carries a variant-match literal
 * block (its Lite renewal + fragility notices — see
 * tests/e2e-deterministic.test.ts's own zudo-rail scenario), gated on the
 * text that *named* the "lite" variant. A naive inheritance that re-reads
 * only the immediately prior turn's raw text would find "--discord" on
 * turn 3 — no "lite" needle anywhere in it — and silently drop the
 * renewal notice from the reply the operator pastes to the customer.
 * This is exactly the regression tests/jobs/thread-inheritance.test.ts
 * documents at the unit level; this proves the fix holds through the
 * real, genuinely-signed HTTP seam across three separate deliveries.
 * ---------------------------------------------------------------------- */

describe("product -> --discord -> --direct: the three-turn chain a naive implementation breaks", () => {
  it("zudo-rail's Lite variant-match notice, product, and non-accumulating flags all survive three turns", async () => {
    const threadTs = nextSlackTs();
    const LITE_RENEWAL_NOTICE = "この商品を直近でリニューアルしまして";
    const FRAGILITY_NOTICE =
      "なお、こちらのレールは構造上やや折れやすい部分がございまして、組み立てや取り付けの際は無理な力をかけないよう、お気を付け頂けますと幸いです。";

    // Turn 1 names the "lite" variant — the only turn in the chain whose
    // own raw text contains that needle. zudo-rail is `small` category,
    // so no arrival date is involved at any turn.
    const firstRawText = `<@${BOT_USER_ID}> zudo-rail lite 60 set1`;
    const { post: firstPost } = await postMentionAndDeliver({
      eventId: nextEventId("rail-1"),
      text: "zudo-rail lite 60 set1",
      threadTs,
    });
    const firstReplyText = extractReplyText(firstPost.body.blocks);
    expect(firstReplyText).toContain(LITE_RENEWAL_NOTICE);
    expect(firstReplyText).toContain(FRAGILITY_NOTICE);
    expect(firstReplyText).toBe(
      renderDeterministicReply({
        ref: ref("zudo-rail"),
        flags: { direct: false, discord: false },
        arrivalSchedule: null,
        variantText: firstRawText,
      }),
    );

    // Turn 2: modifier-only, composes directly for the same product.
    const { post: secondPost } = await postMentionAndDeliver({
      eventId: nextEventId("rail-2"),
      text: "--discord",
      threadTs,
    });
    const secondReplyText = extractReplyText(secondPost.body.blocks);
    expect(secondReplyText).toContain(LITE_RENEWAL_NOTICE);
    expect(secondReplyText).toBe(
      renderDeterministicReply({
        ref: ref("zudo-rail"),
        flags: { direct: false, discord: true },
        arrivalSchedule: null,
        // Still gated on turn 1's text — turn 2's own raw text ("--discord")
        // contains no "lite" needle.
        variantText: firstRawText,
      }),
    );

    // Turn 3: modifier-only again. Its immediate predecessor (turn 2) is
    // itself modifier-only text with no "lite" anywhere in it — the exact
    // shape that breaks a naive "walk back one turn" implementation.
    const { post: thirdPost } = await postMentionAndDeliver({
      eventId: nextEventId("rail-3"),
      text: "--direct",
      threadTs,
    });
    const thirdReplyText = extractReplyText(thirdPost.body.blocks);
    // The regression this test guards: without the fix, the notice is
    // silently absent here even though nothing errored.
    expect(thirdReplyText).toContain(LITE_RENEWAL_NOTICE);
    expect(thirdReplyText).toContain(FRAGILITY_NOTICE);
    expect(thirdReplyText).toBe(
      renderDeterministicReply({
        ref: ref("zudo-rail"),
        // Turn 3's own flag applied; turn 2's `discord` does NOT carry
        // forward — flags never accumulate across turns.
        flags: { direct: true, discord: false },
        arrivalSchedule: null,
        variantText: firstRawText,
      }),
    );
  });
});
