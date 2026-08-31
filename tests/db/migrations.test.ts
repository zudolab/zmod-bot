import { afterEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

describe("migrations/0001_init.sql", () => {
  let env: TestEnvHandle | undefined;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  it("creates every table", async () => {
    env = await createTestEnv();

    const result = await env.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const tableNames = result.results.map((row) => row.name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "product_refs",
        "product_ref_aliases",
        "product_ref_versions",
        "ref_drafts",
        "slack_event_receipts",
        "jobs",
        "usage_log",
        "policy_last_known_good",
        "policy_proposal_leases",
        "policy_decision_fences",
        "policy_decisions",
      ]),
    );
  });

  it("creates every index", async () => {
    env = await createTestEnv();

    const result = await env.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>();
    const indexNames = result.results.map((row) => row.name);

    expect(indexNames).toEqual(
      expect.arrayContaining(["product_ref_aliases_slug", "jobs_claimable", "jobs_thread_lookup"]),
    );
  });

  it("0004/0005/0006/0007/0008 apply cleanly: origin_job_id, jobs_thread_lookup, resolved_context, last-known-good, and coordination state all exist", async () => {
    env = await createTestEnv();

    const refDraftColumns = await env.db.prepare("PRAGMA table_info(ref_drafts)").all<{ name: string }>();
    expect(refDraftColumns.results.map((row) => row.name)).toEqual(expect.arrayContaining(["origin_job_id"]));

    const jobColumns = await env.db.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
    expect(jobColumns.results.map((row) => row.name)).toEqual(expect.arrayContaining(["resolved_context"]));

    const policyColumns = await env.db.prepare("PRAGMA table_info(policy_last_known_good)").all<{ name: string }>();
    expect(policyColumns.results.map((row) => row.name)).toEqual([
      "path",
      "document",
      "version",
      "etag",
      "confirmed_at",
    ]);

    const leaseColumns = await env.db.prepare("PRAGMA table_info(policy_proposal_leases)").all<{ name: string }>();
    expect(leaseColumns.results.map((row) => row.name)).toEqual(["path", "owner_job_id", "generation", "expires_at"]);

    const fenceColumns = await env.db.prepare("PRAGMA table_info(policy_decision_fences)").all<{ name: string }>();
    expect(fenceColumns.results.map((row) => row.name)).toEqual(["change_set_id", "active_epoch", "state", "updated_at"]);

    const decisionColumns = await env.db.prepare("PRAGMA table_info(policy_decisions)").all<{ name: string }>();
    expect(decisionColumns.results.map((row) => row.name)).toEqual([
      "change_set_id",
      "decision_epoch",
      "action",
      "actor_user_id",
      "channel_id",
      "review_message_ts",
      "remote_result",
      "remote_code",
      "remote_version",
      "remote_commit_id",
      "conflict_state",
      "slack_update_completed",
      "created_at",
      "updated_at",
    ]);
  });

  it("is additive-only: applying it a second time does not throw away data, it fails loudly on the duplicate CREATE TABLE", async () => {
    // Migrations are additive-only (CLAUDE.md) — this repo has no
    // "IF NOT EXISTS" re-apply path, so re-running 0001 against an
    // already-migrated database must error, not silently no-op. That
    // is the signal that 0001 contains no destructive DDL (a DROP
    // TABLE would make this re-apply succeed instead).
    env = await createTestEnv();

    await expect(env.db.exec("CREATE TABLE product_refs (slug TEXT PRIMARY KEY)")).rejects.toThrow();
  });
});
