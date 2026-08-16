/**
 * Storage-semantics assertions for the claim/lease/fence mechanics issue
 * #10 adds on top of src/db/repos.ts's claimJobs/updateJobState — the
 * D1-engine-specific behavior CLAUDE.md says belongs on the Miniflare
 * tier, not createMockD1 (which evaluates no SQL).
 */
import { afterEach, describe, expect, it } from "vitest";
import { claimJobs, recordIncomingEvent, updateJobState, type RepoDeps } from "../../src/db/repos";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

describe("job claim/lease/fence semantics (issue #10)", () => {
  let env: TestEnvHandle | undefined;
  let clockMs = 1_700_000_000_000;
  let deps: RepoDeps;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    deps = { db: env.db, now: () => new Date(clockMs) };
  }

  async function seedJob(eventId: string) {
    const job = await recordIncomingEvent(deps, {
      eventId,
      eventType: "app_mention",
      kind: "reply",
      channelId: "C1",
      threadTs: "t1",
      actorUserId: "U1",
      rawText: eventId,
    });
    if (!job) throw new Error(`seedJob: ${eventId} was not created`);
    return job;
  }

  it("two concurrent claimers lease disjoint rows", async () => {
    await setup();
    await seedJob("ev-a");
    await seedJob("ev-b");
    await seedJob("ev-c");

    const [first, second] = await Promise.all([
      claimJobs(deps, { states: ["pending"], limit: 2, claimToken: "worker-1", claimTtlMs: 60_000 }),
      claimJobs(deps, { states: ["pending"], limit: 2, claimToken: "worker-2", claimTtlMs: 60_000 }),
    ]);

    const firstIds = new Set(first.map((job) => job.id));
    const secondIds = new Set(second.map((job) => job.id));

    // No overlap, whichever worker got which rows.
    for (const id of firstIds) expect(secondIds.has(id)).toBe(false);
    // Together they claimed every eligible row exactly once -- 3 rows
    // total, requested 2 each (4 > 3), so the database itself must have
    // serialized who got what rather than double-granting.
    expect(firstIds.size + secondIds.size).toBe(3);
    for (const job of [...first, ...second]) {
      expect(job.claim_token).toBe(firstIds.has(job.id) ? "worker-1" : "worker-2");
    }
  });

  it("re-claiming with the same token returns the same batch (retried claim)", async () => {
    await setup();
    await seedJob("ev-retry-a");
    await seedJob("ev-retry-b");
    await seedJob("ev-retry-other"); // must NOT show up in the retried batch

    const firstAttempt = await claimJobs(deps, {
      states: ["pending"],
      limit: 2,
      claimToken: "retry-token",
      claimTtlMs: 60_000,
    });
    expect(firstAttempt).toHaveLength(2);
    const firstIds = firstAttempt.map((job) => job.id).sort();

    // Simulate the caller not knowing whether the UPDATE above actually
    // landed (its response was lost) and retrying with the SAME token,
    // well within the lease -- no time advances here.
    const retried = await claimJobs(deps, {
      states: ["pending"],
      limit: 2,
      claimToken: "retry-token",
      claimTtlMs: 60_000,
    });

    expect(retried.map((job) => job.id).sort()).toEqual(firstIds);
    for (const job of retried) expect(job.claim_token).toBe("retry-token");
  });

  it("a different token cannot claim rows already leased to someone else", async () => {
    await setup();
    await seedJob("ev-live-lease");

    await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "owner", claimTtlMs: 60_000 });

    const stolen = await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "intruder", claimTtlMs: 60_000 });
    expect(stolen).toHaveLength(0);
  });

  it("an expired lease is reclaimable", async () => {
    await setup();
    const job = await seedJob("ev-expired");

    await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok-abandoned", claimTtlMs: 1_000 });
    clockMs += 5_000; // past the 1s lease

    const reclaimed = await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok-fresh", claimTtlMs: 60_000 });
    expect(reclaimed.map((row) => row.id)).toEqual([job.id]);
    expect(reclaimed[0]?.claim_token).toBe("tok-fresh");
  });

  it("failed jobs are claimable the same way pending jobs are", async () => {
    await setup();
    const job = await seedJob("ev-failed-retry");

    const [claimed] = await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok-1", claimTtlMs: 60_000 });
    expect(claimed?.id).toBe(job.id);

    // Park it in "failed" with a short backoff, as src/jobs/worker.ts's
    // recordFailure would.
    clockMs += 10;
    await updateJobState(deps, {
      id: job.id,
      claimToken: "tok-1",
      state: "failed",
      lastError: "boom",
      incrementAttempts: true,
      claimExpiresAt: clockMs + 1_000,
    });

    // Still within the backoff window -- not yet claimable.
    expect(
      await claimJobs(deps, { states: ["pending", "failed"], limit: 10, claimToken: "tok-2", claimTtlMs: 60_000 }),
    ).toHaveLength(0);

    clockMs += 2_000; // past the backoff
    const reclaimed = await claimJobs(deps, {
      states: ["pending", "failed"],
      limit: 10,
      claimToken: "tok-2",
      claimTtlMs: 60_000,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.id).toBe(job.id);
    expect(reclaimed[0]?.state).toBe("failed");
  });

  it("a fenced completion under a stale token matches zero rows and does not mark the job done", async () => {
    await setup();
    const job = await seedJob("ev-fenced");

    await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "stale-token", claimTtlMs: 1_000 });
    clockMs += 5_000; // stale-token's lease expires

    const [reclaimed] = await claimJobs(deps, {
      states: ["pending"],
      limit: 10,
      claimToken: "fresh-token",
      claimTtlMs: 60_000,
    });
    expect(reclaimed?.id).toBe(job.id);

    // The original (now-stale) claimant tries to complete the job it no
    // longer owns.
    const staleCompletion = await updateJobState(deps, {
      id: job.id,
      claimToken: "stale-token",
      state: "done",
    });
    expect(staleCompletion).toBe(false);

    const row = await env!.db.prepare("SELECT state, claim_token FROM jobs WHERE id = ?").bind(job.id).first<{
      state: string;
      claim_token: string;
    }>();
    expect(row?.state).not.toBe("done");
    expect(row?.claim_token).toBe("fresh-token");

    // The rightful (fresh-token) claimant can still complete it.
    const rightfulCompletion = await updateJobState(deps, {
      id: job.id,
      claimToken: "fresh-token",
      state: "done",
    });
    expect(rightfulCompletion).toBe(true);
  });

  it("updateJobState's claimExpiresAt is left untouched when omitted", async () => {
    await setup();
    const job = await seedJob("ev-preserve-lease");
    const [claimed] = await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok", claimTtlMs: 60_000 });
    const leaseBefore = claimed?.claim_expires_at;

    await updateJobState(deps, { id: job.id, claimToken: "tok", state: "composing" });

    const row = await env!.db.prepare("SELECT claim_expires_at FROM jobs WHERE id = ?").bind(job.id).first<{
      claim_expires_at: number;
    }>();
    expect(row?.claim_expires_at).toBe(leaseBefore);
  });
});
