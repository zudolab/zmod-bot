import { afterEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import {
  adoptPolicyRollbackAttempt,
  PolicyRollbackAttemptMismatchError,
} from "./rollback-attempt-store";

describe("policy rollback attempt store", () => {
  let handle: TestEnvHandle | undefined;

  afterEach(async () => {
    await handle?.dispose();
    handle = undefined;
  });

  it("atomically preserves the first expected version across retry and concurrency", async () => {
    handle = await createTestEnv();
    let nowMs = 100;
    const deps = { db: handle.db, now: () => new Date(nowMs) };

    const raced = await Promise.all([
      adoptPolicyRollbackAttempt(deps, { jobId: 7, targetVersion: 2, expectedVersion: 8 }),
      adoptPolicyRollbackAttempt(deps, { jobId: 7, targetVersion: 2, expectedVersion: 9 }),
    ]);
    expect(new Set(raced.map(({ expected_version }) => expected_version)).size).toBe(1);
    const firstExpected = raced[0]!.expected_version;

    nowMs = 200;
    const retried = await adoptPolicyRollbackAttempt(deps, {
      jobId: 7,
      targetVersion: 2,
      expectedVersion: 99,
    });
    expect(retried).toMatchObject({
      job_id: 7,
      path: "policy/reply-guidance.md",
      target_version: 2,
      expected_version: firstExpected,
      created_at: 100,
      updated_at: 200,
    });
  });

  it("rejects a changed target without replacing the first attempt", async () => {
    handle = await createTestEnv();
    const deps = { db: handle.db, now: () => new Date(100) };
    await adoptPolicyRollbackAttempt(deps, { jobId: 8, targetVersion: 2, expectedVersion: 5 });

    await expect(adoptPolicyRollbackAttempt(deps, {
      jobId: 8,
      targetVersion: 3,
      expectedVersion: 5,
    })).rejects.toBeInstanceOf(PolicyRollbackAttemptMismatchError);

    const row = await handle.db.prepare("SELECT * FROM policy_rollback_attempts WHERE job_id = 8").first();
    expect(row).toMatchObject({ target_version: 2, expected_version: 5 });
  });
});
