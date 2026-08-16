/**
 * D1 repositories. Every function takes its D1Database and clock as
 * injected options (CLAUDE.md "Dependency injection at every I/O
 * boundary") so it can be exercised against either test-tier: the
 * Map-backed `createMockD1` (src/db/test-support.ts) for handler
 * branching, or the Miniflare-backed `createTestEnv`
 * (tests/helpers/test-env.ts) for storage-semantics assertions.
 *
 * Every conditional write reads `result.meta.changes` rather than a
 * separate `SELECT changes()` — `success: true` with `changes: 0` is how
 * a lost race presents in D1, and it is not an error (CLAUDE.md
 * "Conventions").
 */
import type { NowFn } from "../types";
import {
  TABLE_NAMES,
  type JobKind,
  type JobRow,
  type JobState,
  type ProductCategory,
  type ProductRefRow,
  type ProductRefVersionRow,
  type ProductRefVersionSource,
  type RefDraftRow,
  type UsageTask,
} from "./schema";

export interface RepoDeps {
  db: D1Database;
  now: NowFn;
}

// ---------------------------------------------------------------------
// product_refs / product_ref_aliases / product_ref_versions
// ---------------------------------------------------------------------

export async function getProductRefBySlug(deps: RepoDeps, slug: string): Promise<ProductRefRow | null> {
  const row = await deps.db
    .prepare(`SELECT * FROM ${TABLE_NAMES.productRefs} WHERE slug = ?`)
    .bind(slug)
    .first<ProductRefRow>();
  return row ?? null;
}

export async function listProductRefs(deps: RepoDeps): Promise<ProductRefRow[]> {
  const result = await deps.db
    .prepare(`SELECT * FROM ${TABLE_NAMES.productRefs} ORDER BY slug`)
    .all<ProductRefRow>();
  return result.results;
}

/** Every normalized alias registered for `slug` (see the resolver, issue #8), alphabetical. */
export async function listProductRefAliases(deps: RepoDeps, slug: string): Promise<string[]> {
  const result = await deps.db
    .prepare(`SELECT alias_norm FROM ${TABLE_NAMES.productRefAliases} WHERE slug = ? ORDER BY alias_norm`)
    .bind(slug)
    .all<{ alias_norm: string }>();
  return result.results.map((row) => row.alias_norm);
}

/** Resolves an already-normalized alias (see the resolver, issue #8) to its product ref, or null if unknown. */
export async function findProductRefByAlias(deps: RepoDeps, aliasNorm: string): Promise<ProductRefRow | null> {
  const row = await deps.db
    .prepare(
      `SELECT p.* FROM ${TABLE_NAMES.productRefs} p
       JOIN ${TABLE_NAMES.productRefAliases} a ON a.slug = p.slug
       WHERE a.alias_norm = ?`,
    )
    .bind(aliasNorm)
    .first<ProductRefRow>();
  return row ?? null;
}

export interface UpsertProductRefInput {
  slug: string;
  category: ProductCategory;
  productUrl: string | null;
  bodyMd: string;
  /**
   * Replaces the full alias set for this slug. Omit to leave existing
   * aliases untouched — a restore reverts body/category/url only, never
   * the alias set (see restoreProductRefVersion below).
   */
  aliases?: string[];
  changedByUserId: string;
  source: ProductRefVersionSource;
}

/**
 * Inserts or updates the product_refs row and appends a
 * product_ref_versions row in one db.batch(), incrementing `version`.
 *
 * The version bump reads the current row first, then binds the computed
 * next version into the batch — so this is last-writer-wins under two
 * true-concurrent edits to the same slug. That is an accepted scope
 * boundary here: writes to product refs are admin-gated (epic issue #1
 * point 8), and the stricter expected-version check for the authoring
 * flow lives on ref_drafts.base_version (issue #17), not this primitive.
 */
export async function upsertProductRef(deps: RepoDeps, input: UpsertProductRefInput): Promise<ProductRefRow> {
  const { db, now } = deps;
  const nowMs = now().getTime();
  const existing = await getProductRefBySlug(deps, input.slug);
  const nextVersion = (existing?.version ?? 0) + 1;

  const statements = [
    db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.productRefs} (slug, category, product_url, body_md, version, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           category = excluded.category,
           product_url = excluded.product_url,
           body_md = excluded.body_md,
           version = excluded.version,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .bind(input.slug, input.category, input.productUrl, input.bodyMd, nextVersion, nowMs, input.changedByUserId),
    db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.productRefVersions}
           (slug, version, body_md, category, product_url, created_at, created_by, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.slug,
        nextVersion,
        input.bodyMd,
        input.category,
        input.productUrl,
        nowMs,
        input.changedByUserId,
        input.source,
      ),
  ];

  if (input.aliases !== undefined) {
    statements.push(
      db.prepare(`DELETE FROM ${TABLE_NAMES.productRefAliases} WHERE slug = ?`).bind(input.slug),
      ...input.aliases.map((aliasNorm) =>
        db
          .prepare(`INSERT INTO ${TABLE_NAMES.productRefAliases} (alias_norm, slug) VALUES (?, ?)`)
          .bind(aliasNorm, input.slug),
      ),
    );
  }

  await db.batch(statements);

  return {
    slug: input.slug,
    category: input.category,
    product_url: input.productUrl,
    body_md: input.bodyMd,
    version: nextVersion,
    updated_at: nowMs,
    updated_by: input.changedByUserId,
  };
}

