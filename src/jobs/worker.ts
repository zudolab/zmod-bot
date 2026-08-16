/**
 * The delivery worker — one pass claims jobs (src/db/repos.ts
 * claimJobs), composes and posts each to Slack, and updates job state
 * (src/jobs/queue.ts). Invoked both from `ctx.waitUntil` right after ack
 * (src/index.ts fetch — an optimization) and from the cron sweep
 * (src/index.ts scheduled — the contract). See CLAUDE.md "durable intent
 * before the ack". Implementation is issue #10's responsibility.
 */
import type { Env } from "../env";
import type { FetchLike, NowFn } from "../types";

export interface RunDeliveryPassDeps {
  env: Env;
  fetch: FetchLike;
  now: NowFn;
}

export interface RunDeliveryPassResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

export async function runDeliveryPass(deps: RunDeliveryPassDeps): Promise<RunDeliveryPassResult> {
  throw new Error("not implemented: runDeliveryPass");
}
