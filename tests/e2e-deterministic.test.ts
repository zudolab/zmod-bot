/**
 * The integration gate (issue #12). Waves 2-5 built and unit-tested ten
 * modules independently; nobody had run them as one system. This exercises
 * the real seam end to end against a genuinely signed HTTP request, a real
 * Miniflare D1 binding seeded with the full 34-product corpus (migrations
 * 0001 + 0002), and injected fakes at every I/O boundary that would
 * otherwise touch the network — no real network, no real model call, no
 * real Slack call (issue #12's scope-correction comment moved a real
 * provider call, the 8s deadline against real latency, and whether
 * AbortController actually cancels a Workers AI call to issue #18; this
 * file must not attempt any of the three).
 *
 * Ingress goes through src/slack/events.ts's real
 * `handleSlackEventsWithDeps` / src/slack/interactions.ts's real
 * `handleSlackInteractionsWithDeps` — the same functions the router calls,
 * with every I/O boundary injected (db/now/fetch/waitUntil) rather than
 * read from a Workers runtime, exactly per CLAUDE.md's DI convention. This
 * keeps the clock frozen (every other test file in this repo freezes it
 * too) while still exercising the real business logic chain: recordIncomingEvent
 * -> resolveProductRef -> composeReply (its real guarded path, not a fake)
 * -> renderReply -> claimJobs/updateJobState -> postMessage. src/router.ts
 * and src/index.ts's two-line wrapper around these same functions are
 * already covered by src/router.test.ts and src/index.test.ts, so skipping
 * them here is not a coverage gap.
 *
 * COMPOSE_PROVIDER stays "workers-ai" throughout, with the `AI` binding
 * always a fake: by default one that *fails* every call
 * (createGuardTrippingAi), which deterministically drives composeReply's
 * real guard-trip -> deterministic-fallback path (CLAUDE.md: "deterministic
 * skeleton, LLM middle, deterministic fallback") without any network
 * involved. One scenario additionally uses a faithful echo (createFaithfulAi)
 * to prove the composed (non-fallback) path also reaches the customer
 * byte-identical to the deterministic renderer, through the full pipeline
 * rather than composeReply in isolation (already covered unit-level by
 * tests/compose/compose.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { handleSlackEventsWithDeps, type SlackEventsDeps } from "../src/slack/events";
import { handleSlackInteractionsWithDeps, type SlackInteractionsDeps } from "../src/slack/interactions";
import { ACTION_IDS, computeArrivalPresetOptions, encodeArrivalOptionArg, encodeButtonValue } from "../src/slack/commands";
import { CREATE_REFERENCE_ACTION_ID } from "../src/slack/blocks";
import { parseProductRefMarkdown } from "../src/refs/parse";
import type { ProductRef } from "../src/refs/model";
import { renderDeterministicReply, renderResourceSectionDeterministic } from "../src/reply/render";
import { formatArrivalSchedule } from "../src/reply/templates";
import type { FetchLike, WaitUntilFn } from "../src/types";
import { createTestEnv, type TestEnvHandle } from "./helpers/test-env";
import migration0002 from "../migrations/0002_seed_product_refs.sql?raw";

/* -------------------------------------------------------------------------
 * Corpus — read from data/seed directly (frozen fixture), never from D1,
 * matching tests/reply/golden.test.ts and tests/compose/compose.test.ts:
 * D1 is not frozen (ref new/refresh write at runtime), so a golden
 * expectation pointed at the database would start failing on data rather
 * than on a regression. The seed migration is generated FROM these same
 * files (scripts/build-seed-migration.mjs) and verified byte-identical on
 * round trip in tests/db/seed-migration.test.ts, so computing the expected
 * text here is equivalent to reading it back out of D1.
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
 * Signing — independently computed, mirroring src/slack/events.test.ts's
 * own helper (that file's comment explains why this is not the
 * sign-then-verify trap CLAUDE.md warns about: the signature math itself
 * is pinned to known-answer vectors in src/slack/verify.test.ts; what's
 * under test here is the pipeline behind it).
 * ---------------------------------------------------------------------- */

const SIGNING_SECRET = "e2e-deterministic-signing-secret";
const BOT_USER_ID = "U0E2EBOT";
const CHANNEL = "C0E2E";
/** Frozen throughout — every other test file in this repo freezes the clock too; a real one would make the arrival-date expectations below flaky across a day boundary. */
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

let tsSeq = 1_700_000_000;
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
 * Fakes — every I/O boundary composeReply/postMessage/openView could
 * reach, none of them real network.
 * ---------------------------------------------------------------------- */

/**
 * Drives composeReply's real guard-trip -> deterministic-fallback path
 * (src/reply/compose.ts classifyCallFailure) with no network involved:
 * `AI.run` simply rejects, exactly as an outage or a misconfiguration
 * would. This is deliberately the *default* fake for this file — it makes
 * the byte-exact assertions below hold unconditionally (the fallback
 * render is always renderDeterministicReply's own output) and, for the
 * empty-resources-section scenarios, makes the "zero calls" assertion
 * meaningful by giving every *other* product a call to have made.
 */