export async function listProductRefVersions(deps: RepoDeps, slug: string): Promise<ProductRefVersionRow[]> {
  const result = await deps.db
    .prepare(`SELECT * FROM ${TABLE_NAMES.productRefVersions} WHERE slug = ? ORDER BY version DESC`)
    .bind(slug)
    .all<ProductRefVersionRow>();
  return result.results;
}

export async function getProductRefVersion(
  deps: RepoDeps,
  slug: string,
  version: number,
): Promise<ProductRefVersionRow | null> {
  const row = await deps.db
    .prepare(`SELECT * FROM ${TABLE_NAMES.productRefVersions} WHERE slug = ? AND version = ?`)
    .bind(slug, version)
    .first<ProductRefVersionRow>();
  return row ?? null;
}

/** Restores `slug` to a prior `version`, recorded as a new version entry (never rewrites history in place). Aliases are untouched. */
export async function restoreProductRefVersion(
  deps: RepoDeps,
  slug: string,
  version: number,
  actorUserId: string,
): Promise<ProductRefRow> {
  const versionRow = await getProductRefVersion(deps, slug, version);
  if (!versionRow) {
    throw new Error(`not found: ${TABLE_NAMES.productRefVersions} row for ${slug}@${version}`);
  }
  return upsertProductRef(deps, {
    slug,
    category: versionRow.category,
    productUrl: versionRow.product_url,
    bodyMd: versionRow.body_md,
    changedByUserId: actorUserId,
    source: "restored",
  });
}

// ---------------------------------------------------------------------
// ref_drafts
// ---------------------------------------------------------------------

export interface CreateRefDraftInput {
  slug: string;
  category: ProductCategory;
  productUrl: string | null;
  bodyMd: string;
  /** NULL for a brand-new ref; else the version this draft was edited against. */
  baseVersion: number | null;
  createdByUserId: string;
  /** Epoch milliseconds this draft stops being consumable. */
  expiresAt: number;
}

