/**
 * The job state machine — `pending -> composing -> delivering -> done |
 * failed | dead`, per epic issue #1's "Durable job semantics". Retry/
 * backoff policy and the actual delivery pass live in
 * src/jobs/worker.ts. Implementation is issue #10's responsibility.
 *
 * `failed` is not a dead end and not a synonym for `pending`: a job that
 * failed re-enters the claimable pool the same way a fresh job does (see
 * src/db/repos.ts claimJobs, which is called with
 * `states: ["pending", "failed"]`) — `claim_expires_at` pushed forward
 * by the backoff below is what keeps it unclaimable until the backoff
 * window elapses, the same expiry mechanism that frees an abandoned
 * lease. There is no separate "release" or "retry" write. Once reclaimed,
 * a `failed` job is moved back to `pending` before doing any work (see
 * src/jobs/worker.ts) — `failed -> composing` is not a legal edge below,
 * only `failed -> pending | dead` is, so a retry replays the same first
 * hop a fresh job takes.
 */
import type { JobState } from "../db/schema";

export const JOB_STATE_TRANSITIONS: Record<JobState, JobState[]> = {
  pending: ["composing", "failed"],
  composing: ["delivering", "failed"],
  delivering: ["done", "failed"],
  done: [],
  failed: ["pending", "dead"],
  dead: [],
};

export function isValidTransition(from: JobState, to: JobState): boolean {
  return JOB_STATE_TRANSITIONS[from].includes(to);
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
}

/**
 * Issue #10's retry ceiling: 5 attempts, then dead. Backoff doubles per
 * attempt starting at 60s, capped at 30min — `attempt` is the count
 * *after* the failure being recorded (the first failure is attempt 1).
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  backoffMs: (attempt) => Math.min(60_000 * 2 ** attempt, 30 * 60_000),
};

/**
 * The claim lease: how long a delivery pass has to finish a batch before
 * an abandoned row becomes reclaimable (see CLAUDE.md "Expiry, not
 * release, is what frees a row").
 */
export const CLAIM_TTL_MS = 10 * 60_000;

/** Issue #10: "Batch size: 10 per sweep tick." */
export const CLAIM_BATCH_SIZE = 10;

/**
 * Decides whether a failed attempt's landing state is `failed` (retry
 * later — see the module comment on why that's `failed`, not `pending`)
 * or `dead` (attempts exhausted). `attempts` is the count *after* this
 * failure.
 */
export function nextStateAfterFailure(attempts: number, policy: RetryPolicy): JobState {
  return attempts >= policy.maxAttempts ? "dead" : "failed";
}