function createGuardTrippingAi(): { ai: Ai; calls: unknown[] } {
  const calls: unknown[] = [];
  const ai = {
    run: async (model: string, inputs: unknown) => {
      calls.push({ model, inputs });
      throw new Error("e2e-deterministic: AI intentionally unavailable in this local test tier (see issue #12/#18)");
    },
  } as unknown as Ai;
  return { ai, calls };
}

/** Echoes back a caller-supplied section, faithfully — drives composeReply's happy (non-fallback) path. Mirrors tests/compose/compose.test.ts's createFakeAi. */
function createFaithfulAi(text: string): Ai {
  return {
    run: async () => ({ response: text, usage: { prompt_tokens: 111, completion_tokens: 222 } }),
  } as unknown as Ai;
}

interface FakeFetchCall {
  url: string;
  body: Record<string, unknown>;
}

/** Records every outbound Slack Web API call and answers success — chat.postMessage, chat.update, views.open, chat.postEphemeral all just need `{ ok: true, ... }`. No real network. */
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
        JSON.stringify({ ok: true, channel: body.channel, ts: `9000.${String(postCounter).padStart(6, "0")}` }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, message_ts: "9001.000001" }), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function makeWaitUntil(): { waitUntil: WaitUntilFn; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  return { waitUntil: (promise) => void scheduled.push(promise), scheduled };
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    AI: createGuardTrippingAi().ai,
    SLACK_BOT_TOKEN: "xoxb-e2e-test",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    ANTHROPIC_API_KEY: "sk-ant-e2e-test",
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_ALLOWED_CHANNEL_IDS: CHANNEL,
    SLACK_ADMIN_USER_IDS: "",
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    SITE_API_BASE: "https://takazudomodular.com/api",
    ...overrides,
  };
}

/** Reconstructs the exact byte-for-byte reply text from a chat.postMessage/chat.update payload's `rich_text_preformatted` block(s) — the inverse of src/slack/blocks.ts buildReplyBlocks, whose own doc comment guarantees `chunks.join("")` reproduces the original string exactly. */
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

/** The arrival sentence a typed preset (明日/明後日/明々後日) resolves to under the frozen clock — computed via the same function production code calls, so it can never disagree with what the code under test actually did. */
function arrivalFor(preset: "tomorrow" | "day_after_tomorrow"): string {
  const option = computeArrivalPresetOptions(() => new Date(CLOCK_MS)).find((candidate) => candidate.preset === preset);
  if (!option) throw new Error(`no arrival preset option for ${preset}`);
  return formatArrivalSchedule({ dayLabel: option.dayLabel, month: option.month, day: option.day });
}

const ARRIVAL_TOMORROW = arrivalFor("tomorrow");
const ARRIVAL_DAY_AFTER_TOMORROW = arrivalFor("day_after_tomorrow");
const DEFAULT_FLAGS = { direct: false, discord: false };

/* -------------------------------------------------------------------------
 * Shared env — one Miniflare D1 binding, seeded once with the full
 * 34-product corpus (migrations 0001 + 0002). Every scenario below uses a
 * unique event_id and thread_ts, so nothing here collides across `it()`
 * blocks; none of them write to product_refs/product_ref_aliases, so
 * reusing one seeded instance (rather than re-seeding per test, as
 * tests/jobs/worker.test.ts does for its from-scratch fixtures) is safe
 * and keeps a 34-product migration out of every single test's setup cost.
 * ---------------------------------------------------------------------- */

let env: TestEnvHandle;

beforeAll(async () => {
  env = await createTestEnv({ migrations: [migration0002] });
});

afterAll(async () => {
  await env.dispose();
});

/**
 * Posts a genuinely signed app_mention through the real events handler,
 * asserts the durable-intent contract (200, receipt row, job row pending,
 * *no* Slack call yet — see the inline comment below for why that's safe
 * by construction rather than by luck), then runs the job worker by
 * awaiting the same promise the immediate-delivery optimization already
 * scheduled via `waitUntil` (src/slack/events.ts) — i.e. the real
 * runDeliveryPass, not a second, separately-invoked one.
 */
