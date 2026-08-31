/**
 * D1 last-known-good storage for the live policy reader.
 *
 * The stash client is responsible for accepting only a structurally valid
 * inline policy body. This module stores that already-validated body and
 * enforces the ordering contract at the persistence boundary: a lower stash
 * version can never replace a newer row, and a same-version response may
 * refresh confirmation time only when its document and exact ETag match.
 */
import type { RepoDeps } from "../db/repos";
import { TABLE_NAMES, type PolicyLastKnownGoodRow } from "../db/schema";
import { POLICY_DOC_PATH } from "../policy/contract";

export type { PolicyLastKnownGoodRow } from "../db/schema";

export interface PutPolicyLastKnownGoodInput {
  /** The stash version associated with the confirmed inline document. */
  version: number;
  /** The already-validated inline policy document. */
  document: string;
  /** The exact HTTP response-header ETag, including any surrounding quotes. */
  etag: string;
}

/** Reads the one fixed policy path, or null before the first successful confirmation. */
export async function getPolicyLastKnownGood(deps: RepoDeps): Promise<PolicyLastKnownGoodRow | null> {
  const row = await deps.db
    .prepare(
      `SELECT path, document, version, etag, confirmed_at
       FROM ${TABLE_NAMES.policyLastKnownGood}
       WHERE path = ?`,
    )
    .bind(POLICY_DOC_PATH)
    .first<PolicyLastKnownGoodRow>();
  return row ?? null;
}

/**
 * Stores a newer policy identity or refreshes confirmation for the same
 * identity. Returns false when the write is fenced by a newer version or a
 * same-version document/ETag mismatch; callers can then fall back without
 * treating the stale response as an error.
 *
 * The conditional `ON CONFLICT ... DO UPDATE ... WHERE` is one atomic
 * statement, so a concurrent first write cannot create a race between a
 * read-before-insert and the version fence. `meta.changes` is the D1 outcome
 * for every conditional write (CLAUDE.md "Conventions").
 */
export async function putPolicyLastKnownGood(
  deps: RepoDeps,
  input: PutPolicyLastKnownGoodInput,
): Promise<boolean> {
  const confirmedAt = deps.now().getTime();
  const result = await deps.db
    .prepare(
      `INSERT INTO ${TABLE_NAMES.policyLastKnownGood} (path, document, version, etag, confirmed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         document = excluded.document,
         version = excluded.version,
         etag = excluded.etag,
         confirmed_at = excluded.confirmed_at
       WHERE excluded.version > version
          OR (excluded.version = version
              AND excluded.document = document
              AND excluded.etag = etag)`,
    )
    .bind(POLICY_DOC_PATH, input.document, input.version, input.etag, confirmedAt)
    .run();

  return result.meta.changes > 0;
}
