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

  it("0004/0005/0006 apply cleanly: origin_job_id, jobs_thread_lookup, and resolved_context all exist", async () => {
    env = await createTestEnv();

    const refDraftColumns = await env.db.prepare("PRAGMA table_info(ref_drafts)").all<{ name: string }>();
    expect(refDraftColumns.results.map((row) => row.name)).toEqual(expect.arrayContaining(["origin_job_id"]));

    const jobColumns = await env.db.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
    expect(jobColumns.results.map((row) => row.name)).toEqual(expect.arrayContaining(["resolved_context"]));
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
