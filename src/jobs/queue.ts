/**
 * The job state machine — `pending -> composing -> delivering -> done |
 * failed | dead`, per epic issue #1's "Durable job semantics". Retry/
 * backoff policy and the actual delivery pass live in
 * src/jobs/worker.ts. Implementation is issue #10's responsibility.
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
  throw new Error("not implemented: isValidTransition");
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
}

/** Decides whether a failed job's next state is `pending` (retry) or `dead` (attempts exhausted). */
export function nextStateAfterFailure(attempts: number, policy: RetryPolicy): JobState {
  throw new Error("not implemented: nextStateAfterFailure");
}
