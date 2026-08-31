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
  /** The job (if any) this draft's `ref new`/`ref refresh` originated from (migrations/0004_ref_drafts_origin_job.sql, epic #22 thread continuity). NULL for an explicit `@bot ref new <query>` — a legitimate state, not a defect. */
  origin_job_id: number | null;
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

/** Logical worker route stored in jobs.kind (TEXT): customer reply, polish, reference management, or admin policy PR. */
export type JobKind = "reply" | "polish" | "ref" | "policy_update";

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
  /** JSON-encoded ResolvedJobContext, or NULL for a job that never reached a resolved product (migrations/0006_jobs_resolved_context.sql, epic #22 thread continuity). Parse via parseResolvedJobContext (src/db/repos.ts) rather than JSON.parse directly — a malformed blob must degrade to "no memory", never throw. */
  resolved_context: string | null;
}

/**
 * What a reply job actually resolved to — slug, variant, arrival
 * schedule, and the text that decided the variant. Written by
 * recordResolvedContext (src/db/repos.ts) once a reply job has
 * resolved a product, and read back by findLatestResolvedThreadJob to give
 * a follow-up mention in the same thread its predecessor's context (epic
 * #22 thread continuity). Kept in schema.ts, not repos.ts, since later
 * sub-issues (#25, #26, #27) both write and read this shape.
 */
export interface ResolvedJobContext {
  slug: string;
  /**
   * Deliberately `string | null` rather than `PurchasedVariant`
   * (src/reply/templates.ts) — this is a persisted snapshot read back by
   * a later sub-issue's inheritance logic, not a live resolver result,
   * so it must not fail to parse just because a future variant label
   * doesn't match today's closed union.
   */
  variant: string | null;
  arrivalSchedule: string | null;
  /**
   * The operator text that gates `variant-match` literal blocks
   * (src/reply/render.ts includesLiteralBlock — e.g. zudo-rail's Lite
   * renewal notice): the raw text of the turn that *named* the product,
   * propagated unchanged along a chain of modifier-only follow-ups.
   *
   * Carried here rather than re-read from the prior job's `raw_text`
   * because that text is the immediately-preceding turn's, which in a
   * chain of three or more is itself modifier-only (`@bot --discord`) and
   * contains no needles — so the notice silently vanished from turn 3
   * onward. These blocks are byte-exact customer-facing business text, so
   * dropping one is a content-correctness defect with no visible symptom.
   *
   * `null` for a blob written before this field existed, and for a turn
   * whose own text genuinely named no variant. Readers degrade to the
   * prior job's `raw_text` (src/jobs/thread-context.ts), i.e. exactly the
   * pre-widening behaviour.
   */
  variantText: string | null;
}

/** Logical accounting buckets stored in usage_log.task (TEXT); `policy` is the policy_update job's rewrite call, and widening needs no migration. */
export type UsageTask = "compose" | "author" | "polish" | "policy";

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

/** The single stash-confirmed policy document used as the reader's last-known-good fallback. */
export interface PolicyLastKnownGoodRow {
  path: string;
  document: string;
  version: number;
  /** The exact response-header ETag, including quotes when supplied by HTTP. */
  etag: string;
  /** Epoch milliseconds when this document/version identity was confirmed. */
  confirmed_at: number;
}

export const TABLE_NAMES = {
  productRefs: "product_refs",
  productRefAliases: "product_ref_aliases",
  productRefVersions: "product_ref_versions",
  refDrafts: "ref_drafts",
  slackEventReceipts: "slack_event_receipts",
  jobs: "jobs",
  usageLog: "usage_log",
  policyLastKnownGood: "policy_last_known_good",
} as const;
