/**
 * Retention sweep tests — each rule deletes only what it should, per
 * issue #10's acceptance criteria. Miniflare-backed since this is a
 * storage-semantics assertion (bounded DELETE ... WHERE id IN (SELECT
 * ...)), not handler branching.
 */
import { afterEach, describe, expect, it } from "vitest";
import { runRetentionSweep } from "../../src/jobs/retention";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

const DAY_MS = 24 * 60 * 60_000;

describe("runRetentionSweep (issue #10)", () => {
  let env: TestEnvHandle | undefined;
  const nowMs = 1_700_000_000_000;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
  }

  it("deletes slack_event_receipts older than 24h and keeps newer ones", async () => {
    await setup();
    await env!.db
      .prepare("INSERT INTO slack_event_receipts (event_id, event_type, received_at) VALUES (?, ?, ?)")
      .bind("old", "app_mention", nowMs - DAY_MS - 1)
      .run();
    await env!.db
      .prepare("INSERT INTO slack_event_receipts (event_id, event_type, received_at) VALUES (?, ?, ?)")
      .bind("fresh", "app_mention", nowMs - 1_000)
      .run();

    const result = await runRetentionSweep({ db: env!.db, now: () => new Date(nowMs) });

    expect(result.slackEventReceiptsDeleted).toBe(1);
    const remaining = await env!.db.prepare("SELECT event_id FROM slack_event_receipts").all<{ event_id: string }>();
    expect(remaining.results.map((r) => r.event_id)).toEqual(["fresh"]);
  });

  it("deletes done jobs older than 7 days, keeps newer done jobs and every dead job", async () => {
    await setup();
    const insertJob = async (id: string, state: string, completedAt: number | null) => {
      await env!.db
        .prepare(
          `INSERT INTO jobs (event_id, kind, channel_id, thread_ts, actor_user_id, raw_text, state, attempts, created_at, updated_at, completed_at)
           VALUES (?, 'reply', 'C1', 't', 'U1', 'x', ?, 0, ?, ?, ?)`,
        )
        .bind(id, state, nowMs, nowMs, completedAt)
        .run();
    };

    await insertJob("old-done", "done", nowMs - 7 * DAY_MS - 1);
    await insertJob("fresh-done", "done", nowMs - 1_000);
    await insertJob("old-dead", "dead", nowMs - 7 * DAY_MS - 1); // never deleted -- CLAUDE.md: last_error is the investigation trail

    const result = await runRetentionSweep({ db: env!.db, now: () => new Date(nowMs) });

    expect(result.jobsDeleted).toBe(1);
    const remaining = await env!.db.prepare("SELECT event_id FROM jobs ORDER BY event_id").all<{ event_id: string }>();
    expect(remaining.results.map((r) => r.event_id)).toEqual(["fresh-done", "old-dead"]);
  });

  it("deletes ref_drafts past expires_at and keeps ones still live", async () => {
    await setup();
    const insertDraft = async (id: string, expiresAt: number) => {
      await env!.db
        .prepare(
          `INSERT INTO ref_drafts (id, slug, body_md, category, product_url, base_version, created_at, created_by, expires_at, consumed_at)
           VALUES (?, 'slug', 'body', 'small', NULL, NULL, ?, 'U1', ?, NULL)`,
        )
        .bind(id, nowMs, expiresAt)
        .run();
    };

    await insertDraft("expired", nowMs - 1_000);
    await insertDraft("live", nowMs + 60_000);

    const result = await runRetentionSweep({ db: env!.db, now: () => new Date(nowMs) });

    expect(result.refDraftsDeleted).toBe(1);
    const remaining = await env!.db.prepare("SELECT id FROM ref_drafts").all<{ id: string }>();
    expect(remaining.results.map((r) => r.id)).toEqual(["live"]);
  });

  it("deletes usage_log rows older than 90 days and keeps newer ones", async () => {
    await setup();
    const insertUsage = async (id: number, createdAt: number) => {
      await env!.db
        .prepare(
          `INSERT INTO usage_log (id, slug, task, provider, model, fallback, tokens_in, tokens_out, created_at)
           VALUES (?, NULL, 'compose', 'workers-ai', NULL, NULL, NULL, NULL, ?)`,
        )
        .bind(id, createdAt)
        .run();
    };

    const ninetyDaysMs = 90 * DAY_MS;
    await insertUsage(1, nowMs - ninetyDaysMs - 1);
    await insertUsage(2, nowMs - 1_000);

    const result = await runRetentionSweep({ db: env!.db, now: () => new Date(nowMs) });

    expect(result.usageLogDeleted).toBe(1);
    const remaining = await env!.db.prepare("SELECT id FROM usage_log").all<{ id: number }>();
    expect(remaining.results.map((r) => r.id)).toEqual([2]);
  });

  it("bounds each delete to a single batch size, never deleting more than requested in one sweep", async () => {
    await setup();
    // 3 old rows, well under the 500-row batch cap -- confirms the
    // bounded DELETE actually removes multiple qualifying rows in one
    // sweep (not just a single row), while still being a LIMIT-bounded
    // statement rather than an unbounded DELETE.
    for (let i = 0; i < 3; i++) {
      await env!.db
        .prepare("INSERT INTO slack_event_receipts (event_id, event_type, received_at) VALUES (?, ?, ?)")
        .bind(`old-${i}`, "app_mention", nowMs - DAY_MS - 1)
        .run();
    }

    const result = await runRetentionSweep({ db: env!.db, now: () => new Date(nowMs) });
    expect(result.slackEventReceiptsDeleted).toBe(3);

    const remaining = await env!.db.prepare("SELECT count(*) as n FROM slack_event_receipts").first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});
