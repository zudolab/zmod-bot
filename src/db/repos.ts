/**
 * D1 repositories. Every function takes its D1Database and clock as
 * injected options (CLAUDE.md "Dependency injection at every I/O
 * boundary") so it can be exercised against either test-tier: the
 * Map-backed `createMockD1` (src/db/test-support.ts) for handler
 * branching, or the Miniflare-backed `createTestEnv`
 * (tests/helpers/test-env.ts) for storage-semantics assertions.
 *
 * Implementation is issue #3's responsibility. This file only declares
 * the shapes issue #4 (refs/model.ts), #6 (slack/events.ts) and #10
 * (jobs/worker.ts) will call.
 */
import type { NowFn } from "../types";
import type {
  JobKind,
  JobRow,
  JobState,
  ProductCategory,
  ProductRefRow,
  ProductRefVersionRow,
} from "./schema";

export interface RepoDeps {
  db: D1Database;
  now: NowFn;
}

export interface RecordIncomingEventInput {
  eventId: string;
  kind: JobKind;
  channelId: string;
  threadTs: string | null;
  actorUserId: string;
  rawText: string;
}

/**
 * Writes the slack_event_receipts row (ON CONFLICT DO NOTHING) and the
 * jobs row in one db.batch(), per epic issue #1's durable-intent-before-
 * the-ack contract. Returns null when the receipt already existed (a
 * duplicate Slack delivery) — the caller still acks 200 in that case,
 * it just does not enqueue a second job.
 */
export async function recordIncomingEvent(
  deps: RepoDeps,
  input: RecordIncomingEventInput,
): Promise<JobRow | null> {
  throw new Error("not implemented: recordIncomingEvent");
}

export interface ClaimJobsInput {
  states: JobState[];
  limit: number;
  claimToken: string;
  claimTtlMs: number;
}

/** Atomically claims up to `limit` jobs in one of `states` for this delivery pass. */
export async function claimJobs(deps: RepoDeps, input: ClaimJobsInput): Promise<JobRow[]> {
  throw new Error("not implemented: claimJobs");
}

export interface UpdateJobStateInput {
  id: string;
  claimToken: string;
  state: JobState;
  lastError?: string | null;
}

/**
 * Advances a claimed job's state. Read `result.meta.changes` — `0` means
 * this claim lost the race (someone else's claim_token no longer
 * matches) and is not itself an error. See CLAUDE.md "Conventions".
 */
export async function updateJobState(deps: RepoDeps, input: UpdateJobStateInput): Promise<boolean> {
  throw new Error("not implemented: updateJobState");
}

export async function getProductRefBySlug(deps: RepoDeps, slug: string): Promise<ProductRefRow | null> {
  throw new Error("not implemented: getProductRefBySlug");
}

export async function findProductRefByAlias(deps: RepoDeps, alias: string): Promise<ProductRefRow | null> {
  throw new Error("not implemented: findProductRefByAlias");
}

export async function listProductRefs(deps: RepoDeps): Promise<ProductRefRow[]> {
  throw new Error("not implemented: listProductRefs");
}

export interface UpsertProductRefInput {
  slug: string;
  name: string;
  category: ProductCategory;
  productUrl: string;
  aliases: string[];
  body: string;
  changedByUserId: string;
}

/** Inserts or updates product_refs and appends a product_ref_versions row, incrementing `version`. */
export async function upsertProductRef(deps: RepoDeps, input: UpsertProductRefInput): Promise<ProductRefRow> {
  throw new Error("not implemented: upsertProductRef");
}

export async function listProductRefVersions(deps: RepoDeps, slug: string): Promise<ProductRefVersionRow[]> {
  throw new Error("not implemented: listProductRefVersions");
}

/** Restores `slug` to a prior `version`, recorded as a new version entry (never rewrites history in place). */
export async function restoreProductRefVersion(
  deps: RepoDeps,
  slug: string,
  version: number,
  actorUserId: string,
): Promise<ProductRefRow> {
  throw new Error("not implemented: restoreProductRefVersion");
}