export async function createRefDraft(deps: RepoDeps, input: CreateRefDraftInput): Promise<RefDraftRow> {
  const id = crypto.randomUUID();
  const nowMs = deps.now().getTime();

  await deps.db
    .prepare(
      `INSERT INTO ${TABLE_NAMES.refDrafts}
         (id, slug, body_md, category, product_url, base_version, created_at, created_by, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      id,
      input.slug,
      input.bodyMd,
      input.category,
      input.productUrl,
      input.baseVersion,
      nowMs,
      input.createdByUserId,
      input.expiresAt,
    )
    .run();

  return {
    id,
    slug: input.slug,
    body_md: input.bodyMd,
    category: input.category,
    product_url: input.productUrl,
    base_version: input.baseVersion,
    created_at: nowMs,
    created_by: input.createdByUserId,
    expires_at: input.expiresAt,
    consumed_at: null,
  };
}

/**
 * Marks a draft consumed and returns its row, or null if it was already
 * consumed, has expired, or does not exist — a lost race against a
 * concurrent approval, not an error. Read via id first only to shape the
 * return value; the conditional UPDATE below is what actually decides
 * the outcome (CLAUDE.md "Read result.meta.changes on every conditional
 * write").
 */
export async function consumeRefDraft(deps: RepoDeps, id: string): Promise<RefDraftRow | null> {
  const draft = await deps.db
    .prepare(`SELECT * FROM ${TABLE_NAMES.refDrafts} WHERE id = ?`)
    .bind(id)
    .first<RefDraftRow>();
  if (!draft) return null;

  const nowMs = deps.now().getTime();
  const result = await deps.db
    .prepare(
      `UPDATE ${TABLE_NAMES.refDrafts} SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(nowMs, id, nowMs)
    .run();

  if (result.meta.changes === 0) return null;

  return { ...draft, consumed_at: nowMs };
}

// ---------------------------------------------------------------------
// slack_event_receipts + jobs (durable intake, delivery)
// ---------------------------------------------------------------------

export interface RecordIncomingEventInput {
  eventId: string;
  eventType: string;
  kind: JobKind;
  channelId: string;
  threadTs: string;
  actorUserId: string;
  rawText: string;
}

/**
 * Writes the slack_event_receipts row and the jobs row in one
 * db.batch(), per epic issue #1's durable-intent-before-the-ack
 * contract — CLAUDE.md: "Write the receipt + job row in one db.batch()
 * and then return 200." Both statements are keyed off the same UNIQUE
 * event_id and both use ON CONFLICT DO NOTHING, so a duplicate Slack
 * delivery is a no-op for both in the same transaction rather than a
 * jobs.event_id UNIQUE violation aborting the batch.
 *
 * Returns null when the receipt already existed (a duplicate delivery)
 * — the caller still acks 200 in that case, it just does not enqueue a
 * second job.
 */
export async function recordIncomingEvent(deps: RepoDeps, input: RecordIncomingEventInput): Promise<JobRow | null> {
  const { db, now } = deps;
  const nowMs = now().getTime();

  const [receiptResult, jobResult] = await db.batch([
    db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.slackEventReceipts} (event_id, event_type, received_at)
         VALUES (?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(input.eventId, input.eventType, nowMs),
    db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.jobs}
           (event_id, kind, channel_id, thread_ts, actor_user_id, raw_text, state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(input.eventId, input.kind, input.channelId, input.threadTs, input.actorUserId, input.rawText, nowMs, nowMs),
  ]);

  if (!receiptResult || receiptResult.meta.changes === 0) {
    return null;
  }
  if (!jobResult || jobResult.meta.changes === 0 || !jobResult.meta.last_row_id) {
    // The receipt and jobs inserts are gated by the same event_id in the
    // same batch, so they should always agree — this only fires on a
    // genuine bug, not a normal duplicate delivery.
    throw new Error(`recordIncomingEvent: receipt inserted but no jobs row was created for event ${input.eventId}`);
  }

  return {
    id: jobResult.meta.last_row_id,
    event_id: input.eventId,
    kind: input.kind,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    actor_user_id: input.actorUserId,
    raw_text: input.rawText,
    state: "pending",
    attempts: 0,
    claim_token: null,
    claim_expires_at: null,
    last_error: null,
    created_at: nowMs,
    updated_at: nowMs,
    completed_at: null,
  };
}

/** Looks up a job by its numeric id — used by src/slack/interactions.ts to recover a reply job's context (raw_text, channel, thread) after a follow-up click (arrival/variant/candidate pick, issue #14). */
export async function getJobById(deps: RepoDeps, id: number): Promise<JobRow | null> {
  const row = await deps.db.prepare(`SELECT * FROM ${TABLE_NAMES.jobs} WHERE id = ?`).bind(id).first<JobRow>();
  return row ?? null;
}

export interface RecordInteractionReceiptInput {
  /**
   * Synthetic id, not a real Slack `event_id` — Slack interactions
   * (button clicks, modal submissions) have no event_id of their own,
   * so src/slack/interactions.ts mints one from
   * `(action_id, opaque target id, action_ts)` per issue #14's
   * idempotency requirement.
   */
  id: string;
  eventType: string;
}

/**
 * Records a Slack interaction receipt for idempotency, reusing the same
 * ON CONFLICT DO NOTHING `slack_event_receipts` table recordIncomingEvent
 * writes to for events — see that function's doc comment. Returns true
 * the first time this id is seen (the caller should run its effect),
 * false for a duplicate click or Slack retry (the caller must not repeat
 * the effect — CLAUDE.md "Read result.meta.changes on every conditional
 * write").
 */
export async function recordInteractionReceipt(deps: RepoDeps, input: RecordInteractionReceiptInput): Promise<boolean> {
  const nowMs = deps.now().getTime();
  const result = await deps.db
    .prepare(
      `INSERT INTO ${TABLE_NAMES.slackEventReceipts} (event_id, event_type, received_at)
       VALUES (?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .bind(input.id, input.eventType, nowMs)
    .run();
  return result.meta.changes > 0;
}

export interface ClaimJobsInput {
  states: JobState[];
  limit: number;
  claimToken: string;
  claimTtlMs: number;
}

/**
 * Atomically claims up to `limit` jobs currently in one of `states`
 * whose previous claim (if any) has expired, stamping `claim_token` /
 * `claim_expires_at` in a single UPDATE ... RETURNING so a concurrent
 * delivery pass cannot also pick them up. Does not itself move `state`
 * — see updateJobState, fenced by the same claimToken.
 *
 * Eligibility also matches a row already stamped with `claimToken`
 * (issue #10) — so a caller that retries a claim call with the *same*
 * token (e.g. after losing the response to a network flake, without
 * knowing whether the UPDATE itself landed) re-selects the batch it
 * already owns instead of drifting onto a second, overlapping one.
 */
export async function claimJobs(deps: RepoDeps, input: ClaimJobsInput): Promise<JobRow[]> {
  const { db, now } = deps;
  if (input.states.length === 0 || input.limit <= 0) return [];

  const nowMs = now().getTime();
  const claimExpiresAt = nowMs + input.claimTtlMs;
  const statePlaceholders = input.states.map(() => "?").join(", ");

  const result = await db
    .prepare(
      `UPDATE ${TABLE_NAMES.jobs}
       SET claim_token = ?, claim_expires_at = ?, updated_at = ?
       WHERE id IN (
         SELECT id FROM ${TABLE_NAMES.jobs}
         WHERE state IN (${statePlaceholders})
           AND (claim_expires_at IS NULL OR claim_expires_at < ? OR claim_token = ?)
         ORDER BY id
         LIMIT ?
       )
       RETURNING *`,
    )
    .bind(input.claimToken, claimExpiresAt, nowMs, ...input.states, nowMs, input.claimToken, input.limit)
    .all<JobRow>();

  return result.results;
}

export interface UpdateJobStateInput {
  id: number;
  claimToken: string;
  state: JobState;
  lastError?: string | null;
  /**
   * Pushes the lease forward (issue #10's retry backoff: `state =
   * 'failed'` plus a longer `claim_expires_at` is what makes the row
   * reclaimable only after the backoff window, via the same
   * expiry-based mechanism claimJobs already uses — no separate
   * "release" path). Omitted/undefined leaves the column untouched via
   * `COALESCE`, which is what every same-pass hop (e.g. composing ->
   * delivering) wants: keep whatever lease claimJobs already stamped.
   */
  claimExpiresAt?: number;
  /** True on a failure write — the only point `attempts` is incremented (issue #10's retry ceiling; see src/jobs/queue.ts nextStateAfterFailure). */
  incrementAttempts?: boolean;
}

/**
 * Advances a claimed job's state, fenced by `claimToken` so a worker
 * that lost its claim (e.g. it ran past claim_expires_at and was
 * reclaimed) cannot stomp on whoever holds it now. Read
 * `result.meta.changes` — `0` means this claim lost the race and is not
 * itself an error. See CLAUDE.md "Conventions".
 */
export async function updateJobState(deps: RepoDeps, input: UpdateJobStateInput): Promise<boolean> {
  const { db, now } = deps;
  const nowMs = now().getTime();
  const isTerminal = input.state === "done" || input.state === "dead";
  const attemptsDelta = input.incrementAttempts ? 1 : 0;
  const claimExpiresAt = input.claimExpiresAt ?? null;

  const statement = isTerminal
    ? db
        .prepare(
          `UPDATE ${TABLE_NAMES.jobs}
           SET state = ?, updated_at = ?, last_error = ?, completed_at = ?,
               claim_expires_at = COALESCE(?, claim_expires_at),
               attempts = attempts + ?
           WHERE id = ? AND claim_token = ?`,
        )
        .bind(
          input.state,
          nowMs,
          input.lastError ?? null,
          nowMs,
          claimExpiresAt,
          attemptsDelta,
          input.id,
          input.claimToken,
        )
    : db
        .prepare(
          `UPDATE ${TABLE_NAMES.jobs}
           SET state = ?, updated_at = ?, last_error = ?,
               claim_expires_at = COALESCE(?, claim_expires_at),
               attempts = attempts + ?
           WHERE id = ? AND claim_token = ?`,
        )
        .bind(input.state, nowMs, input.lastError ?? null, claimExpiresAt, attemptsDelta, input.id, input.claimToken);

  const result = await statement.run();
  return result.meta.changes > 0;
}

// ---------------------------------------------------------------------
// usage_log
// ---------------------------------------------------------------------

export interface AppendUsageLogInput {
  slug: string | null;
  task: UsageTask;
  provider: string;
  model: string | null;
  /** NULL on the happy path, else the reason token. */
  fallback: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export async function appendUsageLog(deps: RepoDeps, input: AppendUsageLogInput): Promise<void> {
  const nowMs = deps.now().getTime();
  await deps.db
    .prepare(
      `INSERT INTO ${TABLE_NAMES.usageLog} (slug, task, provider, model, fallback, tokens_in, tokens_out, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.slug,
      input.task,
      input.provider,
      input.model,
      input.fallback,
      input.tokensIn,
      input.tokensOut,
      nowMs,
    )
    .run();
}
