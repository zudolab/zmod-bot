/**
 * Retention sweep — run from the cron `scheduled()` handler alongside the
 * delivery pass (src/jobs/worker.ts runScheduledSweep), per issue #10:
 * delete `slack_event_receipts` older than 24h (Slack's retry window
 * tops out around 5 minutes, so this is enormous margin), `jobs` in
 * `done` older than 7 days, `ref_drafts` past `expires_at`, and
 * `usage_log` older than 90 days.
 *
 * `dead` jobs are deliberately NOT deleted here — issue #10 only calls
 * out `done`, and a dead job's `last_error` is exactly the thing an
 * operator needs to investigate; auto-deleting it would erase the trail.
 *
 * Every delete is bounded (issue #10: "Bound every delete") via the same
 * `DELETE ... WHERE id IN (SELECT ... LIMIT ?)` shape src/db/repos.ts's
 * claimJobs already uses for bounding a SELECT-then-UPDATE — plain
 * `DELETE ... LIMIT` is not portable D1/SQLite syntax.
 */
import type { NowFn } from "../types";

export interface RunRetentionSweepDeps {
  db: D1Database;
  now: NowFn;
}

export interface RetentionSweepResult {
  slackEventReceiptsDeleted: number;
  jobsDeleted: number;
  refDraftsDeleted: number;
  usageLogDeleted: number;
}

/**
 * Caps a single sweep tick's deletes per table — large enough to drain a
 * normal backlog in one 5-minute tick, small enough to keep each
 * statement cheap.
 */
const RETENTION_BATCH_SIZE = 500;

const SLACK_EVENT_RECEIPTS_MAX_AGE_MS = 24 * 60 * 60_000;
const DONE_JOBS_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const USAGE_LOG_MAX_AGE_MS = 90 * 24 * 60 * 60_000;

async function boundedDelete(db: D1Database, sql: string, bindings: unknown[]): Promise<number> {
  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .run();
  return result.meta.changes;
}

export async function runRetentionSweep(deps: RunRetentionSweepDeps): Promise<RetentionSweepResult> {
  const nowMs = deps.now().getTime();

  const slackEventReceiptsDeleted = await boundedDelete(
    deps.db,
    `DELETE FROM slack_event_receipts WHERE event_id IN (
       SELECT event_id FROM slack_event_receipts WHERE received_at < ? ORDER BY received_at LIMIT ?
     )`,
    [nowMs - SLACK_EVENT_RECEIPTS_MAX_AGE_MS, RETENTION_BATCH_SIZE],
  );

  const jobsDeleted = await boundedDelete(
    deps.db,
    `DELETE FROM jobs WHERE id IN (
       SELECT id FROM jobs WHERE state = 'done' AND completed_at < ? ORDER BY id LIMIT ?
     )`,
    [nowMs - DONE_JOBS_MAX_AGE_MS, RETENTION_BATCH_SIZE],
  );

  const refDraftsDeleted = await boundedDelete(
    deps.db,
    `DELETE FROM ref_drafts WHERE id IN (
       SELECT id FROM ref_drafts WHERE expires_at < ? ORDER BY expires_at LIMIT ?
     )`,
    [nowMs, RETENTION_BATCH_SIZE],
  );

  const usageLogDeleted = await boundedDelete(
    deps.db,
    `DELETE FROM usage_log WHERE id IN (
       SELECT id FROM usage_log WHERE created_at < ? ORDER BY id LIMIT ?
     )`,
    [nowMs - USAGE_LOG_MAX_AGE_MS, RETENTION_BATCH_SIZE],
  );

  return { slackEventReceiptsDeleted, jobsDeleted, refDraftsDeleted, usageLogDeleted };
}
