/** Durable first-attempt identity for idempotent policy rollbacks. */
import type { RepoDeps } from "../db/repos";
import { TABLE_NAMES, type PolicyRollbackAttemptRow } from "../db/schema";
import { POLICY_DOC_PATH } from "../policy/contract";

export class PolicyRollbackAttemptMismatchError extends Error {
  constructor() {
    super("policy rollback job target does not match its durable first attempt");
    this.name = "PolicyRollbackAttemptMismatchError";
  }
}

export interface AdoptPolicyRollbackAttemptInput {
  jobId: number;
  targetVersion: number;
  expectedVersion: number;
}

/**
 * Inserts the first authoritative request identity or atomically adopts it.
 * The conflict update deliberately preserves `expected_version`; a retried or
 * concurrent worker must reuse the first POST body even after the live head
 * advances. A changed target returns no row and is rejected without mutation.
 */
export async function adoptPolicyRollbackAttempt(
  deps: RepoDeps,
  input: AdoptPolicyRollbackAttemptInput,
): Promise<PolicyRollbackAttemptRow> {
  if (![input.jobId, input.targetVersion, input.expectedVersion].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  )) {
    throw new PolicyRollbackAttemptMismatchError();
  }
  const nowMs = deps.now().getTime();
  const row = await deps.db
    .prepare(
      `INSERT INTO ${TABLE_NAMES.policyRollbackAttempts}
         (job_id, path, target_version, expected_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET updated_at = excluded.updated_at
       WHERE ${TABLE_NAMES.policyRollbackAttempts}.path = excluded.path
         AND ${TABLE_NAMES.policyRollbackAttempts}.target_version = excluded.target_version
       RETURNING *`,
    )
    .bind(input.jobId, POLICY_DOC_PATH, input.targetVersion, input.expectedVersion, nowMs, nowMs)
    .first<PolicyRollbackAttemptRow>();
  if (row === null) throw new PolicyRollbackAttemptMismatchError();
  return row;
}
