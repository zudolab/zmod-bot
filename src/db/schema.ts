/**
 * D1 table row shapes. The authoritative SQL schema lives in `migrations/`
 * (added by issue #3); this file is the TypeScript mirror that
 * src/db/repos.ts and the domain modules import against, so a schema
 * drift between the two shows up as a typecheck failure instead of a
 * runtime surprise.
 *
 * Table set and the jobs state machine are fixed by epic issue #1's
 * "Durable job semantics" section — do not rename columns without
 * updating that issue.
 */

export type JobKind = "reply" | "ref_new" | "ref_refresh" | "ref_restore" | "polish";

/** pending -> composing -> delivering -> done | failed | dead (see src/jobs/queue.ts). */
export type JobState = "pending" | "composing" | "delivering" | "done" | "failed" | "dead";

export interface JobRow {
  id: string;
  /** Slack event id — UNIQUE, the de-dup key for at-least-once delivery. */
  event_id: string;
  kind: JobKind;
  channel_id: string;
  thread_ts: string | null;
  actor_user_id: string;
  raw_text: string;
  state: JobState;
  attempts: number;
  claim_token: string | null;
  claim_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Written in the same db.batch() as the jobs row, ON CONFLICT DO NOTHING — the de-dup half of the durable-intent write. */
export interface SlackEventReceiptRow {
  event_id: string;
  received_at: string;
}

export type ProductCategory = "general" | "diy" | "small";

export interface ProductRefRow {
  slug: string;
  name: string;
  category: ProductCategory;
  product_url: string;
  /** JSON-encoded string[] — see src/refs/model.ts ProductRef.aliases for the decoded shape. */
  aliases: string;
  /** Full reference markdown body, in the format documented at data/seed/README.md. */
  body: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/** One row per edit — how `ref refresh` / `ref restore` recover a prior version (CLAUDE.md "Conventions"). */
export interface ProductRefVersionRow {
  id: string;
  slug: string;
  version: number;
  body: string;
  changed_by_user_id: string;
  created_at: string;
}

export const TABLE_NAMES = {
  jobs: "jobs",
  slackEventReceipts: "slack_event_receipts",
  productRefs: "product_refs",
  productRefVersions: "product_ref_versions",
} as const;
