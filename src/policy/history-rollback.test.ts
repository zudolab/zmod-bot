import { describe, expect, it, vi } from "vitest";
import { createMockD1 } from "../db/test-support";
import type { Env } from "../env";
import type { FetchLike } from "../types";
import {
  StashApiError,
  createStashApi,
  type HistoryPage,
  type NormalizedStashErrorCode,
  type RollbackResult,
  type StashApi,
} from "../stash/api";
import { createFakeStash } from "../stash/test-support";
import {
  POLICY_HISTORY_MAX_ITEMS,
  POLICY_HISTORY_MAX_PAGES,
  POLICY_HISTORY_PAGE_SIZE,
  POLICY_HISTORY_SCAN_DEADLINE_MS,
  runPolicyHistoryRollback,
} from "./history-rollback";

const PATH = "policy/reply-guidance.md";
const READ = `zhs_${"r".repeat(43)}`;
const WRITE = `zhs_${"w".repeat(43)}`;
const NOW = new Date("2026-08-31T00:00:00.000Z");

function env(overrides: Partial<Env> = {}): Env {
  const rollbackAttempts = new Map<number, {
    job_id: number;
    path: string;
    target_version: number;
    expected_version: number;
    created_at: number;
    updated_at: number;
  }>();
  return {
    DB: createMockD1({
      onQuery: ({ query, bindings }) => {
        if (!query.includes("INSERT INTO policy_rollback_attempts")) return undefined;
        const [jobId, path, targetVersion, expectedVersion, createdAt, updatedAt] = bindings as [number, string, number, number, number, number];
        const existing = rollbackAttempts.get(jobId);
        if (existing !== undefined && (existing.path !== path || existing.target_version !== targetVersion)) {
          return { results: [] };
        }
        const row = existing === undefined
          ? { job_id: jobId, path, target_version: targetVersion, expected_version: expectedVersion, created_at: createdAt, updated_at: updatedAt }
          : { ...existing, updated_at: updatedAt };
        rollbackAttempts.set(jobId, row);
        return { results: [row], meta: { changes: 1 } };
      },
    }),
    AI: {} as Ai,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "secret",
    ANTHROPIC_API_KEY: "anthropic-test",
    GITHUB_TOKEN: "github-test",
    SLACK_BOT_USER_ID: "U_BOT",
    SLACK_ALLOWED_CHANNEL_IDS: "",
    SLACK_ADMIN_USER_IDS: "U_ADMIN",
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    SITE_API_BASE: "https://example.com",
    GITHUB_REPO: "zudolab/zmod-bot",
    STASH_BASE_URL: "https://stash.example",
    STASH_NAME: "policy",
    STASH_READ_TOKEN: READ,
    STASH_WRITE_TOKEN: WRITE,
    ...overrides,
  };
}

const fetch = (async () => Response.json({ ok: true })) as FetchLike;
const now = () => NOW;

function stash(overrides: Partial<StashApi>): StashApi {
  return {
    getFile: async () => { throw new Error("unused getFile"); },
    createChangeSet: async () => { throw new Error("unused createChangeSet"); },
    listChangeSets: async () => { throw new Error("unused listChangeSets"); },
    getChangeSet: async () => { throw new Error("unused getChangeSet"); },
    getChangeSetDiff: async () => { throw new Error("unused getChangeSetDiff"); },
    approveChangeSet: async () => { throw new Error("unused approveChangeSet"); },
    rejectChangeSet: async () => { throw new Error("unused rejectChangeSet"); },
    getHistory: async () => { throw new Error("unused getHistory"); },
    rollback: async () => { throw new Error("unused rollback"); },
    ...overrides,
  };
}

function page(
  versions: HistoryPage["versions"],
  nextBefore: number | null,
  overrides: Partial<HistoryPage> = {},
): HistoryPage {
  return {
    path: PATH,
    headVersion: 3,
    deleted: false,
    total: 3,
    versions,
    nextBefore,
    ...overrides,
  };
}

