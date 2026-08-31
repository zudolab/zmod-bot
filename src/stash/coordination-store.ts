/**
 * D1 coordination state for the policy proposal and decision flows.
 *
 * This is deliberately a storage boundary rather than an orchestration
 * module.  Proposal callers use the generation as a fencing token immediately
 * before a remote create, while decision callers use the decision epoch and
 * outbox row to resume work after a remote or Slack call.  No policy body,
 * diff, request, upstream message, or credential is accepted by this module.
 */
import type { RepoDeps } from "../db/repos";
import {
  TABLE_NAMES,
  type JobKind,
  type PolicyDecisionAction,
  type PolicyDecisionConflictState,
  type PolicyDecisionFenceRow,
  type PolicyDecisionFenceState,
  type PolicyDecisionRemoteResult,
  type PolicyDecisionRow,
  type PolicyProposalLeaseRow,
} from "../db/schema";
import { POLICY_DOC_PATH } from "../policy/contract";

export type {
  PolicyDecisionAction,
  PolicyDecisionConflictState,
  PolicyDecisionFenceRow,
  PolicyDecisionFenceState,
  PolicyDecisionRemoteResult,
  PolicyDecisionRow,
  PolicyProposalLeaseRow,
} from "../db/schema";

export const POLICY_PROPOSAL_LEASE_MS = 90_000;
export const POLICY_DECISION_EVENT_TYPE = "policy_decision_click";
export const POLICY_DECISION_JOB_KIND: JobKind = "policy_decision";

type D1ChangesResult = { meta: { changes: number; last_row_id?: number } };

