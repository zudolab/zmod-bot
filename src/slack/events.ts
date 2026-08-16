/**
 * `POST /slack/events` — Slack Events API ingress: URL verification
 * challenge, signature check (src/slack/verify.ts), channel allow-list,
 * de-dup + durable job intake (src/db/repos.ts recordIncomingEvent).
 *
 * Every ignored event still returns 200 — see CLAUDE.md non-negotiable:
 * a non-2xx for an event this bot doesn't want spends one of Slack's
 * three retries to reach the identical conclusion.
 *
 * Implementation is issue #6's responsibility.
 */
import type { Env } from "../env";
import { parseCommaSeparated } from "../env";
import type { RouteContext } from "../router";
import type { FetchLike, NowFn, SleepFn, WaitUntilFn } from "../types";
import { verifySlackSignature } from "./verify";
import { recordIncomingEvent } from "../db/repos";
import type { JobKind } from "../db/schema";
import { runDeliveryPass } from "../jobs/worker";

/** The subset of Slack's app_mention event payload this bot reads. */
export interface SlackAppMentionEvent {
  type: "app_mention";
  event_ts: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

/** True when `channelId` is in SLACK_ALLOWED_CHANNEL_IDS (see src/env.ts parseCommaSeparated). Empty list means allow all — see wrangler.jsonc's SLACK_ALLOWED_CHANNEL_IDS comment. */
export function isAllowedChannel(env: Env, channelId: string): boolean {
  const allowed = parseCommaSeparated(env.SLACK_ALLOWED_CHANNEL_IDS);
  if (allowed.length === 0) return true;
  return allowed.includes(channelId);
}

/** Classifies the job `kind` from an app_mention's text: the first word after the leading `<@BOT_ID>` mention, case-insensitive. Everything other than `polish`/`ref` is a `reply`. */
export function classifyJobKind(text: string): JobKind {
  const withoutMention = text.replace(/^<@[^>]*>\s*/, "");
  const commandWord = withoutMention.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (commandWord === "polish") return "polish";
  if (commandWord === "ref") return "ref";
  return "reply";
}

// The durable-intent write (receipt + job, one db.batch()) must not hang
// the 3s Slack ack budget. If D1 hasn't answered by this point, treat it
// as a failure and let Slack retry — see CLAUDE.md "durable intent
// before the ack".
const DB_BATCH_BUDGET_MS = 2_000;

function ack(): Response {
  return new Response(null, { status: 200 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Races `promise` against `budgetMs`; rejects if the budget elapses first. `sleep` is injected so tests can force the timeout branch without a real wait. */
function withBudget<T>(promise: Promise<T>, budgetMs: number, sleep: SleepFn): Promise<T> {
  return Promise.race([
    promise,
    sleep(budgetMs).then((): T => {
      throw new Error(`slack events: db.batch() exceeded its ${budgetMs}ms budget`);
    }),
  ]);
}

export interface SlackEventsDeps {
  db: D1Database;
  now: NowFn;
  /** Injected background-work scheduler — see CLAUDE.md "Conventions": always ctx.waitUntil from the boundary, never reached from inside handler logic, so this stays testable without a Workers runtime. */
  waitUntil: WaitUntilFn;
  fetch: FetchLike;
  /** Injected so the 2s durable-write budget is testable without a real wait; defaults to a real timer. */
  sleep?: SleepFn;
}

export async function handleSlackEvents(context: RouteContext): Promise<Response> {
  return handleSlackEventsWithDeps(context.request, context.env, {
    db: context.env.DB,
    now: () => new Date(),
    waitUntil: (promise) => context.ctx.waitUntil(promise),
    fetch,
  });
}

/**
 * The testable core of the events handler — every I/O boundary (D1,
 * clock, background scheduler, fetch) is an injected option rather than
 * read from a Workers runtime, per CLAUDE.md "Dependency injection at
 * every I/O boundary".
 */
export async function handleSlackEventsWithDeps(
  request: Request,
  env: Env,
  deps: SlackEventsDeps,
): Promise<Response> {
  const sleep = deps.sleep ?? defaultSleep;

  // Read the raw body exactly once as text and verify before any
  // JSON.parse — verifying a re-serialized body is the classic way this
  // check silently always fails, or worse, always passes.
  const rawBody = await request.text();

  let signatureValid: boolean;
  try {
    signatureValid = await verifySlackSignature({
      signingSecret: env.SLACK_SIGNING_SECRET,
      timestamp: request.headers.get("X-Slack-Request-Timestamp") ?? "",
      signature: request.headers.get("X-Slack-Signature") ?? "",
      body: rawBody,
      now: deps.now,
    });
  } catch {
    // A missing/empty signing secret is a deployment error, distinct
    // from a bad signature — see src/slack/verify.ts.
    return new Response("server misconfigured", { status: 500 });
  }
  if (!signatureValid) return new Response("invalid signature", { status: 401 });

  // url_verification is answered only after the signature above passed.
  // Answering first would turn this public endpoint into an
  // unauthenticated echo oracle.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (!isRecord(payload)) return new Response("invalid payload", { status: 400 });

  if (payload.type === "url_verification") {
    return typeof payload.challenge === "string"
      ? Response.json({ challenge: payload.challenge })
      : new Response("invalid url_verification payload", { status: 400 });
  }

  // Every authenticated event this bot deliberately ignores from here on
  // still returns 200 — see CLAUDE.md non-negotiable.
  if (payload.type !== "event_callback") return ack();
  if (typeof payload.event_id !== "string" || payload.event_id.trim() === "") return ack();

  const event = payload.event;
  if (!isRecord(event) || event.type !== "app_mention") return ack();
  if (typeof event.subtype === "string" && event.subtype !== "") return ack();
  if (typeof event.bot_id === "string" && event.bot_id !== "") return ack();
  if (
    typeof event.user !== "string" ||
    typeof event.text !== "string" ||
    typeof event.ts !== "string" ||
    typeof event.channel !== "string"
  ) {
    return ack();
  }
  if (event.user === env.SLACK_BOT_USER_ID) return ack();
  if (!isAllowedChannel(env, event.channel)) return ack();

  const kind = classifyJobKind(event.text);
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : event.ts;

  let job;
  try {
    job = await withBudget(
      recordIncomingEvent(
        { db: deps.db, now: deps.now },
        {
          eventId: payload.event_id,
          eventType: event.type,
          kind,
          channelId: event.channel,
          threadTs,
          actorUserId: event.user,
          rawText: event.text,
        },
      ),
      DB_BATCH_BUDGET_MS,
      sleep,
    );
  } catch {
    // Either db.batch() threw, or it lost the race against the budget
    // above. A 200 here would tell Slack the event is handled while
    // nothing recorded that it must happen — the event would be lost
    // silently. Both inserts are idempotent, so a retry is always safe.
    return new Response("temporarily unavailable", { status: 500 });
  }

  if (job) {
    // Immediate delivery is an optimization on top of the durable write
    // above (the cron sweep is the contract, see CLAUDE.md) — a failure
    // here must never surface as an unhandled rejection inside
    // waitUntil, so it's caught and logged rather than left to reject.
    deps.waitUntil(
      runDeliveryPass({ env, fetch: deps.fetch, now: deps.now }).then(
        () => undefined,
        (error: unknown) => {
          console.error("[slack/events] immediate delivery pass failed; cron sweep will retry.", error);
        },
      ),
    );
  }

  return ack();
}
