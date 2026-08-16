/**
 * The delivery worker — one pass claims jobs (src/db/repos.ts
 * claimJobs), composes and posts each to Slack, and updates job state
 * (src/jobs/queue.ts). Invoked both from `ctx.waitUntil` right after ack
 * (src/index.ts fetch — an optimization) and from the cron sweep
 * (src/index.ts scheduled — the contract). See CLAUDE.md "durable intent
 * before the ack". Implementation is issue #10's responsibility.
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
 * **Composing seam.** Issue #13 replaces the compose step with the
 * guarded LLM path (src/reply/compose.ts composeReply). Until then,
 * buildReplyJobPayload below wires straight to the deterministic
 * renderer (src/reply/render.ts) so the whole claim -> compose -> post
 * -> done path is exercisable end to end, per issue #10's brief. Two
 * inputs that path doesn't have a real source for yet are deliberately
 * NOT invented here (fabricating them risks needing to be undone by the
 * issue that actually owns them):
 *   - `ReplyFlags` (--discord/--direct): src/slack/commands.ts
 *     parseCommand is issue #14's responsibility and doesn't exist yet;
 *     flags default to false here.
 *   - the arrival-date sentence for non-`small` categories: nothing in
 *     this codebase computes it (see src/slack/blocks.ts
 *     buildArrivalDateBlocks — an interactive quick-pick, issue #14) —
 *     a `general`/`general-diy` reply job fails loudly instead of
 *     guessing a delivery date, which would risk shipping a wrong one to
 *     a paying customer. This surfaces as a normal job failure (retried,
 *     then dead) until #14 lands.
 */
import type { Env } from "../env";
import { claimJobs, updateJobState, type RepoDeps } from "../db/repos";
import { errorSnippet, log } from "../ops/log";
import type { JobRow, JobState } from "../db/schema";
import { resolveProductRef, type ResolveResult } from "../refs/resolve";
import { parseProductRefMarkdown } from "../refs/parse";
import {
  buildMissingRefBlocks,
  buildMessagePayload,
  buildReplyMessagePayload,
  type SlackMessagePayload,
} from "../slack/blocks";
import { postMessage, type SlackApiDeps } from "../slack/api";
import { renderDeterministicReply } from "../reply/render";
import type { ReplyFlags } from "../reply/templates";
import type { FetchLike, NowFn, SleepFn } from "../types";
import {
  CLAIM_BATCH_SIZE,
  CLAIM_TTL_MS,
  DEFAULT_RETRY_POLICY,
  isValidTransition,
  nextStateAfterFailure,
} from "./queue";
import { runRetentionSweep } from "./retention";

export interface RunDeliveryPassDeps {
  env: Env;
  fetch: FetchLike;
  now: NowFn;
  /** Injected so Slack retry backoff (see src/slack/api.ts) runs instantly in tests; defaults to a real timer. */
  sleep?: SleepFn;
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
type RunJobDeps = { fetch: FetchLike; now: NowFn; sleep?: SleepFn };


/**
 * Strips a leading `<@BOT_ID>` mention, matching src/slack/events.ts
 * classifyJobKind's pattern — for display text only, never for alias
 * matching (see src/refs/resolve.ts normalizeAlias for that).
 */
const MENTION_PREFIX = /^<@[^>]*>\s*/;
function stripMention(text: string): string {
  return text.replace(MENTION_PREFIX, "").trim();
}

/**
 * Builds the Slack payload for a `reply` job from the resolver's result.
 * Only a `small`-category `match` and a `miss` (epic issue #1 decision
 * 7: "a mention that resolves to no reference does not dead-end") are
 * fully composable today — everything else throws a descriptive error;
 * see the module comment on why those gaps are not filled in here.
 */
function buildReplyJobPayload(resolved: ResolveResult, rawText: string): SlackMessagePayload {
  if (resolved.kind === "miss") {
    return buildMessagePayload(
      buildMissingRefBlocks(stripMention(rawText)),
      "製品リファレンスが見つかりませんでした。",
    );
  }

  if (resolved.kind === "match") {
    const ref = parseProductRefMarkdown({ slug: resolved.slug, markdown: resolved.ref.body_md });
    if (ref.category !== "small") {
      throw new Error(
        `reply job: "${resolved.slug}" (category "${ref.category}") needs an ` +
          `arrival-date sentence, which has no source yet (pending issue #14's ` +
          `interactive picker) — see src/jobs/worker.ts module comment`,
      );
    }
    // TODO(#14): parseCommand supplies real --discord/--direct flags.
    const flags: ReplyFlags = { direct: false, discord: false };
    const text = renderDeterministicReply({
      ref,
      flags,
      arrivalSchedule: null,
      purchased: resolved.variant ?? "built",
    });
    return buildReplyMessagePayload({ replyText: text, summaryText: `${ref.displayName} の返信` });
  }

  // "variant-ambiguous" / "ambiguous": needs an interactive follow-up
  // (issue #14/#15) this pass cannot provide. Failing loudly here (rather
  // than guessing built/kit or a candidate) is the same "never guess"
  // rule src/refs/resolve.ts documents for the resolver itself.
  throw new Error(
    `reply job: resolver returned "${resolved.kind}" — needs an interactive ` +
      `follow-up (pending issue #14/#15)`,
  );
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
      payload = buildReplyJobPayload(resolved, job.raw_text);
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