function resultChanged(results: readonly D1ChangesResult[], index: number): boolean {
  return (results[index]?.meta.changes ?? 0) > 0;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function requirePositiveDuration(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export function policyDecisionEventId(changeSetId: string, decisionEpoch: number): string {
  return `policy-decision:${changeSetId}:${decisionEpoch}`;
}

function inputReceiptId(input: RecordPolicyDecisionInput): string {
  const id = input.receiptId ?? input.clickReceiptId;
  if (!id) throw new RangeError("receiptId is required");
  return id;
}

// ---------------------------------------------------------------------
// Proposal lease
// ---------------------------------------------------------------------

export interface AcquirePolicyProposalLeaseInput {
  ownerJobId: number;
  ttlMs?: number;
}

export interface AcquirePolicyProposalLeaseResult {
  acquired: boolean;
  lease: PolicyProposalLeaseRow | null;
  /** Convenience mirrors for callers that only need the fencing token. */
  generation: number | null;
  expiresAt: number | null;
}

/** Reads the exact policy-path lease, including an expired row awaiting reclaim. */
export async function getPolicyProposalLease(deps: RepoDeps): Promise<PolicyProposalLeaseRow | null> {
  const row = await deps.db
    .prepare(
      `SELECT path, owner_job_id, generation, expires_at
       FROM ${TABLE_NAMES.policyProposalLeases}
       WHERE path = ?`,
    )
    .bind(POLICY_DOC_PATH)
    .first<PolicyProposalLeaseRow>();
  return row ?? null;
}

/** Backward-friendly short name for callers that already know this is policy state. */
export const getProposalLease = getPolicyProposalLease;

/**
 * Acquires or resumes the one exact-path proposal lease.
 *
 * The conditional UPSERT is the race fence: a live different owner produces
 * `meta.changes === 0`; a live same owner keeps its generation; reclaiming an
 * expired row increments generation.  `RETURNING` gives the winner the exact
 * generation that must be passed to the remote create fence.
 */
export async function acquirePolicyProposalLease(
  deps: RepoDeps,
  input: AcquirePolicyProposalLeaseInput,
): Promise<AcquirePolicyProposalLeaseResult> {
  requirePositiveInteger(input.ownerJobId, "ownerJobId");
  const ttlMs = input.ttlMs ?? POLICY_PROPOSAL_LEASE_MS;
  requirePositiveDuration(ttlMs, "ttlMs");

  const nowMs = deps.now().getTime();
  const expiresAt = nowMs + ttlMs;
  const result = await deps.db
    .prepare(
      `INSERT INTO ${TABLE_NAMES.policyProposalLeases} (path, owner_job_id, generation, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(path) DO UPDATE SET
         owner_job_id = excluded.owner_job_id,
         generation = CASE
           WHEN ${TABLE_NAMES.policyProposalLeases}.expires_at <= ?
           THEN ${TABLE_NAMES.policyProposalLeases}.generation + 1
           ELSE ${TABLE_NAMES.policyProposalLeases}.generation
         END,
         expires_at = excluded.expires_at
       WHERE ${TABLE_NAMES.policyProposalLeases}.owner_job_id = ?
          OR ${TABLE_NAMES.policyProposalLeases}.expires_at <= ?
       RETURNING path, owner_job_id, generation, expires_at`,
    )
    .bind(POLICY_DOC_PATH, input.ownerJobId, expiresAt, nowMs, input.ownerJobId, nowMs)
    .all<PolicyProposalLeaseRow>();

  const lease = result.results[0] ?? null;
  const acquired = result.meta.changes > 0 && lease !== null;
  return {
    acquired,
    lease: acquired ? lease : null,
    generation: acquired ? lease.generation : null,
    expiresAt: acquired ? lease.expires_at : null,
  };
}

export const acquireProposalLease = acquirePolicyProposalLease;

export interface FencedPolicyProposalLeaseInput {
  ownerJobId: number;
  generation: number;
  ttlMs?: number;
}

/** Renews only a live lease owned by the exact `(job, generation)` pair. */
export async function renewPolicyProposalLease(
  deps: RepoDeps,
  input: FencedPolicyProposalLeaseInput,
): Promise<boolean> {
  requirePositiveInteger(input.ownerJobId, "ownerJobId");
  requirePositiveInteger(input.generation, "generation");
  const ttlMs = input.ttlMs ?? POLICY_PROPOSAL_LEASE_MS;
  requirePositiveDuration(ttlMs, "ttlMs");

  const nowMs = deps.now().getTime();
  const result = await deps.db
    .prepare(
      `UPDATE ${TABLE_NAMES.policyProposalLeases}
       SET expires_at = ?
       WHERE path = ?
         AND owner_job_id = ?
         AND generation = ?
         AND expires_at > ?`,
    )
    .bind(nowMs + ttlMs, POLICY_DOC_PATH, input.ownerJobId, input.generation, nowMs)
    .run();
  return result.meta.changes > 0;
}

export const renewProposalLease = renewPolicyProposalLease;

export interface ReleasePolicyProposalLeaseInput {
  ownerJobId: number;
  generation: number;
}

/**
 * Releases a live lease only.  Marking the row expired instead of deleting it
 * is important: the next acquire can increment its generation instead of
 * resetting the fencing token to one.
 */
export async function releasePolicyProposalLease(
  deps: RepoDeps,
  input: ReleasePolicyProposalLeaseInput,
): Promise<boolean> {
  requirePositiveInteger(input.ownerJobId, "ownerJobId");
  requirePositiveInteger(input.generation, "generation");

  const nowMs = deps.now().getTime();
  const result = await deps.db
    .prepare(
      `UPDATE ${TABLE_NAMES.policyProposalLeases}
       SET expires_at = ?
       WHERE path = ?
         AND owner_job_id = ?
         AND generation = ?
         AND expires_at > ?`,
    )
    .bind(nowMs, POLICY_DOC_PATH, input.ownerJobId, input.generation, nowMs)
    .run();
  return result.meta.changes > 0;
}

export const releaseProposalLease = releasePolicyProposalLease;

// ---------------------------------------------------------------------
// Decision/outbox state
// ---------------------------------------------------------------------

export type PolicyDecisionTerminalResult = Exclude<PolicyDecisionRemoteResult, "pending">;
export type PolicyDecisionReason =
  | "created"
  | "active"
  | "conflict-pending"
  | "conflict-approve-blocked"
  | "closed"
  | "not-created";

export interface RecordPolicyDecisionInput {
  changeSetId: string;
  action: PolicyDecisionAction;
  actorUserId: string;
  channelId: string;
  reviewMessageTs: string;
  /** Synthetic interaction identity; each click gets its own receipt. */
  receiptId?: string;
  /** Alias accepted for callers that name the value after the click itself. */
  clickReceiptId?: string;
  eventType?: string;
}

export interface RecordPolicyDecisionResult {
  receiptRecorded: boolean;
  fenceCreated: boolean;
  conflictReopened: boolean;
  decisionCreated: boolean;
  jobCreated: boolean;
  /** True only for the click that won first-writer action/actor ownership. */
  accepted: boolean;
  decisionEpoch: number | null;
  eventId: string | null;
  decision: PolicyDecisionRow | null;
  fence: PolicyDecisionFenceRow | null;
  reason: PolicyDecisionReason;
}

async function getPolicyDecisionAtEpoch(
  deps: RepoDeps,
  changeSetId: string,
  decisionEpoch: number,
): Promise<PolicyDecisionRow | null> {
  const row = await deps.db
    .prepare(
      `SELECT change_set_id, decision_epoch, action, actor_user_id, channel_id,
              review_message_ts, remote_result, remote_code, remote_version,
              remote_commit_id, conflict_state, slack_update_completed,
              created_at, updated_at
       FROM ${TABLE_NAMES.policyDecisions}
       WHERE change_set_id = ? AND decision_epoch = ?`,
    )
    .bind(changeSetId, decisionEpoch)
    .first<PolicyDecisionRow>();
  return row ?? null;
}

export async function getPolicyDecision(
  deps: RepoDeps,
  changeSetId: string,
  decisionEpoch: number,
): Promise<PolicyDecisionRow | null> {
  requirePositiveInteger(decisionEpoch, "decisionEpoch");
  return getPolicyDecisionAtEpoch(deps, changeSetId, decisionEpoch);
}

export async function getPolicyDecisionFence(
  deps: RepoDeps,
  changeSetId: string,
): Promise<PolicyDecisionFenceRow | null> {
  const row = await deps.db
    .prepare(
      `SELECT change_set_id, active_epoch, state, updated_at
       FROM ${TABLE_NAMES.policyDecisionFences}
       WHERE change_set_id = ?`,
    )
    .bind(changeSetId)
    .first<PolicyDecisionFenceRow>();
  return row ?? null;
}

export interface ActivePolicyDecision {
  fence: PolicyDecisionFenceRow;
  decision: PolicyDecisionRow | null;
}

export async function getActivePolicyDecision(
  deps: RepoDeps,
  changeSetId: string,
): Promise<ActivePolicyDecision | null> {
  const fence = await getPolicyDecisionFence(deps, changeSetId);
  if (!fence) return null;
  return { fence, decision: await getPolicyDecisionAtEpoch(deps, changeSetId, fence.active_epoch) };
}

/**
 * Records a click receipt, adopts the one active epoch, and creates the
 * stable remote-decision job in one D1 batch.  Every write after the receipt
 * is independently gated, because D1 does not abort a batch when a prior
 * conditional statement merely matches zero rows.
 */
export async function recordPolicyDecision(
  deps: RepoDeps,
  input: RecordPolicyDecisionInput,
): Promise<RecordPolicyDecisionResult> {
  const receiptId = inputReceiptId(input);
  if (!input.changeSetId) throw new RangeError("changeSetId is required");
  if (!input.actorUserId) throw new RangeError("actorUserId is required");
  if (!input.channelId) throw new RangeError("channelId is required");
  if (!input.reviewMessageTs) throw new RangeError("reviewMessageTs is required");

  const { db } = deps;
  const nowMs = deps.now().getTime();
  const eventType = input.eventType ?? POLICY_DECISION_EVENT_TYPE;
  const eventPrefix = "policy-decision:";

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.slackEventReceipts} (event_id, event_type, received_at)
         VALUES (?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(receiptId, eventType, nowMs),
    db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.policyDecisionFences} (change_set_id, active_epoch, state, updated_at)
         VALUES (?, 1, 'open', ?)
         ON CONFLICT(change_set_id) DO NOTHING`,
      )
      .bind(input.changeSetId, nowMs),
    db
      .prepare(
        `UPDATE ${TABLE_NAMES.policyDecisionFences}
         SET active_epoch = active_epoch + 1, state = 'open', updated_at = ?
         WHERE change_set_id = ? AND state = 'conflict_reopen' AND ? = 'reject'
           AND updated_at < ?
           AND EXISTS (
             SELECT 1 FROM ${TABLE_NAMES.slackEventReceipts} r
             WHERE r.event_id = ? AND r.received_at = ?
           )`,
      )
      .bind(nowMs, input.changeSetId, input.action, nowMs, receiptId, nowMs),
    db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.policyDecisions}
           (change_set_id, decision_epoch, action, actor_user_id, channel_id,
            review_message_ts, remote_result, conflict_state,
            slack_update_completed, created_at, updated_at)
         SELECT change_set_id, active_epoch, ?, ?, ?, ?, 'pending', 'none', 0, ?, ?
         FROM ${TABLE_NAMES.policyDecisionFences}
         WHERE change_set_id = ? AND state = 'open'
           AND EXISTS (
             SELECT 1 FROM ${TABLE_NAMES.slackEventReceipts} r
             WHERE r.event_id = ? AND r.received_at = ?
           )
         ON CONFLICT(change_set_id, decision_epoch) DO NOTHING`,
      )
      .bind(
        input.action,
        input.actorUserId,
        input.channelId,
        input.reviewMessageTs,
        nowMs,
        nowMs,
        input.changeSetId,
        receiptId,
        nowMs,
      ),
    db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.jobs}
           (event_id, kind, channel_id, thread_ts, actor_user_id, raw_text,
            state, attempts, created_at, updated_at)
         SELECT ? || d.change_set_id || ':' || d.decision_epoch, ?, d.channel_id,
                d.review_message_ts, d.actor_user_id,
                ? || d.change_set_id || ':' || d.decision_epoch,
                'pending', 0, ?, ?
         FROM ${TABLE_NAMES.policyDecisions} d
         JOIN ${TABLE_NAMES.policyDecisionFences} f
           ON f.change_set_id = d.change_set_id
          AND f.active_epoch = d.decision_epoch
         WHERE d.change_set_id = ?
           AND d.remote_result = 'pending'
           AND f.state = 'open'
           AND EXISTS (
             SELECT 1 FROM ${TABLE_NAMES.slackEventReceipts} r
             WHERE r.event_id = ? AND r.received_at = ?
           )
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(eventPrefix, POLICY_DECISION_JOB_KIND, eventPrefix, nowMs, nowMs, input.changeSetId, receiptId, nowMs),
  ]);

  const typedResults = results as D1ChangesResult[];
  const receiptRecorded = resultChanged(typedResults, 0);
  const fenceCreated = resultChanged(typedResults, 1);
  const conflictReopened = resultChanged(typedResults, 2);
  const decisionCreated = resultChanged(typedResults, 3);
  const jobCreated = resultChanged(typedResults, 4);
  if (decisionCreated && !jobCreated) {
    throw new Error("policy decision invariant failed: decision created without job");
  }
  const fence = await getPolicyDecisionFence(deps, input.changeSetId);
  const decisionEpoch = fence?.active_epoch ?? null;
  const decision = fence ? await getPolicyDecisionAtEpoch(deps, input.changeSetId, fence.active_epoch) : null;
  const eventId = decision ? policyDecisionEventId(input.changeSetId, decision.decision_epoch) : null;

  let reason: PolicyDecisionReason;
  if (decisionCreated) reason = "created";
  else if (fence?.state === "conflict_pending") reason = "conflict-pending";
  else if (fence?.state === "conflict_reopen" && input.action === "approve") reason = "conflict-approve-blocked";
  else if (fence?.state === "closed") reason = "closed";
  else if (decision) reason = "active";
  else reason = "not-created";

  return {
    receiptRecorded,
    fenceCreated,
    conflictReopened,
    decisionCreated,
    jobCreated,
    accepted: decisionCreated && jobCreated,
    decisionEpoch,
    eventId,
    decision,
    fence,
    reason,
  };
}