async function runReplyCycle(opts: { eventId: string; text: string; ai?: Ai; threadTs?: string }): Promise<{
  fetchCalls: FakeFetchCall[];
  jobId: number;
  /** The exact `text` field the mention was delivered with — what `variant-match` literal blocks are gated on. */
  rawText: string;
}> {
  const { fetch: fakeFetch, calls } = createFakeSlackFetch();
  const testEnv = makeEnv(env.db, opts.ai ? { AI: opts.ai } : {});
  const { waitUntil, scheduled } = makeWaitUntil();
  const ts = nextSlackTs();
  const rawText = `<@${BOT_USER_ID}> ${opts.text}`;
  const body = JSON.stringify({
    type: "event_callback",
    event_id: opts.eventId,
    event: {
      type: "app_mention",
      channel: CHANNEL,
      user: "U_HUMAN",
      text: rawText,
      ts,
      event_ts: ts,
      // Omitted for a top-level mention, which src/slack/events.ts then
      // normalises to `ts` — i.e. a thread of its own, which is why every
      // other scenario in this file is isolated from the next by default.
      ...(opts.threadTs === undefined ? {} : { thread_ts: opts.threadTs }),
    },
  });
  const request = await signedRequest("https://example.com/slack/events", body);
  const deps: SlackEventsDeps = { db: env.db, now: () => new Date(CLOCK_MS), waitUntil, fetch: fakeFetch };

  const response = await handleSlackEventsWithDeps(request, testEnv, deps);
  expect(response.status).toBe(200);

  // "No Slack call has happened yet" is safe to assert here by
  // construction, not by luck: runDeliveryPass's first operation
  // (claimJobs) is a real async D1 round trip that cannot resolve inside
  // the synchronous continuation following our single `await` above — it
  // hasn't even been scheduled a macrotask yet. There is no earlier point
  // in this function's control flow at which a chat.postMessage call
  // could possibly have already landed.
  expect(calls).toHaveLength(0);

  const jobRow = await env.db
    .prepare("SELECT id, state FROM jobs WHERE event_id = ?")
    .bind(opts.eventId)
    .first<{ id: number; state: string }>();
  expect(jobRow).toBeTruthy();
  expect(jobRow!.state).toBe("pending");

  const receiptRow = await env.db
    .prepare("SELECT event_id FROM slack_event_receipts WHERE event_id = ?")
    .bind(opts.eventId)
    .first();
  expect(receiptRow).toBeTruthy();

  expect(scheduled).toHaveLength(1);
  await scheduled[0]; // "run the job worker" — the real runDeliveryPass.

  return { fetchCalls: calls, jobId: jobRow!.id, rawText };
}

/* -------------------------------------------------------------------------
 * 1-6: the full claim -> compose -> post -> done cycle, byte-exact against
 * the deterministic renderer, plus re-delivery idempotency.
 * ---------------------------------------------------------------------- */

describe("general: a typed arrival date completes the full cycle byte-exact", () => {
  it("addac107 明後日 — claim -> compose (guard trips, deterministic fallback) -> post -> done", async () => {
    const eventId = nextEventId("general-addac107");
    const { fetchCalls, jobId } = await runReplyCycle({ eventId, text: "ADDAC107 明後日" });

    expect(fetchCalls).toHaveLength(1);
    const post = fetchCalls[0]!;
    expect(post.url).toBe("https://slack.com/api/chat.postMessage");
    expect(post.body.channel).toBe(CHANNEL);
    expect(post.body.thread_ts).toBeTruthy();
    expect(post.body.unfurl_links).toBe(false);
    expect(typeof post.body.text).toBe("string");
    expect((post.body.text as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(post.body.blocks)).toContain("rich_text_preformatted");

    const replyText = extractReplyText(post.body.blocks);
    const expected = renderDeterministicReply({
      ref: ref("addac107"),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL_DAY_AFTER_TOMORROW,
    });
    expect(replyText).toBe(expected);

    const jobRow = await env.db
      .prepare("SELECT state, completed_at FROM jobs WHERE id = ?")
      .bind(jobId)
      .first<{ state: string; completed_at: number | null }>();
    expect(jobRow?.state).toBe("done");
    expect(jobRow?.completed_at).not.toBeNull();

    // The guard-tripping AI forced the fallback path — exactly one
    // usage_log row naming why, per src/reply/compose.ts recordUsage.
    const usageRows = await env.db
      .prepare("SELECT fallback FROM usage_log WHERE slug = ?")
      .bind("addac107")
      .all<{ fallback: string | null }>();
    expect(usageRows.results).toHaveLength(1);
    expect(usageRows.results[0]?.fallback).toBeTruthy();
  });

  it("re-delivering the same event_id posts nothing further and creates no second job row", async () => {
    const eventId = nextEventId("general-dedup");
    const first = await runReplyCycle({ eventId, text: "ADDAC107 明日" });
    expect(first.fetchCalls).toHaveLength(1);

    const { fetch: fakeFetch2, calls: calls2 } = createFakeSlackFetch();
    const { waitUntil: waitUntil2, scheduled: scheduled2 } = makeWaitUntil();
    const ts = nextSlackTs();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      event: {
        type: "app_mention",
        channel: CHANNEL,
        user: "U_HUMAN",
        text: `<@${BOT_USER_ID}> ADDAC107 明日`,
        ts,
        event_ts: ts,
      },
    });
    const request = await signedRequest("https://example.com/slack/events", body);
    const deps: SlackEventsDeps = { db: env.db, now: () => new Date(CLOCK_MS), waitUntil: waitUntil2, fetch: fakeFetch2 };

    const response = await handleSlackEventsWithDeps(request, makeEnv(env.db), deps);

    expect(response.status).toBe(200);
    // recordIncomingEvent's ON CONFLICT DO NOTHING already fired for this
    // event_id -> no job returned -> the immediate-delivery optimization
    // is never even scheduled.
    expect(scheduled2).toHaveLength(0);
    expect(calls2).toHaveLength(0);

    const jobCount = await env.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE event_id = ?")
      .bind(eventId)
      .first<{ count: number }>();
    expect(jobCount?.count).toBe(1);
  });
});

