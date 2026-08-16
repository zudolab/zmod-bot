/**
 * D1 table row shapes. The authoritative SQL schema lives in
 * `migrations/` (`migrations/0001_init.sql`); this file is the
 * TypeScript mirror that src/db/repos.ts and the domain modules import
 * against, so a schema drift between the two shows up as a typecheck
 * failure instead of a runtime surprise.
 *
 * Table set and the jobs state machine are fixed by epic issue #1's
 * "Durable job semantics" section and issue #3's schema — do not rename
 * a column here without updating migrations/0001_init.sql (additive-only
 * — CLAUDE.md) and this file together.
 */

/** The DDL comment on product_refs.category is the only enum source — see migrations/0001_init.sql. */
export type ProductCategory = "general" | "general (built) / diy (kit)" | "small";

export interface ProductRefRow {
  slug: string;
  category: ProductCategory;
  product_url: string | null;
  /** The reference document, verbatim — see data/seed/README.md for the source format. */
  body_md: string;
  version: number;
  /** Epoch milliseconds. */
  updated_at: number;
  /** 'seed' | a Slack user id. */
  updated_by: string;
}

/** The resolver's (issue #8) lookup key — normalized alias text to the slug it resolves to. */
export interface ProductRefAliasRow {
  alias_norm: string;
  slug: string;
}

export type ProductRefVersionSource = "seed" | "authored" | "refreshed" | "restored";

/** One row per edit — how `ref refresh` / `ref restore` recover a prior version (CLAUDE.md "Conventions"). */
export interface ProductRefVersionRow {
  id: number;
  slug: string;
  version: number;
  body_md: string;
  category: ProductCategory;
  product_url: string | null;
  created_at: number;
  created_by: string;
  source: ProductRefVersionSource;
}

/**
 * A pending authoring edit awaiting Slack approval (epic issue #1 point
 * 8, "writes are gated"). Previews persist here — with an expiry and an
 * expected `base_version` — rather than as a button payload, since
 * Slack's `value` caps at 2000 chars and a stale approval must not
 * clobber a concurrent edit.
 */
export interface RefDraftRow {
  id: string;
  slug: string;
  body_md: string;
  category: ProductCategory;
  product_url: string | null;
  /** NULL for a brand-new ref; else the version this draft was edited against. */
  base_version: number | null;
  created_at: number;
  created_by: string;
  expires_at: number;
  consumed_at: number | null;
  /** Which authoring action produced this draft — copied verbatim onto the product_ref_versions row on approval. See RefDraftSource. */
  source: RefDraftSource;
}

/**
 * A draft's authoring action (migrations/0003_ref_drafts_source.sql).
 * Narrower than ProductRefVersionSource: `seed` can never originate from
 * a draft. Carried as a column rather than inferred from `base_version`
 * at approval time, because `authored` vs `refreshed` is inferable that
 * way but `restored` is not — and mislabelling a restore as a refresh
 * falsifies the only undo history this store has (issue #15).
 */
export type RefDraftSource = Exclude<ProductRefVersionSource, "seed">;

/** Written in the same db.batch() as the jobs row, ON CONFLICT DO NOTHING — the de-dup half of the durable-intent write. */
export interface SlackEventReceiptRow {
  event_id: string;
  event_type: string;
  received_at: number;
}

export type JobKind = "reply" | "polish" | "ref";

/** pending -> composing -> delivering -> done | failed | dead (see src/jobs/queue.ts). */
export type JobState = "pending" | "composing" | "delivering" | "done" | "failed" | "dead";

export interface JobRow {
  id: number;
  /** Slack event id — UNIQUE, the de-dup key for at-least-once delivery. */
  event_id: string;
  kind: JobKind;
  channel_id: string;
  thread_ts: string;
  actor_user_id: string;
  raw_text: string;
  state: JobState;
  attempts: number;
  claim_token: string | null;
  claim_expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export type UsageTask = "compose" | "author" | "polish";

export interface UsageLogRow {
  id: number;
  slug: string | null;
  task: UsageTask;
  provider: string;
  model: string | null;
  /** NULL on the happy path, else the reason token. */
  fallback: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: number;
}

export const TABLE_NAMES = {
  productRefs: "product_refs",
  productRefAliases: "product_ref_aliases",
  productRefVersions: "product_ref_versions",
  refDrafts: "ref_drafts",
  slackEventReceipts: "slack_event_receipts",
  jobs: "jobs",
  usageLog: "usage_log",
} as const;
