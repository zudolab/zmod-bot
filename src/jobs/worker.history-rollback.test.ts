import { afterEach, describe, expect, it, vi } from "vitest";
import { recordIncomingEvent } from "../db/repos";
import type { Env } from "../env";
import type { HistoryPage, StashApi } from "../stash/api";
import type { FetchLike } from "../types";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import { runDeliveryPass } from "./worker";

const NOW = new Date("2026-08-31T00:00:00.000Z");
const PATH = "policy/reply-guidance.md";

function stash(overrides: Partial<StashApi>): StashApi {
  return {
    getFile: async () => { throw new Error("unused getFile"); },
    getHistory: async () => { throw new Error("unused getHistory"); },
    rollback: async () => { throw new Error("unused rollback"); },
    ...overrides,
  } as unknown as StashApi;
}

function historyPage(): HistoryPage {
  return {
    path: PATH,
    headVersion: 1,
    deleted: false,
    total: 1,
    versions: [{ version: 1, kind: "put", hash: "hash", rollbackOf: null, createdAt: NOW.toISOString() }],
    nextBefore: null,
  };
}

describe("stash policy command delivery lifecycle", () => {
  let handle: TestEnvHandle | undefined;

  afterEach(async () => {
    await handle?.dispose();
    handle = undefined;
    vi.restoreAllMocks();
  });

  async function setup(rawText: string) {
    handle = await createTestEnv();
    const now = () => NOW;
    const env = {
      DB: handle.db,
      SLACK_BOT_USER_ID: "U_BOT",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_ADMIN_USER_IDS: "U_ADMIN",
      STASH_BASE_URL: "https://stash.example",
      STASH_NAME: "policy",
      STASH_READ_TOKEN: `zhs_${"r".repeat(43)}`,
      STASH_WRITE_TOKEN: `zhs_${"w".repeat(43)}`,
    } as unknown as Env;
    const job = await recordIncomingEvent({ db: handle.db, now }, {
      eventId: `event-${rawText}`,
      eventType: "app_mention",
      kind: "policy_update",
      channelId: "C_POLICY",
      threadTs: "100.001",
      actorUserId: "U_ADMIN",
      rawText,
    });
    if (job === null) throw new Error("test job was not created");
    const posts: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, channel: "C_POLICY", ts: "200.001" });
    });
    return { env, now, job, fetch, posts };
  }

  it.each(["history", "rollback 1"])("keeps exact policy %s pending through I/O and completes directly", async (command) => {
    const { env, now, job, fetch, posts } = await setup(`<@U_BOT> policy ${command}`);
    let release!: (value: unknown) => void;
    const suspended = new Promise<unknown>((resolve) => { release = resolve; });
    const getHistory = vi.fn(() => suspended as Promise<HistoryPage>);
    const getFile = vi.fn(() => suspended as ReturnType<StashApi["getFile"]>);
    const rollback = vi.fn(async () => ({
      commitId: `cmt_${"1".repeat(13)}${"a".repeat(8)}`,
      version: 2,
      hash: "hash",
      rollbackOf: 1,
      identicalToHead: true,
      changeId: 2,
      createdAt: NOW.toISOString(),
    }));
    const api = command === "history" ? stash({ getHistory }) : stash({ getFile, rollback });
    const delivery = runDeliveryPass({ env, fetch, now, stashApi: api, invalidatePolicyCache: vi.fn() });
    await vi.waitFor(() => expect(command === "history" ? getHistory : getFile).toHaveBeenCalledOnce());

    const inFlight = await handle!.db.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.id).first<{ state: string }>();
    expect(inFlight?.state).toBe("pending");

    release(command === "history" ? historyPage() : {
      kind: "file",
      file: { path: PATH, version: 1, body: null, responseEtag: '"v1"', stashVersion: 1 },
    });
    await expect(delivery).resolves.toMatchObject({ succeeded: 1 });
    expect((await handle!.db.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.id).first<{ state: string }>())?.state).toBe("done");
    expect(posts).toHaveLength(1);

    // Crash window after Slack success but before the direct completion write.
    await handle!.db.prepare(
      "UPDATE jobs SET state = 'pending', completed_at = NULL, claim_token = NULL, claim_expires_at = NULL WHERE id = ?",
    ).bind(job.id).run();
    await runDeliveryPass({ env, fetch, now, stashApi: api, invalidatePolicyCache: vi.fn() });
    expect((await handle!.db.prepare("SELECT state FROM jobs WHERE id = ?").bind(job.id).first<{ state: string }>())?.state).toBe("done");
    expect(posts).toHaveLength(2);
  });

  it("parks an exact history failure from pending into reclaimable failed", async () => {
    const { env, now, job, fetch } = await setup("<@U_BOT> policy history");
    const api = stash({ getHistory: vi.fn(async () => { throw new Error("transport failed"); }) });

    await expect(runDeliveryPass({ env, fetch, now, stashApi: api })).resolves.toMatchObject({ failed: 1 });
    const row = await handle!.db.prepare("SELECT state, attempts FROM jobs WHERE id = ?").bind(job.id).first<{ state: string; attempts: number }>();
    expect(row).toEqual({ state: "failed", attempts: 1 });
  });
});
