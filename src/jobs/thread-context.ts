/**
 * The thread-memory lookup behind `@bot --discord` (epic #22 thread
 * continuity, issue #27) — "which product, variant, arrival date and
 * variant-gating text does this mention inherit from its thread?".
 *
 * Shared by the two paths that both need the answer and must agree on it:
 * src/jobs/worker.ts (delivering a modifier-only mention) and
 * src/slack/interactions.ts (a picker click on a message such a mention
 * posted). Kept in its own module so the degradation rules below cannot
 * drift apart between them — a click that resolved a *different* product
 * than the message it is replacing would be the worst kind of silent bug
 * here, since the operator pastes the result to a customer.
 */
import { findLatestResolvedThreadJob, parseResolvedJobContext, type RepoDeps } from "../db/repos";
import type { JobRow, ResolvedJobContext } from "../db/schema";

export interface InheritedThreadContext {
  context: ResolvedJobContext;
  /**
   * The text that gates `variant-match` literal blocks
   * (src/reply/render.ts includesLiteralBlock) — see
   * {@link ResolvedJobContext.variantText}. Never null: a blob written
   * before that field existed degrades to the source job's own
   * `raw_text`, which is exactly what this path used before the field
   * was added.
   */
  variantText: string;
}

/** Pairs a parsed context with the job it was read off, applying the pre-`variantText` fallback in one place. */
function inheritedFrom(job: JobRow, context: ResolvedJobContext): InheritedThreadContext {
  return { context, variantText: context.variantText ?? job.raw_text };
}

/**
 * What a `reply_modifiers` mention inherits from its thread: the most
 * recent prior `reply` job in the same `(channel_id, thread_ts)` that
 * recorded a resolved product.
 *
 * Returns null — meaning "no memory, degrade to today's behaviour" — for
 * every miss: no prior job at all (a first mention, a top-level mention,
 * a different thread or channel, or a thread whose jobs aged out of the
 * 7-day `done` retention, see src/jobs/retention.ts), and a prior job
 * whose stored blob is malformed (parseResolvedJobContext returns null
 * rather than throwing, by design).
 *
 * `findLatestResolvedThreadJob` supplies the isolation guarantees this
 * path depends on: it filters on channel *and* thread, excludes the
 * calling job and everything after it (so a job never inherits from
 * itself), and restricts to `kind = 'reply'` (so a `polish`/`ref` job in
 * the thread is never mistaken for reply context).
 */
export async function findInheritableThreadContext(
  deps: RepoDeps,
  job: JobRow,
): Promise<InheritedThreadContext | null> {
  const prior = await findLatestResolvedThreadJob(deps, {
    channelId: job.channel_id,
    threadTs: job.thread_ts,
    beforeJobId: job.id,
  });
  if (prior === null) return null;
  const context = parseResolvedJobContext(prior.resolved_context);
  if (context === null) return null;
  return inheritedFrom(prior, context);
}

/**
 * The click path's variant of the above: what a *button click* on a
 * modifier-only mention's message should resolve to.
 *
 * The job's own `resolved_context` is preferred and is the normal case —
 * src/jobs/worker.ts records it before short-circuiting into the arrival
 * picker precisely so a later click can read it back. It falls through to
 * the thread lookup for the one case that record does not cover: an
 * inherited `general-diy` product whose built/kit choice was never
 * decided, which posts the variant picker *before* anything is recorded
 * for this job (asking is not resolving).
 */
export async function findClickTimeThreadContext(
  deps: RepoDeps,
  job: JobRow,
): Promise<InheritedThreadContext | null> {
  const own = parseResolvedJobContext(job.resolved_context);
  if (own !== null) return inheritedFrom(job, own);
  return findInheritableThreadContext(deps, job);
}
