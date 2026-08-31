import { afterEach, describe, expect, it } from "vitest";
import type { RepoDeps } from "../db/repos";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import { createMockD1 } from "../db/test-support";
import {
  acquirePolicyProposalLease,
  getPolicyProposalLease,
  markPolicyDecisionSlackUpdateComplete,
  recordPolicyDecision,
  recordPolicyDecisionRemoteResult,
  releasePolicyProposalLease,
  renewPolicyProposalLease,
} from "./coordination-store";

describe("policy coordination store", () => {
  let env: TestEnvHandle | undefined;
  let nowMs = 1_000;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
    nowMs = 1_000;
  });

  async function setup(): Promise<RepoDeps> {
    env = await createTestEnv();
    return { db: env.db, now: () => new Date(nowMs) };
  }

  it("serializes simultaneous proposal acquisition and fences owners by generation", async () => {
    const deps = await setup();

    const [first, second] = await Promise.all([
      acquirePolicyProposalLease(deps, { ownerJobId: 101, ttlMs: 100 }),
      acquirePolicyProposalLease(deps, { ownerJobId: 202, ttlMs: 100 }),
    ]);
    expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1);

    const winner = first.acquired ? first : second;
    const loser = first.acquired ? second : first;
    expect(winner.lease).toMatchObject({ owner_job_id: expect.any(Number), generation: 1, expires_at: 1_100 });
    expect(loser).toMatchObject({ acquired: false, lease: null, generation: null, expiresAt: null });

    const owner = winner.lease!.owner_job_id;
    expect(await acquirePolicyProposalLease(deps, { ownerJobId: owner, ttlMs: 100 })).toMatchObject({
      acquired: true,
      generation: 1,
    });
    expect(await renewPolicyProposalLease(deps, { ownerJobId: owner, generation: 999, ttlMs: 100 })).toBe(false);
    expect(await releasePolicyProposalLease(deps, { ownerJobId: owner, generation: 999 })).toBe(false);

    nowMs = 1_101;
    const reclaimed = await acquirePolicyProposalLease(deps, { ownerJobId: 303, ttlMs: 100 });
    expect(reclaimed).toMatchObject({ acquired: true, generation: 2, expiresAt: 1_201 });
    expect(await renewPolicyProposalLease(deps, { ownerJobId: owner, generation: 1, ttlMs: 100 })).toBe(false);
    expect(await releasePolicyProposalLease(deps, { ownerJobId: owner, generation: 1 })).toBe(false);
    expect(await releasePolicyProposalLease(deps, { ownerJobId: 303, generation: 2 })).toBe(true);
    expect(await getPolicyProposalLease(deps)).toMatchObject({ owner_job_id: 303, generation: 2, expires_at: 1_101 });

    nowMs = 1_102;
    expect(await acquirePolicyProposalLease(deps, { ownerJobId: 404, ttlMs: 100 })).toMatchObject({
      acquired: true,
      generation: 3,
    });
  });

  it("keeps competing decision clicks on one immutable active epoch and one job", async () => {
    const deps = await setup();

    const first = await recordPolicyDecision(deps, {
      changeSetId: "cs-1",
      action: "approve",
      actorUserId: "U_FIRST",
      channelId: "C_REVIEW",
      reviewMessageTs: "1700000000.000001",
      receiptId: "click-1",
    });
    expect(first).toMatchObject({
      receiptRecorded: true,
      fenceCreated: true,
      conflictReopened: false,
      decisionCreated: true,
      jobCreated: true,
      accepted: true,
      decisionEpoch: 1,
      eventId: "policy-decision:cs-1:1",
      decision: {
        action: "approve",
        actor_user_id: "U_FIRST",
        channel_id: "C_REVIEW",
        review_message_ts: "1700000000.000001",
        remote_result: "pending",
      },
      fence: { active_epoch: 1, state: "open" },
      reason: "created",
    });

    const competing = await recordPolicyDecision(deps, {
      changeSetId: "cs-1",
      action: "reject",
      actorUserId: "U_SECOND",
      channelId: "C_OTHER",
      reviewMessageTs: "1700000000.000099",
      receiptId: "click-2",
    });
    expect(competing).toMatchObject({
      receiptRecorded: true,
      decisionCreated: false,
      jobCreated: false,
      accepted: false,
      decisionEpoch: 1,
      reason: "active",
      decision: {
        action: "approve",
        actor_user_id: "U_FIRST",
        channel_id: "C_REVIEW",
        review_message_ts: "1700000000.000001",
      },
    });

    const duplicateClick = await recordPolicyDecision(deps, {
      changeSetId: "cs-1",
      action: "approve",
      actorUserId: "U_FIRST",
      channelId: "C_REVIEW",
      reviewMessageTs: "1700000000.000001",
      receiptId: "click-3",
    });
    expect(duplicateClick).toMatchObject({ receiptRecorded: true, decisionCreated: false, jobCreated: false });

    const jobs = await deps.db
      .prepare("SELECT event_id, kind FROM jobs WHERE event_id LIKE 'policy-decision:%' ORDER BY event_id")
      .all<{ event_id: string; kind: string }>();
    expect(jobs.results).toEqual([{ event_id: "policy-decision:cs-1:1", kind: "policy_decision" }]);

    const receipts = await deps.db
      .prepare("SELECT event_id FROM slack_event_receipts WHERE event_id LIKE 'click-%' ORDER BY event_id")
      .all<{ event_id: string }>();
    expect(receipts.results.map((row) => row.event_id)).toEqual(["click-1", "click-2", "click-3"]);
  });

  it("treats decision-created without job-created as an invariant failure", async () => {
    const db = createMockD1({
      onQuery: ({ query }) => {
        if (query.includes("INSERT INTO policy_decisions")) return { meta: { changes: 1 } };
        if (query.includes("INSERT INTO jobs")) return { meta: { changes: 0 } };
        return { meta: { changes: 1 } };
      },
    });
    await expect(recordPolicyDecision({ db, now: () => new Date(nowMs) }, {
      changeSetId: "cs-invariant",
      action: "approve",
      actorUserId: "U_ADMIN",
      channelId: "C_REVIEW",
      reviewMessageTs: "1.000001",
      receiptId: "click-invariant",
    })).rejects.toThrow("decision created without job");
  });

  it("reopens exactly one reject epoch after a delivered approval conflict", async () => {
    const deps = await setup();

    await recordPolicyDecision(deps, {
      changeSetId: "cs-conflict",
      action: "approve",
      actorUserId: "U_APPROVER",
      channelId: "C_REVIEW",
      reviewMessageTs: "1700000000.000001",
      receiptId: "conflict-click-1",
    });
    expect(
      (await recordPolicyDecisionRemoteResult(deps, {
        changeSetId: "cs-conflict",
        decisionEpoch: 1,
        result: "conflict",
        remoteCode: "commit-conflict",
      })).recorded,
    ).toBe(true);
    expect(
      (await recordPolicyDecisionRemoteResult(deps, {
        changeSetId: "cs-conflict",
        decisionEpoch: 1,
        result: "conflict",
      })).recorded,
    ).toBe(false);
    expect(
      (await recordPolicyDecision(deps, {
        changeSetId: "cs-conflict",
        action: "reject",
        actorUserId: "U_OTHER",
        channelId: "C_REVIEW",
        reviewMessageTs: "1700000000.000001",
        receiptId: "conflict-click-before-preview",
      })).reason,
    ).toBe("conflict-pending");
    nowMs = 1_100;
    const reopened = await markPolicyDecisionSlackUpdateComplete(deps, {
      changeSetId: "cs-conflict",
      decisionEpoch: 1,
    });
    expect(reopened).toMatchObject({ recorded: true, fenceUpdated: true, fence: { active_epoch: 1, state: "conflict_reopen" } });
    expect(
      (await markPolicyDecisionSlackUpdateComplete(deps, {
        changeSetId: "cs-conflict",
        decisionEpoch: 1,
      })).recorded,
    ).toBe(false);

    nowMs = 1_200;
    const replayedLosingReject = await recordPolicyDecision(deps, {
      changeSetId: "cs-conflict",
      action: "reject",
      actorUserId: "U_OTHER",
      channelId: "C_REVIEW",
      reviewMessageTs: "1700000000.000001",
      receiptId: "conflict-click-before-preview",
    });
    expect(replayedLosingReject).toMatchObject({
      receiptRecorded: false,
      conflictReopened: false,
      decisionCreated: false,
      jobCreated: false,
      decisionEpoch: 1,
    });

    const approveAgain = await recordPolicyDecision(deps, {
      changeSetId: "cs-conflict",
      action: "approve",
      actorUserId: "U_OTHER",
      channelId: "C_REVIEW",
      reviewMessageTs: "1700000000.000001",
      receiptId: "conflict-click-2",
    });
    expect(approveAgain).toMatchObject({ receiptRecorded: true, decisionCreated: false, jobCreated: false, reason: "conflict-approve-blocked" });

    nowMs = 1_300;
    const reject = await recordPolicyDecision(deps, {
      changeSetId: "cs-conflict",
      action: "reject",
      actorUserId: "U_REJECTOR",
      channelId: "C_REVIEW",
      reviewMessageTs: "1700000000.000001",
      receiptId: "conflict-click-3",
    });
    expect(reject).toMatchObject({ decisionCreated: true, jobCreated: true, decisionEpoch: 2, reason: "created" });

    const competingReject = await recordPolicyDecision(deps, {
      changeSetId: "cs-conflict",
      action: "reject",
      actorUserId: "U_OTHER_REJECTOR",
      channelId: "C_OTHER",
      reviewMessageTs: "1700000000.000002",
      receiptId: "conflict-click-4",
    });
    expect(competingReject).toMatchObject({ decisionCreated: false, jobCreated: false, decisionEpoch: 2 });
    expect(competingReject.decision).toMatchObject({ action: "reject", actor_user_id: "U_REJECTOR" });

    await recordPolicyDecisionRemoteResult(deps, {
      changeSetId: "cs-conflict",
      decisionEpoch: 2,
      result: "rejected",
      remoteCode: "change-set-rejected",
    });
    const closed = await markPolicyDecisionSlackUpdateComplete(deps, {
      changeSetId: "cs-conflict",
      decisionEpoch: 2,
    });
    expect(closed.fence).toMatchObject({ active_epoch: 2, state: "closed" });

    const afterClose = await recordPolicyDecision(deps, {
      changeSetId: "cs-conflict",
      action: "reject",
      actorUserId: "U_LATE",
      channelId: "C_REVIEW",
      reviewMessageTs: "1700000000.000001",
      receiptId: "conflict-click-5",
    });
    expect(afterClose).toMatchObject({ decisionCreated: false, jobCreated: false, decisionEpoch: 2, reason: "closed" });

    const jobs = await deps.db
      .prepare("SELECT event_id FROM jobs WHERE event_id LIKE 'policy-decision:cs-conflict:%' ORDER BY event_id")
      .all<{ event_id: string }>();
    expect(jobs.results.map((row) => row.event_id)).toEqual([
      "policy-decision:cs-conflict:1",
      "policy-decision:cs-conflict:2",
    ]);
  });

  it("permanently closes applied, expired, and closed terminal outcomes", async () => {
    const deps = await setup();

    for (const [changeSetId, result] of [
      ["cs-applied", "applied"],
      ["cs-expired", "expired"],
      ["cs-closed", "closed"],
    ] as const) {
      await recordPolicyDecision(deps, {
        changeSetId,
        action: "approve",
        actorUserId: "U_FIRST",
        channelId: "C_REVIEW",
        reviewMessageTs: "1700000000.000001",
        receiptId: `${changeSetId}-click-1`,
      });
      await recordPolicyDecisionRemoteResult(deps, { changeSetId, decisionEpoch: 1, result });
      const beforeSlack = await recordPolicyDecision(deps, {
        changeSetId,
        action: "reject",
        actorUserId: "U_BEFORE_SLACK",
        channelId: "C_OTHER",
        reviewMessageTs: "1700000000.000002",
        receiptId: `${changeSetId}-click-before-slack`,
      });
      expect(beforeSlack).toMatchObject({ decisionCreated: false, jobCreated: false, decisionEpoch: 1, reason: "closed" });
      const slack = await markPolicyDecisionSlackUpdateComplete(deps, { changeSetId, decisionEpoch: 1 });
      expect(slack.fence).toMatchObject({ active_epoch: 1, state: "closed" });

      const late = await recordPolicyDecision(deps, {
        changeSetId,
        action: "reject",
        actorUserId: "U_LATE",
        channelId: "C_OTHER",
        reviewMessageTs: "1700000000.000002",
        receiptId: `${changeSetId}-click-2`,
      });
      expect(late).toMatchObject({ decisionCreated: false, jobCreated: false, decisionEpoch: 1, reason: "closed" });
    }
  });

  it("rolls back every statement in an injected failing batch", async () => {
    const deps = await setup();

    await expect(
      deps.db.batch([
        deps.db
          .prepare(
            "INSERT INTO slack_event_receipts (event_id, event_type, received_at) VALUES (?, ?, ?)",
          )
          .bind("rollback-click", "policy_decision_click", nowMs),
        deps.db.prepare("INSERT INTO table_that_does_not_exist (value) VALUES (?)").bind("fail"),
      ]),
    ).rejects.toThrow();

    const receipt = await deps.db
      .prepare("SELECT event_id FROM slack_event_receipts WHERE event_id = ?")
      .bind("rollback-click")
      .first<{ event_id: string }>();
    expect(receipt).toBeNull();
  });
});
