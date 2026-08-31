import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "../db/schema";
import { recordIncomingEvent } from "../db/repos";
import { recordPolicyDecision } from "../stash/coordination-store";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import type { Env } from "../env";
import type { FetchLike } from "../types";
import { POLICY_HEADER, POLICY_REQUIRED_HEADINGS } from "./contract";
import {
  runStashPolicyProposal,
  type PolicyProposalUpdateFn,
  type StashPolicyProposalDeps,
} from "./proposal";
import { runDeliveryPass, runJob } from "../jobs/worker";
import { StashTransportError, type ChangeSet, type ChangeSetDiffResult, type StashApi } from "../stash/api";

const CHANGE_SET_ID = "chs_0000000000001abcdef12";
const CURRENT = [
  POLICY_HEADER,
  POLICY_REQUIRED_HEADINGS[0],
  "丁寧な文体にします。",
  POLICY_REQUIRED_HEADINGS[1],
  "段落を分けます。",
  POLICY_REQUIRED_HEADINGS[2],
  "現行の追加ガイダンスです。",
  "",
].join("\n");
const CANDIDATE = `${CURRENT}新しいガイダンスです。\n`;

function changeSet(id = CHANGE_SET_ID): ChangeSet {
  return {
    id,
    status: "open",
    expiresAt: new Date(10_000_000).toISOString(),
    commitId: null,
    entries: [{ path: "policy/reply-guidance.md", op: "put", baseVersion: 7, stale: false }],
  };
}

function diff(): ChangeSetDiffResult {
  return {
    entries: [{
      path: "policy/reply-guidance.md",
      op: "put",
      stale: false,
      diff: { state: "ready", unified: "@@ -1 +1 @@\n-old\n+new\n", truncated: false },
    }],
    stale: false,
    status: "open",
    truncated: false,
  };
}

interface FakeStash {
  api: StashApi;
  listInputs: Array<Parameters<StashApi["listChangeSets"]>[0]>;
  fileInputs: Array<Parameters<StashApi["getFile"]>[0]>;
  createInputs: Array<Parameters<StashApi["createChangeSet"]>[0]>;
  diffInputs: Array<Parameters<StashApi["getChangeSetDiff"]>[0]>;
  openSets: ChangeSet[];
  pages?: Array<{ changeSets: ChangeSet[]; nextAfter: string | null; total: number }>;
}

function fakeStash(): FakeStash {
  const result: FakeStash = {
    api: undefined as unknown as StashApi,
    listInputs: [],
    fileInputs: [],
    createInputs: [],
    diffInputs: [],
    openSets: [],
  };
  result.api = {
    listChangeSets: async (input) => {
      result.listInputs.push(input);
      if (result.pages !== undefined) {
        const index = input.after === undefined ? 0 : Number(input.after);
        return result.pages[index] ?? { changeSets: [], nextAfter: null, total: 0 };
      }
      return { changeSets: result.openSets, nextAfter: null, total: result.openSets.length };
    },
    getFile: async (input = {}) => {
      result.fileInputs.push(input);
      return {
        kind: "file",
        file: {
          path: "policy/reply-guidance.md",
          version: 7,
          body: CURRENT,
          responseEtag: '"v7"',
          stashVersion: 7,
        },
      };
    },
    createChangeSet: async (input) => {
      result.createInputs.push(input);
      const created = changeSet();
      result.openSets.push(created);
      return created;
    },
    getChangeSetDiff: async (input) => {
      result.diffInputs.push(input);
      return diff();
    },
    getChangeSet: async () => changeSet(),
    approveChangeSet: async () => ({ status: "applied", commit: { id: "cmt_0000000000001abcdef12", entries: [] } }),
    rejectChangeSet: async () => changeSet(),
    getHistory: async () => ({ path: "policy/reply-guidance.md", headVersion: 7, deleted: false, total: 0, versions: [], nextBefore: null }),
    rollback: async () => ({ commitId: "cmt_0000000000001abcdef12", version: 8, hash: "hash", rollbackOf: 7, identicalToHead: false, changeId: 1, createdAt: new Date(1).toISOString() }),
  };
  return result;
}

