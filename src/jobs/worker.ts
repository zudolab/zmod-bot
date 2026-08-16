/**
 * The delivery worker — one pass claims jobs (src/db/repos.ts
 * claimJobs), composes and posts each to Slack, and updates job state
 * (src/jobs/queue.ts). Invoked both from `ctx.waitUntil` right after ack
 * (src/index.ts fetch — an optimization) and from the cron sweep
 * (src/index.ts scheduled — the contract). See CLAUDE.md "durable intent
 * before the ack".
 *
 * **At-least-once, deliberately.** Slack's `chat.postMessage` and the D1
 * `state = 'done'` write are two systems with no transaction spanning
 * them: this design always posts to Slack *before* recording completion
 * (see deliverClaimedJob below). If the completion write then loses its
 * claim-token fence — because the lease expired mid-post and another
 * worker already reclaimed the row — the message has already gone out
 * and is not retracted. That is a visible duplicate, chosen deliberately
 * over the alternative (ack first, post second: a crash between the two
 * would be a customer reply that silently never sends). Do not "fix"
 * this into ack-then-post.
 *
 * **Composing seam.** `buildReplyJobPayload` below routes every `match`
 * through src/reply/compose.ts `composeReply` (issue #13's guarded LLM
 * path) rather than calling the deterministic renderer directly, and
 * always forwards the injected clock (`now`) plus `purchased`/
 * `variantText` — see composeMatchPayload. `composeReply` is injected
 * (see `ComposeReplyFn` / `RunJobDeps.composeReply`) the same way
 * `fetch`/`now`/`sleep` already are — every test here supplies a
 * deterministic fake rather than exercising the real LLM/Workers AI
 * call, per CLAUDE.md "Dependency injection at every I/O boundary".
 * composeReply itself never throws for a guard trip, a provider outage,
 * or a refusal (it falls back and reports `usedFallback: true` instead)
 * — a throw reaching this module is a genuine caller error (e.g. a
 * `general` reply with `arrivalSchedule: null`) and is left to fail
 * loudly through the normal recordFailure path below, never caught or
 * retried here.
 *
 * **Interactive follow-ups (issue #14).** A `general`/`general-diy`
 * match with no arrival date in the mention text, a `variant-ambiguous`
 * resolver result, and an `ambiguous` resolver result each post a
 * quick-pick message instead of the final reply (src/slack/commands.ts
 * buildArrivalPickerPayload / buildVariantPickerPayload /
 * buildCandidatePickerPayload) — the job still completes (`done`): its
 * job was to respond, and asking a question is a response. The click
 * that follows is handled entirely by src/slack/interactions.ts, using
 * the posted message's own `jobId` (carried in the button's value
 * envelope) to look this job back up and finish composing.
 */
import type { Env } from "../env";
import { claimJobs, updateJobState, type RepoDeps } from "../db/repos";
import { errorSnippet, log } from "../ops/log";
import type { JobRow, JobState } from "../db/schema";
import { resolveProductRef, type ResolveResult } from "../refs/resolve";
import { parseProductRefMarkdown } from "../refs/parse";
import type { ProductRef } from "../refs/model";
import {
  buildMissingRefBlocks,
  buildMessagePayload,
  buildReplyMessagePayload,
  escapeMrkdwn,
  type SlackMessagePayload,
} from "../slack/blocks";
import { postMessage, type SlackApiDeps } from "../slack/api";
import {
  buildArrivalPickerPayload,
  buildCandidatePickerPayload,
  buildVariantPickerPayload,
  computeArrivalPresetOptions,
  parseCommand,
  USAGE_TEXT,
  type ParsedCommand,
} from "../slack/commands";
import { composeReply as defaultComposeReply, type ComposeReplyDeps, type ComposeReplyInput, type ComposeReplyResult } from "../reply/compose";
import { formatArrivalSchedule } from "../reply/templates";
import type { FetchLike, NowFn, SleepFn } from "../types";
import {
  CLAIM_BATCH_SIZE,
  CLAIM_TTL_MS,
  DEFAULT_RETRY_POLICY,
  isValidTransition,
  nextStateAfterFailure,
} from "./queue";
import { runRetentionSweep } from "./retention";

/** The shape of src/reply/compose.ts's composeReply — injected so tests can fake issue #13's (currently throwing) real implementation. See the module comment. */
export type ComposeReplyFn = (deps: ComposeReplyDeps, input: ComposeReplyInput) => Promise<ComposeReplyResult>;

export interface RunDeliveryPassDeps {
  env: Env;
  fetch: FetchLike;
  now: NowFn;
  /** Injected so Slack retry backoff (see src/slack/api.ts) runs instantly in tests; defaults to a real timer. */
  sleep?: SleepFn;
  /** Injected compose step — defaults to the real src/reply/compose.ts composeReply. See ComposeReplyFn. */
  composeReply?: ComposeReplyFn;
}