export const recordPolicyDecisionIntake = recordPolicyDecision;

export interface RecordPolicyDecisionRemoteResultInput {
  changeSetId: string;
  decisionEpoch: number;
  result?: PolicyDecisionTerminalResult;
  /** Alias accepted for callers that preserve the stash response field name. */
  remoteResult?: PolicyDecisionTerminalResult;
  remoteCode?: string | null;
  remoteVersion?: number | null;
  remoteCommitId?: string | null;
}

export interface RecordPolicyDecisionRemoteResultResult {
  recorded: boolean;
  fenceUpdated: boolean;
  decision: PolicyDecisionRow | null;
  fence: PolicyDecisionFenceRow | null;
}

function terminalResult(input: RecordPolicyDecisionRemoteResultInput): PolicyDecisionTerminalResult {
  const result = input.result ?? input.remoteResult;
  if (
    result !== "applied" &&
    result !== "rejected" &&
    result !== "expired" &&
    result !== "closed" &&
    result !== "conflict"
  ) {
    throw new RangeError("a terminal remote result is required");
  }
  return result;
}

/** Records the first terminal remote outcome and fences its active epoch. */
export async function recordPolicyDecisionRemoteResult(
  deps: RepoDeps,
  input: RecordPolicyDecisionRemoteResultInput,
): Promise<RecordPolicyDecisionRemoteResultResult> {
  requirePositiveInteger(input.decisionEpoch, "decisionEpoch");
  const result = terminalResult(input);
  const nowMs = deps.now().getTime();
  const conflictState: PolicyDecisionConflictState = result === "conflict" ? "pending" : "none";
  const fenceState: PolicyDecisionFenceState = result === "conflict" ? "conflict_pending" : "closed";

  const results = await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE ${TABLE_NAMES.policyDecisions}
         SET remote_result = ?, remote_code = ?, remote_version = ?, remote_commit_id = ?,
             conflict_state = ?, slack_update_completed = 0, updated_at = ?
         WHERE change_set_id = ? AND decision_epoch = ? AND remote_result = 'pending'
           AND (action = 'approve' OR ? <> 'conflict')
           AND EXISTS (
             SELECT 1 FROM ${TABLE_NAMES.policyDecisionFences} f
             WHERE f.change_set_id = ${TABLE_NAMES.policyDecisions}.change_set_id
               AND f.active_epoch = ${TABLE_NAMES.policyDecisions}.decision_epoch
               AND f.state = 'open'
           )`,
      )
      .bind(
        result,
        input.remoteCode ?? null,
        input.remoteVersion ?? null,
        input.remoteCommitId ?? null,
        conflictState,
        nowMs,
        input.changeSetId,
        input.decisionEpoch,
        result,
      ),
    deps.db
      .prepare(
        `UPDATE ${TABLE_NAMES.policyDecisionFences}
         SET state = ?, updated_at = ?
         WHERE change_set_id = ? AND active_epoch = ?
           AND EXISTS (
             SELECT 1 FROM ${TABLE_NAMES.policyDecisions} d
             WHERE d.change_set_id = ${TABLE_NAMES.policyDecisionFences}.change_set_id
               AND d.decision_epoch = ${TABLE_NAMES.policyDecisionFences}.active_epoch
               AND d.remote_result = ?
           )
           AND state <> ?`,
      )
      .bind(fenceState, nowMs, input.changeSetId, input.decisionEpoch, result, fenceState),
  ]);

  const typedResults = results as D1ChangesResult[];
  const recorded = resultChanged(typedResults, 0);
  const fenceUpdated = resultChanged(typedResults, 1);
  return {
    recorded,
    fenceUpdated,
    decision: await getPolicyDecisionAtEpoch(deps, input.changeSetId, input.decisionEpoch),
    fence: await getPolicyDecisionFence(deps, input.changeSetId),
  };
}

export const recordPolicyDecisionRemote = recordPolicyDecisionRemoteResult;

export interface MarkPolicyDecisionSlackUpdateInput {
  changeSetId: string;
  decisionEpoch: number;
}

export interface MarkPolicyDecisionSlackUpdateResult {
  recorded: boolean;
  fenceUpdated: boolean;
  decision: PolicyDecisionRow | null;
  fence: PolicyDecisionFenceRow | null;
}

/**
 * Marks the convergent Slack update complete.  A conflict becomes one
 * reopenable reject epoch only after this write; all other terminal outcomes
 * remain permanently closed.
 */
export async function markPolicyDecisionSlackUpdateComplete(
  deps: RepoDeps,
  input: MarkPolicyDecisionSlackUpdateInput,
): Promise<MarkPolicyDecisionSlackUpdateResult> {
  requirePositiveInteger(input.decisionEpoch, "decisionEpoch");
  const nowMs = deps.now().getTime();
  const results = await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE ${TABLE_NAMES.policyDecisions}
         SET slack_update_completed = 1,
             conflict_state = CASE WHEN remote_result = 'conflict' THEN 'reopenable' ELSE conflict_state END,
             updated_at = ?
         WHERE change_set_id = ? AND decision_epoch = ?
           AND remote_result <> 'pending'
           AND slack_update_completed = 0`,
      )
      .bind(nowMs, input.changeSetId, input.decisionEpoch),
    deps.db
      .prepare(
        `UPDATE ${TABLE_NAMES.policyDecisionFences}
         SET state = CASE
           WHEN EXISTS (
             SELECT 1 FROM ${TABLE_NAMES.policyDecisions} d
             WHERE d.change_set_id = ${TABLE_NAMES.policyDecisionFences}.change_set_id
               AND d.decision_epoch = ${TABLE_NAMES.policyDecisionFences}.active_epoch
               AND d.remote_result = 'conflict'
               AND d.slack_update_completed = 1
           ) THEN 'conflict_reopen'
           ELSE 'closed'
         END,
         updated_at = ?
           WHERE change_set_id = ? AND active_epoch = ?
           AND EXISTS (
             SELECT 1 FROM ${TABLE_NAMES.policyDecisions} d
             WHERE d.change_set_id = ${TABLE_NAMES.policyDecisionFences}.change_set_id
               AND d.decision_epoch = ${TABLE_NAMES.policyDecisionFences}.active_epoch
               AND d.remote_result <> 'pending'
               AND d.slack_update_completed = 1
           )
           AND state <> CASE
             WHEN EXISTS (
               SELECT 1 FROM ${TABLE_NAMES.policyDecisions} d
               WHERE d.change_set_id = ${TABLE_NAMES.policyDecisionFences}.change_set_id
                 AND d.decision_epoch = ${TABLE_NAMES.policyDecisionFences}.active_epoch
                 AND d.remote_result = 'conflict'
                 AND d.slack_update_completed = 1
             ) THEN 'conflict_reopen'
             ELSE 'closed'
           END`,
      )
      .bind(nowMs, input.changeSetId, input.decisionEpoch),
  ]);

  const typedResults = results as D1ChangesResult[];
  const recorded = resultChanged(typedResults, 0);
  const fenceUpdated = resultChanged(typedResults, 1);
  return {
    recorded,
    fenceUpdated,
    decision: await getPolicyDecisionAtEpoch(deps, input.changeSetId, input.decisionEpoch),
    fence: await getPolicyDecisionFence(deps, input.changeSetId),
  };
}

export const markPolicyDecisionSlackUpdate = markPolicyDecisionSlackUpdateComplete;