function env(db: D1Database): Env {
  return {
    DB: db,
    AI: {} as Ai,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "secret",
    ANTHROPIC_API_KEY: "anthropic-test",
    STASH_BASE_URL: "https://stash.invalid",
    STASH_NAME: "policy",
    STASH_READ_TOKEN: "zhs_read",
    STASH_WRITE_TOKEN: "zhs_write",
    SLACK_BOT_USER_ID: "U_BOT",
    SLACK_ALLOWED_CHANNEL_IDS: "",
    SLACK_ADMIN_USER_IDS: "U_ADMIN",
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    SITE_API_BASE: "https://example.com",
  };
}

const fetch: FetchLike = (async () => Response.json({})) as FetchLike;

function policyJob(id: number): JobRow {
  return {
    id,
    event_id: `policy-${id}`,
    kind: "policy_update",
    channel_id: "C_POLICY",
    thread_ts: "100.001",
    actor_user_id: "U_ADMIN",
    raw_text: "<@U_BOT> policy 調整してください",
    state: "pending",
    attempts: 0,
    claim_token: null,
    claim_expires_at: null,
    last_error: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    resolved_context: null,
  };
}

describe("stash policy proposal orchestration", () => {
  let testEnv: TestEnvHandle | undefined;
  let nowMs = 1_000;

  beforeEach(async () => {
    testEnv = await createTestEnv();
  });

  afterEach(async () => {
    await testEnv?.dispose();
    testEnv = undefined;
    nowMs = 1_000;
  });

  function deps(fake: FakeStash, updatePolicy?: PolicyProposalUpdateFn): StashPolicyProposalDeps {
    return { env: env(testEnv!.db), fetch, now: () => new Date(nowMs), stashApi: fake.api, updatePolicy };
  }

  it("scans every page with status=all, then binds one authoritative head to the editor and create", async () => {
    const fake = fakeStash();
    fake.pages = [
      { changeSets: [], nextAfter: "1", total: 3 },
      { changeSets: [{ ...changeSet("chs_0000000000002abcdef12"), status: "rejected" }], nextAfter: "2", total: 3 },
      { changeSets: [], nextAfter: null, total: 3 },
    ];
    const updatePolicy: PolicyProposalUpdateFn = async (_deps, input) => {
      expect(input).toEqual({ currentDocument: CURRENT, request: "調整してください" });
      return { kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" };
    };

    const result = await runStashPolicyProposal(deps(fake, updatePolicy), { jobId: 42, request: "調整してください" });

    expect(result.kind).toBe("created");
    expect(fake.listInputs).toHaveLength(3);
    expect(fake.listInputs.map((input) => input.status)).toEqual(["all", "all", "all"]);
    expect(fake.listInputs.map((input) => input.path)).toEqual([
      "policy/reply-guidance.md",
      "policy/reply-guidance.md",
      "policy/reply-guidance.md",
    ]);
    expect(fake.fileInputs).toHaveLength(1);
    expect(fake.createInputs).toHaveLength(1);
    expect(fake.createInputs[0]).toMatchObject({
      jobId: "42",
      path: "policy/reply-guidance.md",
      body: CANDIDATE,
      baseVersion: 7,
      contentType: "text/markdown; charset=utf-8",
      expiresAt: new Date(nowMs + 72 * 60 * 60 * 1_000).toISOString(),
    });
    expect(fake.createInputs[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fake.fileInputs[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fake.diffInputs[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the existing-open response without an editor, head read, or create", async () => {
    const fake = fakeStash();
    const existing = changeSet();
    fake.openSets.push(existing);
    let editorCalls = 0;
    const result = await runStashPolicyProposal(deps(fake, async () => {
      editorCalls++;
      return { kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" };
    }), { jobId: 43, request: "調整してください" });

    expect(result).toMatchObject({ kind: "existing", changeSet: existing });
    expect(editorCalls).toBe(0);
    expect(fake.fileInputs).toHaveLength(0);
    expect(fake.createInputs).toHaveLength(0);
    expect(fake.diffInputs).toHaveLength(1);
    expect(JSON.stringify(result.payload)).toContain("既存のポリシー変更案がオープン中です。");
    expect(JSON.stringify(result.payload)).toContain("policy_approve");
    expect(JSON.stringify(result.payload)).toContain("policy_reject");
  });

  it("points to the original review without advertising fresh buttons once a decision epoch exists", async () => {
    const fake = fakeStash();
    fake.openSets.push(changeSet());
    await recordPolicyDecision(
      { db: testEnv!.db, now: () => new Date(nowMs) },
      {
        changeSetId: CHANGE_SET_ID,
        action: "approve",
        actorUserId: "U_ADMIN",
        channelId: "C_POLICY",
        reviewMessageTs: "100.001",
        receiptId: "existing-decision",
      },
    );

    const result = await runStashPolicyProposal(deps(fake, async () => {
      throw new Error("editor must not run");
    }), { jobId: 45, request: "調整してください" });

    expect(result.kind).toBe("existing");
    expect(fake.diffInputs).toHaveLength(0);
    expect(JSON.stringify(result.payload)).toContain("元のレビューを確認してください");
    expect(JSON.stringify(result.payload)).not.toContain("policy_approve");
    expect(JSON.stringify(result.payload)).not.toContain("policy_reject");
  });

  it.each([
    ["empty", ""],
    ["missing required structure", `${POLICY_HEADER}\nnot the required headings\n`],
    ["over the policy byte limit", `${CURRENT}${"x".repeat(8_193)}`],
  ])("refuses a %s authoritative head before the editor", async (_name, body) => {
    const fake = fakeStash();
    fake.api.getFile = async (input = {}) => {
      fake.fileInputs.push(input);
      return {
        kind: "file",
        file: {
          path: "policy/reply-guidance.md",
          version: 7,
          body,
          responseEtag: '"v7"',
          stashVersion: 7,
        },
      };
    };
    let editorCalls = 0;

    const result = await runStashPolicyProposal(deps(fake, async () => {
      editorCalls++;
      return { kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" };
    }), { jobId: 44, request: "調整してください" });

    expect(result.kind).toBe("refused");
    expect(editorCalls).toBe(0);
    expect(fake.createInputs).toHaveLength(0);
  });

  it("single-flights simultaneous jobs before the editor", async () => {
    const fake = fakeStash();
    let editorCalls = 0;
    let editorStarted!: () => void;
    const started = new Promise<void>((resolve) => { editorStarted = resolve; });
    let releaseEditor!: () => void;
    const editorGate = new Promise<void>((resolve) => { releaseEditor = resolve; });
    const updatePolicy: PolicyProposalUpdateFn = async () => {
      editorCalls++;
      editorStarted();
      await editorGate;
      return { kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" };
    };

    const first = runStashPolicyProposal(deps(fake, updatePolicy), { jobId: 51, request: "調整" });
    await started;
    const second = await runStashPolicyProposal(deps(fake, updatePolicy), { jobId: 52, request: "調整" });
    expect(second.kind).toBe("in_progress");
    expect(editorCalls).toBe(1);
    releaseEditor();
    const firstResult = await first;
    expect(firstResult.kind).toBe("created");
    expect(fake.createInputs).toHaveLength(1);
  });

  it("fences a stale editor after another job reclaims the expired generation", async () => {
    const fake = fakeStash();
    let editorStarted!: () => void;
    const started = new Promise<void>((resolve) => { editorStarted = resolve; });
    let releaseEditor!: () => void;
    const editorGate = new Promise<void>((resolve) => { releaseEditor = resolve; });
    let editorCalls = 0;
    const updatePolicy: PolicyProposalUpdateFn = async () => {
      editorCalls++;
      if (editorCalls === 1) {
        editorStarted();
        await editorGate;
      }
      return { kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" };
    };

    const first = runStashPolicyProposal(deps(fake, updatePolicy), { jobId: 61, request: "調整" });
    await started;
    nowMs = 1_000 + 90_001;
    const second = await runStashPolicyProposal(deps(fake, updatePolicy), { jobId: 62, request: "調整" });
    expect(second.kind).toBe("created");
    releaseEditor();
    const firstResult = await first;
    expect(firstResult.kind).toBe("in_progress");
    expect(fake.createInputs).toHaveLength(1);
  });

  it("retries after create by re-listing the open set without rerunning the editor", async () => {
    const fake = fakeStash();
    let editorCalls = 0;
    const updatePolicy: PolicyProposalUpdateFn = async () => {
      editorCalls++;
      return { kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" };
    };
    const first = await runStashPolicyProposal(deps(fake, updatePolicy), { jobId: 71, request: "調整" });
    const second = await runStashPolicyProposal(deps(fake, updatePolicy), { jobId: 71, request: "調整" });

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("existing");
    expect(editorCalls).toBe(1);
    expect(fake.createInputs).toHaveLength(1);
    expect(fake.fileInputs).toHaveLength(1);
    expect(fake.diffInputs).toHaveLength(2);
    expect(JSON.stringify(second.payload)).toContain("policy_approve");
  });

  it("keeps a stash proposal reclaimable and reconstructs review after a lost create response", async () => {
    const fake = fakeStash();
    let editorCalls = 0;
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let createStarted!: () => void;
    const createObserved = new Promise<void>((resolve) => { createStarted = resolve; });
    fake.api.createChangeSet = async (input) => {
      fake.createInputs.push(input);
      fake.openSets.push(changeSet());
      createStarted();
      await createGate;
      throw new StashTransportError();
    };

    const job = await recordIncomingEvent(
      { db: testEnv!.db, now: () => new Date(nowMs) },
      {
        eventId: "policy-create-response-loss",
        eventType: "app_mention",
        kind: "policy_update",
        channelId: "C_POLICY",
        threadTs: "100.001",
        actorUserId: "U_ADMIN",
        rawText: "<@U_BOT> policy 調整してください",
      },
    );
    if (job === null) throw new Error("test job was not created");
    const posts: Record<string, unknown>[] = [];
    const slackFetch = vi.fn<FetchLike>(async (_input, init) => {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, channel: "C_POLICY", ts: "200.001" });
    });
    const updatePolicy: PolicyProposalUpdateFn = async () => {
      editorCalls++;
      return { kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" };
    };

    const firstPass = runDeliveryPass({
      env: env(testEnv!.db),
      fetch: slackFetch,
      now: () => new Date(nowMs),
      stashApi: fake.api,
      updatePolicy,
    });
    await createObserved;
    const inFlight = await testEnv!.db.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.id).first<{ state: string }>();
    expect(inFlight?.state).toBe("pending");
    releaseCreate();
    await expect(firstPass).resolves.toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(posts).toHaveLength(0);

    nowMs += 31 * 60_000;
    const secondPass = await runDeliveryPass({
      env: env(testEnv!.db),
      fetch: slackFetch,
      now: () => new Date(nowMs),
      stashApi: fake.api,
      updatePolicy,
    });

    expect(secondPass).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(editorCalls).toBe(1);
    expect(fake.createInputs).toHaveLength(1);
    expect(fake.diffInputs).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).toContain("policy_approve");
    expect((await testEnv!.db.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.id).first<{ state: string }>())?.state).toBe("done");
  });

  it.each([
    ["non-ready", {
      ...diff(),
      entries: [{
        path: "policy/reply-guidance.md" as const,
        op: "put" as const,
        stale: false,
        diff: { state: "same" as const },
      }],
    }],
    ["stale", {
      ...diff(),
      stale: true,
    }],
    ["truncated", {
      ...diff(),
      entries: [{
        path: "policy/reply-guidance.md" as const,
        op: "put" as const,
        stale: false,
        diff: { state: "ready" as const, unified: "@@ -1 +1 @@\n-old\n+new\n", truncated: true },
      }],
    }],
  ] satisfies Array<[string, ChangeSetDiffResult]>)
    ("refuses a %s remote diff instead of offering a blind approval", async (_name, unsafeDiff) => {
      const fake = fakeStash();
      fake.api.getChangeSetDiff = async (input) => {
        fake.diffInputs.push(input);
        return unsafeDiff;
      };

      const result = await runStashPolicyProposal(
        deps(fake, async () => ({ kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" })),
        { jobId: 72, request: "調整してください" },
      );

      expect(result.kind).toBe("refused");
      expect(fake.createInputs).toHaveLength(1);
      expect(JSON.stringify(result.payload)).not.toContain("policy_approve");
      expect(JSON.stringify(result.payload)).not.toContain("policy_reject");
    });

  it("selects the stash route in the worker only when both selectors are non-empty", async () => {
    const fake = fakeStash();
    const posts: Record<string, unknown>[] = [];
    const slackFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://slack.com/api/chat.postMessage");
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, channel: "C_POLICY", ts: "200.001" });
    }) as FetchLike;
    const workerEnv = env(testEnv!.db);
    await runJob(workerEnv, policyJob(81), {
      fetch: slackFetch,
      now: () => new Date(nowMs),
      stashApi: fake.api,
      updatePolicy: async () => ({ kind: "accepted", document: CANDIDATE, provider: "claude", model: "test" }),
    });

    expect(fake.createInputs).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).toContain("@@ -1 +1 @@");
  });
});