export interface RunDeliveryPassResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

/**
 * The I/O deps a single job's compose+post needs — the subset of
 * RunDeliveryPassDeps that doesn't include `env` (passed separately,
 * since it also carries bindings like `DB`).
 */
export type RunJobDeps = { fetch: FetchLike; now: NowFn; sleep?: SleepFn; composeReply?: ComposeReplyFn };

/**
 * Strips a leading `<@BOT_ID>` mention, matching src/slack/events.ts
 * classifyJobKind's pattern — for display text only, never for alias
 * matching (see src/refs/resolve.ts normalizeAlias for that).
 */
const MENTION_PREFIX = /^<@[^>]*>\s*/;
function stripMention(text: string): string {
  return text.replace(MENTION_PREFIX, "").trim();
}

/** A plain mrkdwn `section` message — used for operational replies (help/usage/unknown-command) that are never the customer-facing reply body, so the rich_text_preformatted rule (CLAUDE.md) does not apply. */
function buildTextMessagePayload(text: string, summaryText: string): SlackMessagePayload {
  return buildMessagePayload(
    [{ type: "section", block_id: "bot_text", text: { type: "mrkdwn", text } }],
    summaryText,
  );
}

/**
 * Resolves a `match`'d product ref + parsed command into either a final
 * composed reply, or — when the category needs an arrival date and none
 * was supplied — the arrival-picker payload instead. Shared by
 * buildReplyJobPayload (the initial post) and
 * src/slack/interactions.ts (finishing after a variant/candidate click),
 * so both paths honor an arrival preset typed in the original mention
 * text the same way.
 *
 * `purchased` (built vs kit) and `rawText` (forwarded as
 * ComposeReplyInput.variantText, which gates `variant-match` literal
 * blocks — e.g. zudo-rail's Lite renewal notice) both go straight
 * through to composeReply; see src/reply/compose.ts ComposeReplyInput.
 */
export async function composeMatchPayload(
  env: Env,
  jobId: number,
  ref: ProductRef,
  purchased: "built" | "kit",
  rawText: string,
  parsed: Extract<ParsedCommand, { kind: "reply" }>,
  deps: RunJobDeps,
): Promise<SlackMessagePayload> {
  let arrivalSchedule: string | null = null;
  if (ref.category !== "small") {
    if (parsed.arrival !== null) {
      const option = computeArrivalPresetOptions(deps.now).find((candidate) => candidate.preset === parsed.arrival);
      if (option) {
        arrivalSchedule = formatArrivalSchedule({ dayLabel: option.dayLabel, month: option.month, day: option.day });
      }
    }
    if (arrivalSchedule === null) {
      return buildArrivalPickerPayload(jobId, deps.now);
    }
  }

  const compose = deps.composeReply ?? defaultComposeReply;
  const composed = await compose(
    // `now` forwarded so composeReply's UTC-day budget window agrees
    // with the rest of this job's clock (src/reply/compose.ts
    // ComposeReplyDeps.now) — never left to default to a real clock here.
    { env, fetch: deps.fetch, now: deps.now },
    { ref, arrivalSchedule, discord: parsed.discord, direct: parsed.direct, purchased, variantText: rawText },
  );
  return buildReplyMessagePayload({ replyText: composed.text, summaryText: `${ref.displayName} の返信` });
}

/**
 * Builds the Slack payload for a `reply` job from the resolver's result.
 * `miss` (epic issue #1 decision 7: "a mention that resolves to no
 * reference does not dead-end"), a `small`-category `match`, and a
 * `general`/`general-diy` `match` that already carries (or is given) an
 * arrival date all produce the final reply. Everything else — no arrival
 * date yet, `variant-ambiguous`, `ambiguous` — posts an interactive
 * quick-pick instead (see the module comment); src/slack/interactions.ts
 * finishes the job from there.
 */
