import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import type { RepoDeps } from "../db/repos";
import type { PolicyDecisionRow } from "../db/schema";
import { StashApiError, type ChangeSet, type StashApi } from "../stash/api";
import {
  getPolicyDecision,
  getPolicyDecisionFence,
  markPolicyDecisionSlackUpdateComplete,
  recordPolicyDecision,
  recordPolicyDecisionRemoteResult,
} from "../stash/coordination-store";
import type { FetchLike } from "../types";
import { ACTION_IDS } from "../slack/commands";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import { runDeliveryPass } from "./worker";

const CHANGE_SET_ID = `chs_${"1".repeat(13)}${"a".repeat(8)}`;
let nowMs = 10_000;

function changeSet(status: ChangeSet["status"]): ChangeSet {
  return {
    id: CHANGE_SET_ID,
    status,
    expiresAt: new Date(99_999_999).toISOString(),
    commitId: status === "applied" ? `cmt_${"1".repeat(13)}${"a".repeat(8)}` : null,
    entries: [{ path: "policy/reply-guidance.md", op: "put", baseVersion: 1, stale: false }],
  };
}

function fakeStash(overrides: Partial<StashApi>): StashApi {
  return {
    getChangeSet: vi.fn(async () => changeSet("open")),
    approveChangeSet: vi.fn(async () => ({
      status: "applied",
      commit: {
        id: `cmt_${"1".repeat(13)}${"b".repeat(8)}`,
        entries: [{ path: "policy/reply-guidance.md", version: 2, kind: "put" }],
      },
    })),
    rejectChangeSet: vi.fn(async () => changeSet("rejected")),
    ...overrides,
  } as unknown as StashApi;
}

function slackFetch(options: { failAfterEffectOnce?: boolean } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let failed = false;
  const fetch = vi.fn<FetchLike>(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    if (options.failAfterEffectOnce && !failed) {
      failed = true;
      throw new Error("response lost after Slack applied update");
    }
    return Response.json({ ok: true });
  });
  return { fetch, calls };
}