/* -------------------------------------------------------------------------
 * The empty-resources-section path — the #1 highest-value assertion from
 * the issue's wave 4-5 findings: composeReply must return before any I/O.
 * ---------------------------------------------------------------------- */

describe("empty resource section — composeReply returns before any I/O", () => {
  it.each([
    { slug: "ai-mult", text: "ai-mult-built-black 明日" },
    { slug: "oxi-pipe-mk2", text: "oxi-pipe-mk2 明日" },
    { slug: "x0x-heart", text: "x0x-heart 明日" },
  ])("$slug: no provider call, no usage_log row, still posts the correct (base-template-only) reply", async ({ slug, text }) => {
    const { ai, calls: aiCalls } = createGuardTrippingAi();
    const eventId = nextEventId(`empty-${slug}`);
    const { fetchCalls } = await runReplyCycle({ eventId, text, ai });

    expect(aiCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);

    const usageRows = await env.db.prepare("SELECT slug FROM usage_log WHERE slug = ?").bind(slug).all();
    expect(usageRows.results).toHaveLength(0);

    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    const expected = renderDeterministicReply({
      ref: ref(slug),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL_TOMORROW,
      purchased: "built",
    });
    expect(replyText).toBe(expected);
  });
});

/* -------------------------------------------------------------------------
 * general-diy: built vs kit actually reaching the message. Structurally
 * impossible before #14, and the failure mode is silent (the reply still
 * looks fine — it's just the wrong half of the product).
 * ---------------------------------------------------------------------- */

describe("general-diy: built vs kit reaching the message", () => {
  it("a kit purchase renders the diy template and its diy-only sections", async () => {
    const eventId = nextEventId("diy-kit");
    const rawText = `<@${BOT_USER_ID}> ai-lpg-diy-black 明日`;
    const { fetchCalls } = await runReplyCycle({ eventId, text: "ai-lpg-diy-black 明日" });

    expect(fetchCalls).toHaveLength(1);
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    // Build Guide (diy only) — rendered into the diy template's own
    // {build_guide} slot — and Videos (diy only, reference).
    expect(replyText).toContain("https://aisynthesis.com/diy-low-pass-gate/");
    expect(replyText).toContain("https://youtu.be/bvBlOdN_4s8");

    const expected = renderDeterministicReply({
      ref: ref("ai-lpg"),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL_TOMORROW,
      purchased: "kit",
      variantText: rawText,
    });
    expect(replyText).toBe(expected);
  });

  it("a built purchase of the same product renders neither diy-only section", async () => {
    const eventId = nextEventId("diy-built");
    const rawText = `<@${BOT_USER_ID}> ai-lpg-built-alumi 明日`;
    const { fetchCalls } = await runReplyCycle({ eventId, text: "ai-lpg-built-alumi 明日" });

    expect(fetchCalls).toHaveLength(1);
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    expect(replyText).not.toContain("https://aisynthesis.com/diy-low-pass-gate/");
    expect(replyText).not.toContain("youtu.be/bvBlOdN_4s8");
    expect(replyText).not.toContain("youtu.be/rHy9h23GLak");

    const expected = renderDeterministicReply({
      ref: ref("ai-lpg"),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL_TOMORROW,
      purchased: "built",
      variantText: rawText,
    });
    expect(replyText).toBe(expected);
  });

  it("a variant-ambiguous mention (bare AI017) asks rather than defaulting to built", async () => {
    const eventId = nextEventId("diy-ambiguous");
    const { fetchCalls } = await runReplyCycle({ eventId, text: "AI017 明日" });

    expect(fetchCalls).toHaveLength(1);
    const blocksText = JSON.stringify(fetchCalls[0]!.body.blocks);
    expect(blocksText).toContain(ACTION_IDS.variantPick);
    expect(blocksText).not.toContain("rich_text_preformatted");
  });
});

/* -------------------------------------------------------------------------
 * zudo-rail's Lite renewal notice (a variant-match literal block) reaching
 * the message — small category, no arrival date involved at all.
 * ---------------------------------------------------------------------- */