async function buildReplyJobPayload(
  env: Env,
  job: JobRow,
  resolved: ResolveResult,
  deps: RunJobDeps,
): Promise<SlackMessagePayload> {
  if (resolved.kind === "miss") {
    return buildMessagePayload(
      buildMissingRefBlocks(stripMention(job.raw_text)),
      "製品リファレンスが見つかりませんでした。",
    );
  }

  const parsed = parseCommand(job.raw_text, env.SLACK_BOT_USER_ID);

  if (parsed.kind === "help") {
    return buildTextMessagePayload(USAGE_TEXT, "使い方");
  }
  if (parsed.kind === "unknown") {
    return buildTextMessagePayload(`${escapeMrkdwn(parsed.reason)}\n\n${USAGE_TEXT}`, "コマンドを解釈できませんでした。");
  }
  if (parsed.kind !== "reply") {
    // src/slack/events.ts classifyJobKind already routes a text starting
    // with "ref"/"polish" to job.kind "ref"/"polish" before this function
    // is ever reached (see composeAndPost's switch below) — a "reply"-kind
    // job whose own parseCommand disagrees means the two tokenizers have
    // drifted apart, which is a real bug, not a normal runtime state.
    throw new Error(
      `reply job ${job.id}: parseCommand returned "${parsed.kind}" for a job classified as "reply" ` +
        `— classifyJobKind/parseCommand drift`,
    );
  }

  if (resolved.kind === "variant-ambiguous") {
    const ref = parseProductRefMarkdown({ slug: resolved.slug, markdown: resolved.ref.body_md });
    return buildVariantPickerPayload(job.id, ref.displayName);
  }
  if (resolved.kind === "ambiguous") {
    return buildCandidatePickerPayload(
      job.id,
      resolved.candidates.map((candidate) => candidate.slug),
    );
  }

  // resolved.kind === "match"
  const ref = parseProductRefMarkdown({ slug: resolved.slug, markdown: resolved.ref.body_md });
  return composeMatchPayload(env, job.id, ref, resolved.variant ?? "built", job.raw_text, parsed, deps);
}

/**
 * Dispatches a claimed job on `job.kind` and produces the Slack payload
 * to post. Composing and posting are one step here deliberately — see
 * the module comment on the at-least-once tradeoff this implies (a crash
 * between "the text is composed" and "the D1 write says so" replays as a
 * second post attempt, never a silent loss).
 */
async function composeAndPost(env: Env, job: JobRow, deps: RunJobDeps): Promise<void> {
  let payload: SlackMessagePayload;
  switch (job.kind) {
    case "reply": {
      const repoDeps: RepoDeps = { db: env.DB, now: deps.now };
      const resolved = await resolveProductRef(repoDeps, job.raw_text);
      payload = await buildReplyJobPayload(env, job, resolved, deps);
      break;
    }
    case "polish":
    case "ref":
      // Neither has an implementation yet (issues #16 and #17). A job of
      // this kind can already exist in production today — src/slack/
      // events.ts classifyJobKind recognizes both keywords — so this is
      // a real, expected failure mode until those issues land, not a
      // bug: it fails, retries per the normal policy, then goes dead.
      throw new Error(`runJob: job kind "${job.kind}" is not implemented yet (see issues #16/#17)`);
  }

  const slackDeps: SlackApiDeps = {
    botToken: env.SLACK_BOT_TOKEN,
    fetch: deps.fetch,
    sleep: deps.sleep,
    // A cron/sweep-style caller can afford the extra latency a 5xx retry
    // costs — see src/slack/api.ts SlackApiDeps.retryServerErrors.
    retryServerErrors: true,
  };
  await postMessage(slackDeps, { channel: job.channel_id, threadTs: job.thread_ts, payload });
}

/**
 * The per-job unit of work: dispatches on `job.kind`, composes, and
 * posts to Slack. Exported per issue #10's stated shape
 * (`runJob(env, job, deps)`); does not touch job state itself — see
 * deliverClaimedJob, which owns every state transition around this call.
 */
export async function runJob(env: Env, job: JobRow, deps: RunJobDeps): Promise<void> {
  await composeAndPost(env, job, deps);
}

/**
 * Fenced state transition: validates the edge against
 * JOB_STATE_TRANSITIONS, writes it, and on a lost fence (lease expired
 * and reclaimed elsewhere) logs the rejection per issue #10 ("log the
 * fence rejection — it means the lease is too short for the real work")
 * rather than throwing, since by this point the caller no longer owns
 * the row and must not touch it further.
 */
async function transition(
  repoDeps: RepoDeps,
  job: JobRow,
  claimToken: string,
  to: JobState,
  extra: { lastError?: string | null; claimExpiresAt?: number; incrementAttempts?: boolean } = {},
): Promise<boolean> {
  if (!isValidTransition(job.state, to)) {
    throw new Error(`jobs: invalid state transition ${job.state} -> ${to} for job ${job.id}`);
  }
  const ok = await updateJobState(repoDeps, { id: job.id, claimToken, state: to, ...extra });
  if (ok) {
    job.state = to;
  } else {
    log("warn", "jobs: fence rejection — lease is too short for the real work", {
      jobId: job.id,
      from: job.state,
      to,
    });
  }
  return ok;
}

/**
 * Records a failed attempt: always parks in `failed` first (the only
 * edge `composing`/`delivering` have toward `dead`), then hops to `dead`
 * when the retry ceiling is reached — see src/jobs/queue.ts's module
 * comment on why `dead` is never reached directly.
 */