function version(version: number, kind: HistoryPage["versions"][number]["kind"] = "put") {
  return { version, kind, hash: `hash-${version}`, rollbackOf: kind === "rollback" ? Math.max(1, version - 1) : null, createdAt: NOW.toISOString() };
}

function textFromPayload(payload: { blocks: unknown[] }): string {
  return JSON.stringify(payload.blocks);
}

describe("runPolicyHistoryRollback", () => {
  it("paginates history with the exact path and renders only bounded safe version metadata", async () => {
    const getHistory = vi.fn()
      .mockResolvedValueOnce(page([version(3), version(2)], 2))
      .mockResolvedValueOnce(page([version(1, "rollback")], null));
    const result = await runPolicyHistoryRollback(
      { env: env(), fetch, now, stashApi: stash({ getHistory }) },
      { jobId: 7, command: { operation: "history" } },
    );

    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(getHistory.mock.calls[0]?.[0]).toMatchObject({ path: PATH, limit: POLICY_HISTORY_PAGE_SIZE });
    expect(getHistory.mock.calls[0]?.[0]).not.toHaveProperty("before");
    expect(getHistory.mock.calls[1]?.[0]).toMatchObject({ path: PATH, limit: POLICY_HISTORY_PAGE_SIZE, before: 2 });
    const rendered = textFromPayload(result);
    expect(rendered).toContain("v3");
    expect(rendered).toContain("v2");
    expect(rendered).toContain("v1");
    expect(rendered).toContain("ロールバック");
    expect(rendered).not.toContain("hash-3");
    expect(rendered).not.toContain("body");
  });

  it("refuses a repeated cursor instead of looping", async () => {
    const getHistory = vi.fn()
      .mockResolvedValueOnce(page([version(3)], 2))
      .mockResolvedValueOnce(page([version(2)], 2));
    const result = await runPolicyHistoryRollback(
      { env: env(), fetch, now, stashApi: stash({ getHistory }) },
      { jobId: 7, command: { operation: "history" } },
    );

    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(textFromPayload(result)).toContain("完了できませんでした");
  });

  it("rejects a never-resolving history request at the deadline for durable retry", async () => {
    vi.useFakeTimers();
    try {
      const pending = runPolicyHistoryRollback(
        { env: env(), fetch, now, stashApi: stash({ getHistory: () => new Promise(() => {}) }) },
        { jobId: 7, command: { operation: "history" } },
      );
      const rejection = expect(pending).rejects.toThrow("stash operation deadline exceeded");
      await vi.advanceTimersByTimeAsync(POLICY_HISTORY_SCAN_DEADLINE_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces page and aggregate item bounds", async () => {
    const oversizedPage = vi.fn().mockResolvedValue(
      page(Array.from({ length: POLICY_HISTORY_PAGE_SIZE + 1 }, (_, index) => version(index + 1)), null),
    );
    const pageResult = await runPolicyHistoryRollback(
      { env: env(), fetch, now, stashApi: stash({ getHistory: oversizedPage }) },
      { jobId: 7, command: { operation: "history" } },
    );
    expect(textFromPayload(pageResult)).toContain("完了できませんでした");

    const boundedPages = vi.fn(async (input: { before?: number }) => {
      const pageNumber = input.before ?? 0;
      const nextBefore = pageNumber + 1 >= POLICY_HISTORY_MAX_PAGES ? pageNumber + 1 : pageNumber + 1;
      return page(
        Array.from({ length: POLICY_HISTORY_PAGE_SIZE }, (_, index) => version(POLICY_HISTORY_MAX_ITEMS - (pageNumber * POLICY_HISTORY_PAGE_SIZE + index))),
        nextBefore,
      );
    });
    const boundedResult = await runPolicyHistoryRollback(
      { env: env(), fetch, now, stashApi: stash({ getHistory: boundedPages }) },
      { jobId: 7, command: { operation: "history" } },
    );
    expect(boundedPages.mock.calls.length).toBeLessThanOrEqual(POLICY_HISTORY_MAX_PAGES);
    expect(textFromPayload(boundedResult)).toContain("一部のみ表示");
  });

  it("gets the authoritative head, posts exact rollback fields with the job key, and invalidates only after success", async () => {
    const getFile = vi.fn<StashApi["getFile"]>(async () => ({
      kind: "file" as const,
      file: { path: PATH, version: 2, body: "secret policy body", responseEtag: '"v2-hash"', stashVersion: 2 } as const,
    }));
    const rollback = vi.fn<StashApi["rollback"]>(async () => ({
      commitId: `cmt_${"1".repeat(13)}${"a".repeat(8)}`,
      version: 3,
      hash: "new-hash",
      rollbackOf: 1,
      identicalToHead: false,
      changeId: 9,
      createdAt: NOW.toISOString(),
    } satisfies RollbackResult));
    const invalidate = vi.fn();
    const result = await runPolicyHistoryRollback(
      { env: env(), fetch, now, stashApi: stash({ getFile, rollback }), invalidatePolicyCache: invalidate },
      { jobId: 7, command: { operation: "rollback", version: 1 } },
    );

    expect(getFile).toHaveBeenCalledWith(expect.objectContaining({ path: PATH, signal: expect.any(AbortSignal) }));
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({
      path: PATH,
      toVersion: 1,
      expectedVersion: 2,
      jobId: "7",
      signal: expect.any(AbortSignal),
    }));
    expect(rollback.mock.calls[0]?.[0]).not.toHaveProperty("author");
    expect(rollback.mock.calls[0]?.[0]).not.toHaveProperty("message");
    expect(invalidate).toHaveBeenCalledOnce();
    expect(textFromPayload(result)).toContain("新しいバージョンは v3");
    expect(textFromPayload(result)).not.toContain("secret policy body");
  });

  it("maps stale rollback failures to terminal Japanese guidance without invalidating the cache", async () => {
    const invalidate = vi.fn();
    const rollback = vi.fn<StashApi["rollback"]>(async () => {
      throw new StashApiError(409, "stale");
    });
    const result = await runPolicyHistoryRollback(
      {
        env: env(),
        fetch,
        now,
        stashApi: stash({
          getFile: async () => ({
            kind: "file" as const,
            file: { path: PATH, version: 2, body: null, responseEtag: '"v2-hash"', stashVersion: 2 } as const,
          }),
          rollback,
        }),
        invalidatePolicyCache: invalidate,
      },
      { jobId: 7, command: { operation: "rollback", version: 1 } },
    );

    expect(rollback).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
    expect(textFromPayload(result)).toContain("更新されている");
    expect(textFromPayload(result)).not.toContain("Stash API request failed");
  });

  it.each([
    [404, "not-found", "対象のポリシーまたはバージョンが見つかりませんでした。"],
    [404, "version-not-found", "対象のポリシーまたはバージョンが見つかりませんでした。"],
    [403, "scope", "Stashへのアクセス権限を確認してください。"],
    [429, "rate-limited", "Stashの利用制限に達しました。"],
    [500, "internal", "Stashで処理できませんでした。"],
    [501, "unknown", "Stash側でこの操作は利用できません。"],
    [500, "scope", "Stashへのアクセス権限を確認してください。"],
    [403, "rate-limited", "Stashの利用制限に達しました。"],
    [429, "internal", "Stashで処理できませんでした。"],
    [418, "unknown", "Stash側でこの操作は利用できません。"],
  ] as Array<[number, NormalizedStashErrorCode, string]>)
    ("maps normalized stash error %s/%s without exposing upstream details", async (status, code, expected) => {
      const rollback = vi.fn<StashApi["rollback"]>(async () => {
        throw new StashApiError(status, code);
      });
      const result = await runPolicyHistoryRollback(
        {
          env: env(),
          fetch,
          now,
          stashApi: stash({
            getFile: async () => ({
              kind: "file" as const,
              file: { path: PATH, version: 2, body: null, responseEtag: '"v2-hash"', stashVersion: 2 } as const,
            }),
            rollback,
          }),
        },
        { jobId: 7, command: { operation: "rollback", version: 1 } },
      );

      expect(textFromPayload(result)).toContain(expected);
      expect(textFromPayload(result)).not.toContain("Stash API request failed");
    });

  it("replays the durable first request after response loss and an intervening write", async () => {
    const remote = createFakeStash({ now, readToken: READ, writeToken: WRITE });
    let loseResponse = true;
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await remote.fetch(input, init);
      if (loseResponse && init?.method === "POST" && String(input).includes("/rollback/")) {
        loseResponse = false;
        throw new Error("response lost after remote rollback committed");
      }
      return response;
    }) as FetchLike;
    const stashApi = createStashApi({
      baseUrl: "https://stash.example",
      stash: "policy",
      readToken: READ,
      writeToken: WRITE,
      fetch: transport,
    });
    const invalidate = vi.fn();
    const input = { jobId: 7, command: { operation: "rollback" as const, version: 1 } };
    const deps = { env: env(), fetch, now, stashApi, invalidatePolicyCache: invalidate };

    await expect(runPolicyHistoryRollback(deps, input)).rejects.toMatchObject({ status: 0, code: "unknown" });
    await stashApi.rollback({ path: PATH, toVersion: 1, expectedVersion: 2, jobId: "intervening" });
    const replayed = await runPolicyHistoryRollback(deps, input);

    expect(textFromPayload(replayed)).toContain("新しいバージョンは v2");
    expect(invalidate).toHaveBeenCalledOnce();
    expect(remote.state.files.get(PATH)?.versions).toHaveLength(3);
    expect(remote.state.events.filter((event) => event.type === "change")).toHaveLength(2);
    const jobPosts = remote.calls.filter(({ url, headers }) =>
      url.includes("/rollback/policy/reply-guidance.md") && headers["idempotency-key"] === "policy-job-7"
    );
    expect(jobPosts).toHaveLength(2);
    expect(jobPosts.map(({ body }) => body)).toEqual([
      JSON.stringify({ toVersion: 1, expectedVersion: 1 }),
      JSON.stringify({ toVersion: 1, expectedVersion: 1 }),
    ]);
  });

  it("does not treat an existing matching rollback as recovered on the first attempt", async () => {
    const remote = createFakeStash({ now, readToken: READ, writeToken: WRITE });
    const stashApi = createStashApi({
      baseUrl: "https://stash.example",
      stash: "policy",
      readToken: READ,
      writeToken: WRITE,
      fetch: remote.fetch,
    });
    await stashApi.rollback({ path: PATH, toVersion: 1, expectedVersion: 1 });

    const result = await runPolicyHistoryRollback(
      { env: env(), fetch, now, stashApi, invalidatePolicyCache: vi.fn() },
      { jobId: 7, command: { operation: "rollback", version: 1 } },
    );

    expect(textFromPayload(result)).toContain("新しいバージョンは v3");
    expect(remote.state.files.get(PATH)?.versions).toHaveLength(3);
    expect(remote.state.events.filter((event) => event.type === "change")).toHaveLength(2);
  });

  it("refuses stash-only commands before touching an injected client when write routing is absent", async () => {
    const getHistory = vi.fn();
    const result = await runPolicyHistoryRollback(
      { env: env({ STASH_BASE_URL: "", STASH_WRITE_TOKEN: "" }), fetch, now, stashApi: stash({ getHistory }) },
      { jobId: 7, command: { operation: "history" } },
    );

    expect(getHistory).not.toHaveBeenCalled();
    expect(textFromPayload(result)).toContain("設定が不足");
  });
});