describe("policy decision delivery", () => {
  let handle: TestEnvHandle | undefined;
  let env: Env;
  let repo: RepoDeps;

  afterEach(async () => {
    await handle?.dispose();
    handle = undefined;
    nowMs = 10_000;
    vi.restoreAllMocks();
  });

  async function setup() {
    handle = await createTestEnv();
    repo = { db: handle.db, now: () => new Date(nowMs) };
    env = {
      DB: handle.db,
      SLACK_BOT_TOKEN: "xoxb-test",
      STASH_BASE_URL: "https://example.com",
      STASH_NAME: "policy-live",
      STASH_READ_TOKEN: `zhs_${"r".repeat(43)}`,
      STASH_WRITE_TOKEN: `zhs_${"w".repeat(43)}`,
    } as unknown as Env;
  }

  async function intake(action: "approve" | "reject", receipt = `click-${action}`, actor = "U_ADMIN") {
    return recordPolicyDecision(repo, {
      changeSetId: CHANGE_SET_ID,
      action,
      actorUserId: actor,
      channelId: "C_REVIEW",
      reviewMessageTs: "1700000000.000001",
      receiptId: receipt,
    });
  }

  async function decision(epoch = 1): Promise<PolicyDecisionRow> {
    const value = await getPolicyDecision(repo, CHANGE_SET_ID, epoch);
    if (value === null) throw new Error("missing test decision");
    return value;
  }

  it("racing delivery passes perform one approve, one convergent update, and direct pending-to-done bookkeeping", async () => {
    await setup();
    await intake("approve");
    const approveChangeSet = vi.fn(async () => ({
      status: "applied" as const,
      commit: {
        id: `cmt_${"1".repeat(13)}${"b".repeat(8)}`,
        entries: [{ path: "policy/reply-guidance.md" as const, version: 2, kind: "put" as const }],
      },
    }));
    const stash = fakeStash({ approveChangeSet });
    const slack = slackFetch();
    const invalidate = vi.fn();

    const results = await Promise.all([
      runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash, invalidatePolicyCache: invalidate }),
      runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash, invalidatePolicyCache: invalidate }),
    ]);

    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(approveChangeSet).toHaveBeenCalledOnce();
    expect(approveChangeSet).toHaveBeenCalledWith({ id: CHANGE_SET_ID });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(slack.calls.map((call) => call.url)).toEqual(["https://slack.com/api/chat.update"]);
    expect(slack.calls[0]?.body).toMatchObject({ channel: "C_REVIEW", ts: "1700000000.000001" });
    expect(slack.calls.some((call) => call.url.endsWith("chat.postMessage"))).toBe(false);
    const row = await handle!.db.prepare("SELECT state FROM jobs WHERE kind = 'policy_decision'").first<{ state: string }>();
    expect(row?.state).toBe("done");
    expect((await decision()).slack_update_completed).toBe(1);
  });

  it("remains reclaimable pending while remote I/O is suspended, never composing or delivering", async () => {
    await setup();
    await intake("approve");
    let release!: (value: ChangeSet) => void;
    const pendingStatus = new Promise<ChangeSet>((resolve) => { release = resolve; });
    const stash = fakeStash({ getChangeSet: vi.fn(() => pendingStatus) });
    const delivery = runDeliveryPass({ env, fetch: slackFetch().fetch, now: repo.now, stashApi: stash });
    await vi.waitFor(() => expect(stash.getChangeSet).toHaveBeenCalledOnce());

    const inFlight = await handle!.db
      .prepare("SELECT state FROM jobs WHERE kind = 'policy_decision'")
      .first<{ state: string }>();
    expect(inFlight?.state).toBe("pending");

    release(changeSet("open"));
    await expect(delivery).resolves.toMatchObject({ succeeded: 1 });
    const completed = await handle!.db
      .prepare("SELECT state FROM jobs WHERE kind = 'policy_decision'")
      .first<{ state: string }>();
    expect(completed?.state).toBe("done");
  });

  it("silently repairs an applied replay without a second approve or cache invalidation", async () => {
    await setup();
    await intake("approve");
    const approve = vi.fn();
    const stash = fakeStash({
      getChangeSet: vi.fn(async () => changeSet("applied")),
      approveChangeSet: approve,
    });
    const slack = slackFetch();
    const invalidate = vi.fn();

    await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash, invalidatePolicyCache: invalidate });

    expect(approve).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect((await decision()).remote_result).toBe("applied");
    expect(slack.calls).toHaveLength(1);
  });

  it.each([
    [409, undefined],
    [409, [{ path: "policy/reply-guidance.md", expectedVersion: 2 }]],
    [404, [{ path: "policy/reply-guidance.md", expectedVersion: 2 }]],
  ] as const)("treats commit-conflict status %i shape %# as terminal and permits one fresh reject", async (status, conflicts) => {
    await setup();
    await intake("approve");
    const approve = vi.fn(async () => { throw new StashApiError(status, "commit-conflict", conflicts); });
    const reject = vi.fn(async () => changeSet("rejected"));
    const stash = fakeStash({ approveChangeSet: approve, rejectChangeSet: reject });
    const slack = slackFetch();

    await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash });
    expect((await decision()).remote_result).toBe("conflict");
    expect(await getPolicyDecisionFence(repo, CHANGE_SET_ID)).toMatchObject({ state: "conflict_reopen" });
    expect(approve).toHaveBeenCalledOnce();
    expect(JSON.stringify(slack.calls[0]?.body.blocks)).toContain(ACTION_IDS.policyReject);
    expect(JSON.stringify(slack.calls[0]?.body.blocks)).not.toContain(ACTION_IDS.policyApprove);

    nowMs += 1;
    const reopened = await intake("reject", `fresh-reject-${status}-${conflicts?.length ?? 0}`, "U_REJECTOR");
    expect(reopened).toMatchObject({ jobCreated: true, decisionEpoch: 2 });
    await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash });
    expect(reject).toHaveBeenCalledOnce();
    expect((await decision(2)).remote_result).toBe("rejected");
    expect(await getPolicyDecisionFence(repo, CHANGE_SET_ID)).toMatchObject({ state: "closed" });
    const third = await intake("reject", `late-${status}-${conflicts?.length ?? 0}`);
    expect(third.jobCreated).toBe(false);
  });

  it("preserves expired-open reject asymmetry while approve expires without a mutation", async () => {
    await setup();
    await intake("approve", "approve-expired");
    const approve = vi.fn();
    const stash = fakeStash({
      getChangeSet: vi.fn(async () => changeSet("expired")),
      approveChangeSet: approve,
    });
    await runDeliveryPass({ env, fetch: slackFetch().fetch, now: repo.now, stashApi: stash });
    expect(approve).not.toHaveBeenCalled();
    expect((await decision()).remote_result).toBe("expired");

    // A separate change set keeps the test's permanently closed fence independent.
    await handle!.db.exec("DELETE FROM jobs; DELETE FROM policy_decisions; DELETE FROM policy_decision_fences; DELETE FROM slack_event_receipts;");
    nowMs += 1;
    await intake("reject", "reject-expired");
    const reject = vi.fn(async () => changeSet("rejected"));
    const rejectStash = fakeStash({ getChangeSet: vi.fn(async () => changeSet("expired")), rejectChangeSet: reject });
    await runDeliveryPass({ env, fetch: slackFetch().fetch, now: repo.now, stashApi: rejectStash });
    expect(reject).toHaveBeenCalledOnce();
    expect((await decision()).remote_result).toBe("rejected");
  });

  it("treats change-set-closed as terminal success without a mutation", async () => {
    await setup();
    await intake("approve");
    const approve = vi.fn();
    const stash = fakeStash({
      getChangeSet: vi.fn(async () => { throw new StashApiError(409, "change-set-closed"); }),
      approveChangeSet: approve,
    });
    const result = await runDeliveryPass({ env, fetch: slackFetch().fetch, now: repo.now, stashApi: stash });
    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(approve).not.toHaveBeenCalled();
    expect((await decision()).remote_result).toBe("closed");
  });

  it("recovers after remote effect but before persistence by pre-reading applied status", async () => {
    await setup();
    await intake("approve");
    let applied = false;
    const approve = vi.fn(async () => {
      applied = true;
      throw new StashApiError(0, "unknown");
    });
    const stash = fakeStash({
      getChangeSet: vi.fn(async () => changeSet(applied ? "applied" : "open")),
      approveChangeSet: approve,
    });
    const slack = slackFetch();

    expect(await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash })).toMatchObject({ failed: 1 });
    nowMs += 31 * 60_000;
    expect(await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash })).toMatchObject({ succeeded: 1 });
    expect(approve).toHaveBeenCalledOnce();
    expect((await decision()).remote_result).toBe("applied");
  });

  it("resumes after persisted remote result, repeated Slack update, and durable Slack completion", async () => {
    await setup();
    await intake("approve");
    await recordPolicyDecisionRemoteResult(repo, {
      changeSetId: CHANGE_SET_ID,
      decisionEpoch: 1,
      result: "applied",
    });
    const stash = fakeStash({ getChangeSet: vi.fn(), approveChangeSet: vi.fn() });
    const slack = slackFetch({ failAfterEffectOnce: true });

    expect(await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash })).toMatchObject({ failed: 1 });
    nowMs += 31 * 60_000;
    expect(await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash })).toMatchObject({ succeeded: 1 });
    expect(slack.calls).toHaveLength(2);
    expect(slack.calls[0]?.body).toEqual(slack.calls[1]?.body);
    expect(stash.getChangeSet).not.toHaveBeenCalled();

    // Simulate the final crash point: Slack/outbox complete, job bookkeeping not yet done.
    await handle!.db.prepare("UPDATE jobs SET state = 'pending', completed_at = NULL, claim_token = NULL, claim_expires_at = NULL WHERE kind = 'policy_decision'").run();
    await markPolicyDecisionSlackUpdateComplete(repo, { changeSetId: CHANGE_SET_ID, decisionEpoch: 1 });
    const before = slack.calls.length;
    await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash });
    expect(slack.calls).toHaveLength(before);
    const row = await handle!.db.prepare("SELECT state FROM jobs WHERE kind = 'policy_decision'").first<{ state: string }>();
    expect(row?.state).toBe("done");
  });

  it.each([
    [401, "unauthorized"],
    [403, "unknown"],
    [404, "not-found"],
    [429, "rate-limited"],
    [500, "internal"],
    [501, "unknown"],
  ] as const)("bounds operational %i/%s, updates in place, and parks for retry", async (status, code) => {
    await setup();
    await intake("approve");
    const stash = fakeStash({ getChangeSet: vi.fn(async () => { throw new StashApiError(status, code); }) });
    const slack = slackFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runDeliveryPass({ env, fetch: slack.fetch, now: repo.now, stashApi: stash });
    expect(result).toMatchObject({ failed: 1 });
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]?.url).toBe("https://slack.com/api/chat.update");
    expect(JSON.stringify(slack.calls[0]?.body)).toContain(`status=${status}`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("policy/reply-guidance");
    const row = await handle!.db.prepare("SELECT state, attempts FROM jobs WHERE kind = 'policy_decision'").first<{ state: string; attempts: number }>();
    expect(row).toEqual({ state: "failed", attempts: 1 });
  });
});