async function recordFailure(
  repoDeps: RepoDeps,
  job: JobRow,
  claimToken: string,
  error: unknown,
): Promise<void> {
  const message = errorSnippet(error);
  const nextAttempts = job.attempts + 1;
  const landing = nextStateAfterFailure(nextAttempts, DEFAULT_RETRY_POLICY);
  const claimExpiresAt =
    landing === "failed" ? repoDeps.now().getTime() + DEFAULT_RETRY_POLICY.backoffMs(nextAttempts) : undefined;

  const parked = await transition(repoDeps, job, claimToken, "failed", {
    lastError: message,
    incrementAttempts: true,
    claimExpiresAt,
  });
  if (!parked) return; // fence already logged by transition()

  if (landing === "dead") {
    await transition(repoDeps, job, claimToken, "dead", { lastError: message });
  }
}

/**
 * Runs one claimed job through its full lifecycle: requeue-if-retry,
 * composing, delivering, done — or `failed`/`dead` on any throw. Returns
 * true when the job is considered delivered (the Slack post completed,
 * even if the final `done` write then lost its fence — see the module
 * comment on the at-least-once tradeoff).
 */
async function deliverClaimedJob(
  env: Env,
  repoDeps: RepoDeps,
  job: JobRow,
  claimToken: string,
  deps: RunJobDeps,
): Promise<boolean> {
  // A reclaimed `failed` job has no failed -> composing edge (see
  // src/jobs/queue.ts) — replay the same first hop a fresh job takes.
  if (job.state === "failed") {
    const requeued = await transition(repoDeps, job, claimToken, "pending");
    if (!requeued) return false;
  }

  const toComposing = await transition(repoDeps, job, claimToken, "composing");
  if (!toComposing) return false;

  try {
    await runJob(env, job, deps);
  } catch (error) {
    await recordFailure(repoDeps, job, claimToken, error);
    return false;
  }

  // The Slack post above already succeeded — composing -> delivering ->
  // done is now a formality to satisfy the state graph (composing has no
  // direct edge to done), not a real observation window. A lost fence
  // from here on is logged by transition() and left alone: the message
  // already sent.
  const toDelivering = await transition(repoDeps, job, claimToken, "delivering");
  if (!toDelivering) return true;

  await transition(repoDeps, job, claimToken, "done");
  return true;
}

/**
 * One delivery pass: claims up to CLAIM_BATCH_SIZE jobs currently
 * `pending` or `failed` (see src/jobs/queue.ts for why `failed` is
 * claimable the same way `pending` is), then runs each through
 * deliverClaimedJob in turn. Called both from `ctx.waitUntil` right
 * after ack (an optimization) and from the cron sweep (the contract) —
 * see the module comment.
 */
export async function runDeliveryPass(deps: RunDeliveryPassDeps): Promise<RunDeliveryPassResult> {
  const repoDeps: RepoDeps = { db: deps.env.DB, now: deps.now };
  const claimToken = crypto.randomUUID();

  const claimed = await claimJobs(repoDeps, {
    states: ["pending", "failed"],
    limit: CLAIM_BATCH_SIZE,
    claimToken,
    claimTtlMs: CLAIM_TTL_MS,
  });

  let succeeded = 0;
  let failed = 0;
  for (const job of claimed) {
    const ok = await deliverClaimedJob(deps.env, repoDeps, job, claimToken, {
      fetch: deps.fetch,
      now: deps.now,
      sleep: deps.sleep,
      composeReply: deps.composeReply,
    });
    if (ok) succeeded++;
    else failed++;
  }

  return { claimed: claimed.length, succeeded, failed };
}

/**
 * The cron entry point (src/index.ts scheduled()): sweep the job queue,
 * then run retention. Each phase is caught and logged independently so
 * one failing never blocks the other, and this function itself never
 * rejects — it is always called from `ctx.waitUntil`, and an unhandled
 * rejection there is silent (see src/slack/events.ts's identical
 * catch-and-log pattern for the ack-path optimization call).
 */
export async function runScheduledSweep(deps: RunDeliveryPassDeps): Promise<void> {
  try {
    const result = await runDeliveryPass(deps);
    log("info", "jobs: delivery pass complete", { ...result });
  } catch (error) {
    log("error", "jobs: delivery pass failed during scheduled sweep", { error: errorSnippet(error) });
  }

  try {
    const result = await runRetentionSweep({ db: deps.env.DB, now: deps.now });
    log("info", "jobs: retention sweep complete", { ...result });
  } catch (error) {
    log("error", "jobs: retention sweep failed during scheduled sweep", { error: errorSnippet(error) });
  }
}