describe("zudo-rail's variant-gated literal blocks reaching the message", () => {
  it("a Lite purchase ships both the renewal and the fragility notice", async () => {
    const eventId = nextEventId("rail-lite");
    const rawText = `<@${BOT_USER_ID}> zudo-rail lite 60 set1`;
    const { fetchCalls } = await runReplyCycle({ eventId, text: "zudo-rail lite 60 set1" });

    expect(fetchCalls).toHaveLength(1);
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    expect(replyText).toContain("この商品を直近でリニューアルしまして");
    expect(replyText).toContain(
      "なお、こちらのレールは構造上やや折れやすい部分がございまして、組み立てや取り付けの際は無理な力をかけないよう、お気を付け頂けますと幸いです。",
    );

    const expected = renderDeterministicReply({
      ref: ref("zudo-rail"),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: null,
      variantText: rawText,
    });
    expect(replyText).toBe(expected);
  });

  it("no variant named ships only the unconditional fragility notice", async () => {
    const eventId = nextEventId("rail-plain");
    const { fetchCalls } = await runReplyCycle({ eventId, text: "zudo rail" });

    expect(fetchCalls).toHaveLength(1);
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    expect(replyText).not.toContain("この商品を直近でリニューアルしまして");
    expect(replyText).toContain(
      "なお、こちらのレールは構造上やや折れやすい部分がございまして、組み立てや取り付けの際は無理な力をかけないよう、お気を付け頂けますと幸いです。",
    );
  });
});

/* -------------------------------------------------------------------------
 * zudo-3u-to-1u: the one product in the corpus where the editorial/
 * customer-facing prose distinction (#7/#13) is observable end to end —
 * confirmed on both the fallback and the composed path, per the issue.
 * ---------------------------------------------------------------------- */

describe("zudo-3u-to-1u: customer-facing prose vs editorial Notes", () => {
  const USAGE_PROSE =
    "本製品は、横に長く空いている穴部分へ、3Uモジュールを取り付けて使用します。このパネル自体にはネジを止めるタップ（ネジを支える形状の溝）がありませんので、付属のネジとナットを使用し、裏側でネジをナットで固定してご使用ください。";
  const EDITORIAL_NOTES_PROSE =
    "Intellijelフォーマットの1Uスロットに、3Uモジュール（最大4HP幅）を設置出来るようにするコンバーターパネルセット。";

  it("carries the 取り付け方法 installation text and no Notes text — deterministic-fallback path", async () => {
    const eventId = nextEventId("3u-fallback");
    const { fetchCalls } = await runReplyCycle({ eventId, text: "zudo 3u to 1u" });

    expect(fetchCalls).toHaveLength(1);
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    expect(replyText).toContain(USAGE_PROSE);
    expect(replyText).not.toContain(EDITORIAL_NOTES_PROSE);
    expect(replyText).not.toContain("## Notes");
    expect(replyText).not.toContain("## Usage Guide");

    const expected = renderDeterministicReply({ ref: ref("zudo-3u-to-1u"), flags: DEFAULT_FLAGS, arrivalSchedule: null });
    expect(replyText).toBe(expected);
  });

  it("carries the same text via the composed (non-fallback) path too", async () => {
    const section = renderResourceSectionDeterministic(ref("zudo-3u-to-1u"), {});
    const ai = createFaithfulAi(section);
    const eventId = nextEventId("3u-composed");
    const { fetchCalls } = await runReplyCycle({ eventId, text: "zudo 3u to 1u", ai });

    expect(fetchCalls).toHaveLength(1);
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    expect(replyText).toContain(USAGE_PROSE);
    expect(replyText).not.toContain(EDITORIAL_NOTES_PROSE);

    const expected = renderDeterministicReply({ ref: ref("zudo-3u-to-1u"), flags: DEFAULT_FLAGS, arrivalSchedule: null });
    expect(replyText).toBe(expected);

    const usageRows = await env.db
      .prepare("SELECT fallback FROM usage_log WHERE slug = ? ORDER BY id DESC LIMIT 1")
      .bind("zudo-3u-to-1u")
      .all<{ fallback: string | null }>();
    expect(usageRows.results).toHaveLength(1);
    expect(usageRows.results[0]?.fallback).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * A resolver miss does not dead-end.
 * ---------------------------------------------------------------------- */

describe("resolver miss", () => {
  it("posts the 'no reference yet' message with a create-reference button and completes the job", async () => {
    const eventId = nextEventId("miss");
    const { fetchCalls, jobId } = await runReplyCycle({ eventId, text: "totally unknown eurorack module qwzx9999" });

    expect(fetchCalls).toHaveLength(1);
    const blocksText = JSON.stringify(fetchCalls[0]!.body.blocks);
    expect(blocksText).toContain(CREATE_REFERENCE_ACTION_ID);
    expect(blocksText).not.toContain("rich_text_preformatted");

    const jobRow = await env.db.prepare("SELECT state FROM jobs WHERE id = ?").bind(jobId).first<{ state: string }>();
    expect(jobRow?.state).toBe("done"); // asking is a completed response, not a stuck job
  });
});

/* -------------------------------------------------------------------------
 * variant_pick / candidate_pick click-through — #14 wired the routing but
 * only unit-tested arrival_pick and the arrival_other modal end to end;
 * these two were covered only indirectly, by worker.test.ts asserting the
 * right picker gets posted. This drives the actual click.
 * ---------------------------------------------------------------------- */

interface ClickResult {
  fetchCalls: FakeFetchCall[];
}

/** Simulates a block_actions click. `a`/`p` map directly onto ButtonValueEnvelope's own fields — a caller building a picker's exact button value, not a single opaque "arg". */
async function clickButton(opts: {
  actionId: string;
  jobId: number;
  a?: string;
  p?: string;
  ai?: Ai;
}): Promise<ClickResult> {
  const testEnv = makeEnv(env.db, opts.ai ? { AI: opts.ai } : {});
  const { fetch: fakeFetch, calls } = createFakeSlackFetch();
  const { waitUntil, scheduled } = makeWaitUntil();
  const value = encodeButtonValue({
    v: 1,
    id: String(opts.jobId),
    ...(opts.a === undefined ? {} : { a: opts.a }),
    ...(opts.p === undefined ? {} : { p: opts.p }),
  });
  const clickPayload = {
    type: "block_actions",
    actions: [{ action_id: opts.actionId, action_ts: nextSlackTs(), value }],
    user: { id: "U_HUMAN" },
    container: { channel_id: CHANNEL, message_ts: "9000.000001" },
  };
  const form = `payload=${encodeURIComponent(JSON.stringify(clickPayload))}`;
  const request = await signedRequest("https://example.com/slack/interactions", form, "application/x-www-form-urlencoded");
  const deps: SlackInteractionsDeps = { db: env.db, now: () => new Date(CLOCK_MS), fetch: fakeFetch, waitUntil };

  const response = await handleSlackInteractionsWithDeps(request, testEnv, deps);
  expect(response.status).toBe(200);
  // Ack fast, do the work in the background — nothing posted yet.
  expect(calls).toHaveLength(0);
  expect(scheduled).toHaveLength(1);
  await scheduled[0];

  return { fetchCalls: calls };
}

/** The button-value arg for a given arrival preset under the frozen clock — same shape buildArrivalPickerPayload itself encodes. */
function arrivalOptionArg(preset: "tomorrow" | "day_after_tomorrow"): string {
  const option = computeArrivalPresetOptions(() => new Date(CLOCK_MS)).find((candidate) => candidate.preset === preset);
  if (!option) throw new Error(`no arrival preset option for ${preset}`);
  return encodeArrivalOptionArg(option);
}

describe("variant_pick click-through", () => {
  it("clicking 'DIYキット' finishes composing the real reply via chat.update", async () => {
    const eventId = nextEventId("variant-pick");
    const rawText = `<@${BOT_USER_ID}> AI017 明日`;
    const { fetchCalls: postCalls, jobId } = await runReplyCycle({ eventId, text: "AI017 明日" });
    expect(postCalls).toHaveLength(1); // the picker, not the final reply

    const { fetchCalls } = await clickButton({ actionId: `${ACTION_IDS.variantPick}_1`, jobId, a: "kit" });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://slack.com/api/chat.update");
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    expect(replyText).toContain("https://aisynthesis.com/diy-low-pass-gate/");

    const expected = renderDeterministicReply({
      ref: ref("ai-lpg"),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL_TOMORROW,
      purchased: "kit",
      variantText: rawText,
    });
    expect(replyText).toBe(expected);
  });

  /**
   * Regression (found by this confirm pass): a variant_pick choice for a
   * product that *also* needs an arrival date used to chain into the
   * arrival picker and then silently lose the choice — the arrival_pick
   * click that followed re-resolved the product from the job's
   * still-ambiguous raw text ("AI017", no built/kit signal anywhere in
   * it), which correctly re-finds ai-lpg but has no memory of "kit", so
   * it composed as "built" with no error anywhere — precisely the
   * "shipping a built-product reply for a kit purchase" failure the
   * variant-ambiguous mechanism exists to prevent (src/refs/resolve.ts).
   * Fixed by carrying the choice through the picker's own button values
   * (src/slack/commands.ts ButtonValueEnvelope.p / encodePriorChoice).
   */
  it("a variant chosen before the arrival date is still honored after the arrival_pick click, not silently defaulted to built", async () => {
    const eventId = nextEventId("variant-pick-then-arrival");
    const rawText = `<@${BOT_USER_ID}> AI017`;
    const { fetchCalls: postCalls, jobId } = await runReplyCycle({ eventId, text: "AI017" });
    expect(postCalls).toHaveLength(1);
    expect(JSON.stringify(postCalls[0]!.body.blocks)).toContain(ACTION_IDS.variantPick);

    const { fetchCalls: variantPickCalls } = await clickButton({ actionId: `${ACTION_IDS.variantPick}_1`, jobId, a: "kit" });
    // Still ambiguous on arrival — chains into the arrival picker rather
    // than composing yet.
    expect(variantPickCalls).toHaveLength(1);
    expect(variantPickCalls[0]!.url).toBe("https://slack.com/api/chat.update");
    const arrivalPickerBlocks = JSON.stringify(variantPickCalls[0]!.body.blocks);
    expect(arrivalPickerBlocks).toContain(ACTION_IDS.arrivalPick);
    expect(arrivalPickerBlocks).not.toContain("rich_text_preformatted");
    // The "kit" choice must be riding along on every button in this
    // picker (buildArrivalPickerPayload's priorChoice param) — otherwise
    // the very next click has no way to recover it.
    expect(arrivalPickerBlocks).toContain("variant:kit");

    const { fetchCalls: arrivalPickCalls } = await clickButton({
      actionId: `${ACTION_IDS.arrivalPick}_0`,
      jobId,
      a: arrivalOptionArg("tomorrow"),
      p: "variant:kit", // exactly what the picker's own button carried
    });

    expect(arrivalPickCalls).toHaveLength(1);
    expect(arrivalPickCalls[0]!.url).toBe("https://slack.com/api/chat.update");
    const replyText = extractReplyText(arrivalPickCalls[0]!.body.blocks);
    // The defect this test guards: without the fix, this contains
    // neither diy-only URL and matches the *built* rendering instead.
    expect(replyText).toContain("https://aisynthesis.com/diy-low-pass-gate/");

    const expected = renderDeterministicReply({
      ref: ref("ai-lpg"),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL_TOMORROW,
      purchased: "kit",
      variantText: rawText,
    });
    expect(replyText).toBe(expected);
  });
});

describe("candidate_pick click-through", () => {
  it("clicking a specific candidate ('metamodule') finishes composing the real reply via chat.update", async () => {
    // A real corpus-level naming coincidence (see
    // tests/refs/resolve-corpus.test.ts): "meta" resolves ambiguously
    // between metamodule and oxi-meta. Bare, with no arrival date typed —
    // appending one breaks the containment match this ambiguity itself
    // depends on (a short candidate like "meta" only matches because it
    // is a *substring* of each product's longer alias; appending a
    // trailing token stops either alias from containing the whole thing).
    const eventId = nextEventId("candidate-pick");
    const rawText = `<@${BOT_USER_ID}> meta`;
    const { fetchCalls: postCalls, jobId } = await runReplyCycle({ eventId, text: "meta" });
    expect(postCalls).toHaveLength(1); // the candidate picker, not the final reply
    expect(JSON.stringify(postCalls[0]!.body.blocks)).toContain(ACTION_IDS.candidatePick);

    const { fetchCalls: candidatePickCalls } = await clickButton({
      actionId: `${ACTION_IDS.candidatePick}_0`,
      jobId,
      a: "metamodule",
    });
    // metamodule is `general` — still needs an arrival date, so this
    // chains into the arrival picker rather than composing yet.
    expect(candidatePickCalls).toHaveLength(1);
    expect(candidatePickCalls[0]!.url).toBe("https://slack.com/api/chat.update");
    const arrivalPickerBlocks = JSON.stringify(candidatePickCalls[0]!.body.blocks);
    expect(arrivalPickerBlocks).toContain(ACTION_IDS.arrivalPick);
    expect(arrivalPickerBlocks).not.toContain("rich_text_preformatted");
    expect(arrivalPickerBlocks).toContain("candidate:metamodule");

    const { fetchCalls: arrivalPickCalls } = await clickButton({
      actionId: `${ACTION_IDS.arrivalPick}_0`,
      jobId,
      a: arrivalOptionArg("tomorrow"),
      p: "candidate:metamodule", // exactly what the picker's own button carried
    });

    expect(arrivalPickCalls).toHaveLength(1);
    expect(arrivalPickCalls[0]!.url).toBe("https://slack.com/api/chat.update");
    const replyText = extractReplyText(arrivalPickCalls[0]!.body.blocks);

    const expected = renderDeterministicReply({
      ref: ref("metamodule"),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL_TOMORROW,
      purchased: "built",
      variantText: rawText,
    });
    expect(replyText).toBe(expected);
  });
});

/* -------------------------------------------------------------------------
 * Picker clicks on a *modifier-only* follow-up (`@bot --discord`, issue
 * #27) — the cross-wave seam between #26 (buildFinishReplyPayload) and #27
 * (the reply_modifiers command kind). Neither branch could see this: a
 * modifier-only mention's raw text parses to `reply_modifiers`, which
 * buildFinishReplyPayload's drift guard rejected — so the operator clicked
 * a button and got silence, with only a log line to show for it.
 * ---------------------------------------------------------------------- */

describe("picker click on a modifier-only follow-up", () => {
  it("an arrival_pick click finishes the reply, using the thread's product and this turn's flag", async () => {
    const threadTs = nextSlackTs();

    // Turn 1 names the product and no date: the arrival picker, plus a
    // resolved_context remembering addac107.
    const first = await runReplyCycle({ eventId: nextEventId("modonly-arrival-1"), text: "ADDAC107", threadTs });
    expect(first.fetchCalls).toHaveLength(1);
    expect(JSON.stringify(first.fetchCalls[0]!.body.blocks)).toContain(ACTION_IDS.arrivalPick);

    // Turn 2 carries only a flag. It inherits the product, finds no
    // arrival date to inherit either, and posts a picker of its own.
    const second = await runReplyCycle({ eventId: nextEventId("modonly-arrival-2"), text: "--discord", threadTs });
    expect(second.fetchCalls).toHaveLength(1);
    expect(JSON.stringify(second.fetchCalls[0]!.body.blocks)).toContain(ACTION_IDS.arrivalPick);

    const { fetchCalls } = await clickButton({
      actionId: `${ACTION_IDS.arrivalPick}_0`,
      jobId: second.jobId,
      a: arrivalOptionArg("tomorrow"),
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://slack.com/api/chat.update");
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    const expected = renderDeterministicReply({
      ref: ref("addac107"),
      // `--discord` is turn 2's own flag; flags never accumulate, and
      // turn 1 carried none.
      flags: { direct: false, discord: true },
      arrivalSchedule: ARRIVAL_TOMORROW,
      purchased: "built",
      // The gating text is turn 1's, not "<@BOT> --discord". addac107 has
      // no variant-match block, so this pins the exact input rather than a
      // visible difference — tests/jobs/thread-inheritance.test.ts covers
      // the case where it changes what the customer reads.
      variantText: first.rawText,
    });
    expect(replyText).toBe(expected);
  });

  it("a variant_pick click resolves through the thread and reuses the inherited arrival date", async () => {
    const threadTs = nextSlackTs();

    const first = await runReplyCycle({
      eventId: nextEventId("modonly-variant-1"),
      text: "ai-lpg-diy-black 明日",
      threadTs,
    });
    expect(first.fetchCalls).toHaveLength(1);

    // An inherited general-diy product whose built/kit choice is NOT
    // decided. Reaching it honestly needs a `ref refresh` to widen a
    // product's category between two turns, so the state is written
    // directly here — the same technique tests/jobs/thread-inheritance.test.ts
    // uses for its degradation cases. What matters is the shape a later
    // turn reads, not how it came to be.
    await env.db
      .prepare("UPDATE jobs SET resolved_context = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          slug: "ai-lpg",
          variant: null,
          arrivalSchedule: ARRIVAL_TOMORROW,
          variantText: first.rawText,
        }),
        first.jobId,
      )
      .run();

    // Turn 2 inherits an undecided variant, so it asks rather than
    // guessing — and records nothing for itself, since asking is not
    // resolving. The click below therefore has to reach back to turn 1.
    const second = await runReplyCycle({ eventId: nextEventId("modonly-variant-2"), text: "--direct", threadTs });
    expect(second.fetchCalls).toHaveLength(1);
    expect(JSON.stringify(second.fetchCalls[0]!.body.blocks)).toContain(ACTION_IDS.variantPick);
    const secondContext = await env.db
      .prepare("SELECT resolved_context FROM jobs WHERE id = ?")
      .bind(second.jobId)
      .first<{ resolved_context: string | null }>();
    expect(secondContext?.resolved_context).toBeNull();

    const { fetchCalls } = await clickButton({
      actionId: `${ACTION_IDS.variantPick}_1`,
      jobId: second.jobId,
      a: "kit",
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://slack.com/api/chat.update");
    const replyText = extractReplyText(fetchCalls[0]!.body.blocks);
    const expected = renderDeterministicReply({
      ref: ref("ai-lpg"),
      flags: { direct: true, discord: false },
      // Not re-asked for: the thread already knew the date.
      arrivalSchedule: ARRIVAL_TOMORROW,
      purchased: "kit",
      variantText: first.rawText,
    });
    expect(replyText).toBe(expected);
  });
});

/* -------------------------------------------------------------------------
 * GET /health — issue #12's second acceptance criterion: a real D1
 * round-trip against the same seeded corpus, through the actual router.
 * ---------------------------------------------------------------------- */

describe("GET /health", () => {
  it("reports ok, the seeded ref count, and an array for migrations", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/health"),
      makeEnv(env.db),
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { ok: boolean; migrations: unknown; refCount: number };
    expect(json.ok).toBe(true);
    expect(json.refCount).toBe(34);
    expect(Array.isArray(json.migrations)).toBe(true);
  });
});
