import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../types";
import {
  StashApiError,
  StashConfigurationError,
  createStashApi,
  type StashApi,
} from "./api";
import { createFakeStash, type FakeConflict } from "./test-support";

const READ = `zhs_${"r".repeat(43)}`;
const WRITE = `zhs_${"w".repeat(43)}`;
const BASE = "https://stash.invalid";
const PATH = "policy/reply-guidance.md";
const clock = { value: new Date("2026-08-31T00:00:00.000Z") };

function setup(options: { rateLimit?: number | { read?: number; write?: number; diff?: number } } = {}) {
  const fake = createFakeStash({ now: () => clock.value, readToken: READ, writeToken: WRITE, ...options });
  const api = createStashApi({ baseUrl: `${BASE}///`, stash: "policy", readToken: READ, writeToken: WRITE, fetch: fake.fetch });
  return { api, fake };
}

function responseFetch(response: Response | (() => Response), calls: string[] = []): FetchLike {
  return (async (input) => {
    calls.push(String(input));
    return typeof response === "function" ? response() : response;
  }) as FetchLike;
}

function apiWithFetch(fetch: FetchLike, overrides: Partial<Parameters<typeof createStashApi>[0]> = {}): StashApi {
  return createStashApi({ baseUrl: BASE, stash: "policy", readToken: READ, writeToken: WRITE, fetch, ...overrides });
}

function putBody(body = "Updated policy\n") {
  return { jobId: "42", body, baseVersion: 1, author: "Takazudo", message: "Policy update" };
}

async function createSet(api: StashApi, jobId = "42", body = "Updated policy\n") {
  return api.createChangeSet({ ...putBody(body), jobId });
}

afterEach(() => {
  clock.value = new Date("2026-08-31T00:00:00.000Z");
  vi.restoreAllMocks();
});

describe("stash API configuration and assertions", () => {
  it("normalizes an https origin and rejects every malformed base/stash before fetch", async () => {
    const calls: string[] = [];
    const fetch = responseFetch(new Response("{}"), calls);
    const invalid = [
      { baseUrl: "", stash: "policy" },
      { baseUrl: "http://stash.invalid", stash: "policy" },
      { baseUrl: "https://stash.invalid/path", stash: "policy" },
      { baseUrl: " https://stash.invalid", stash: "policy" },
      { baseUrl: BASE, stash: "Policy" },
      { baseUrl: BASE, stash: "-policy" },
      { baseUrl: BASE, stash: "p".repeat(64) },
    ];
    for (const candidate of invalid) {
      expect(() => createStashApi({ ...candidate, readToken: READ, writeToken: WRITE, fetch })).toThrow(StashConfigurationError);
    }
    expect(calls).toEqual([]);
  });

  it("requires exact 43-character zhs_ tokens route-by-route with zero calls", async () => {
    for (const token of [undefined, "", "admin-shaped", `zhs_${"x".repeat(42)}`, `zhs_${"x".repeat(44)}`, `zhs_${"+".repeat(43)}`]) {
      const calls: string[] = [];
      const readApi = apiWithFetch(responseFetch(new Response("{}"), calls), { readToken: token });
      await expect(readApi.getFile()).rejects.toBeInstanceOf(StashConfigurationError);
      const writeApi = apiWithFetch(responseFetch(new Response("{}"), calls), { writeToken: token });
      await expect(writeApi.createChangeSet(putBody())).rejects.toBeInstanceOf(StashConfigurationError);
      expect(calls).toEqual([]);
    }
  });

  it("refuses non-policy paths, unsafe job ids, bad limits, ids, versions, and ETags before fetch", async () => {
    const calls: string[] = [];
    const api = apiWithFetch(responseFetch(new Response("{}"), calls));
    await expect(api.getFile({ path: `${PATH}.bak` })).rejects.toBeInstanceOf(StashConfigurationError);
    await expect(api.getFile({ ifNoneMatch: "v1-unquoted" })).rejects.toBeInstanceOf(StashConfigurationError);
    await expect(api.createChangeSet({ ...putBody(), jobId: "unsafe/id" })).rejects.toBeInstanceOf(StashConfigurationError);
    await expect(api.listChangeSets({ status: "all", limit: 0 })).rejects.toBeInstanceOf(StashConfigurationError);
    await expect(api.getChangeSet({ id: "chs_bad" })).rejects.toBeInstanceOf(StashConfigurationError);
    await expect(api.rollback({ toVersion: 0, expectedVersion: 1 })).rejects.toBeInstanceOf(StashConfigurationError);
    await expect(api.rollback({ toVersion: 1, expectedVersion: 1, jobId: "unsafe/id" })).rejects.toBeInstanceOf(StashConfigurationError);
    expect(calls).toEqual([]);
  });
});

describe("stash API requests and successes", () => {
  it("maps every GET to the read token and every POST to the write token with exact JSON Content-Type", async () => {
    const { api, fake } = setup();
    await api.getFile();
    const created = await createSet(api);
    await api.listChangeSets({ status: "all", limit: 20 });
    await api.getChangeSet({ id: created.id });
    await api.getChangeSetDiff({ id: created.id, path: PATH, context: 3 });
    await api.rejectChangeSet({ id: created.id });

    const second = await createSet(api, "43");
    await api.approveChangeSet({ id: second.id });
    await api.getHistory({ limit: 20 });
    await api.rollback({ toVersion: 1, expectedVersion: 2 });

    for (const call of fake.calls) {
      expect(call.headers.authorization).toBe(`Bearer ${call.method === "GET" ? READ : WRITE}`);
      if (call.method === "POST") expect(call.headers["content-type"]).toBe("application/json");
    }
    expect(fake.calls.every(({ url }) => url.startsWith(`${BASE}/v1/`))).toBe(true);
  });

  it("serializes the exact one-entry create body, expiry, content type, and stable job idempotency key", async () => {
    const { api, fake } = setup();
    const expiresAt = "2026-09-03T00:00:00.000Z";
    await api.createChangeSet({ ...putBody(), jobId: "job_7.safe", expiresAt });
    const call = fake.calls.at(-1)!;
    expect(call.headers["idempotency-key"]).toBe("policy-job-job_7.safe");
    expect(call.body).toBe(JSON.stringify({
      entries: [{ op: "put", path: PATH, baseVersion: 1, body: "Updated policy\n", contentType: "text/markdown; charset=utf-8" }],
      author: "Takazudo",
      message: "Policy update",
      expiresAt,
    }));
  });

  it("preserves the quoted response-header ETag on both 200 and bodyless 304", async () => {
    const { api, fake } = setup();
    const first = await api.getFile();
    expect(first.kind).toBe("file");
    if (first.kind !== "file") throw new Error("expected file");
    expect(first.file.responseEtag).toMatch(/^"v1-/);
    expect(first.file.stashVersion).toBe(1);
    const conditional = await api.getFile({ ifNoneMatch: first.file.responseEtag });
    expect(conditional).toEqual({ kind: "not-modified", responseEtag: first.file.responseEtag, stashVersion: 1 });
    expect(fake.calls.at(-1)?.headers["if-none-match"]).toBe(first.file.responseEtag);
  });

  it("forwards the caller's abort signal without adding another transport", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const { fake } = setup();
    const fetch = (async (input, init) => {
      seen = init?.signal;
      return fake.fetch(input, init);
    }) as FetchLike;
    const api = apiWithFetch(fetch);
    await api.getFile({ signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it("accepts body:null without confusing the JSON etag with the response-header ETag", async () => {
    const { api, fake } = setup();
    fake.state.files.get(PATH)!.inline = false;
    const result = await api.getFile();
    expect(result).toMatchObject({ kind: "file", file: { body: null, responseEtag: expect.stringMatching(/^"/) } });
    if (result.kind === "file") expect(result.file.responseEtag).not.toBe(fake.state.files.get(PATH)!.versions[0]?.hash);
  });

  it("paginates open/all lists with exact query fields and exposes computed expiry", async () => {
    const { api, fake } = setup();
    const expiring = await api.createChangeSet({ ...putBody(), jobId: "1", expiresAt: new Date(clock.value.getTime() + 1).toISOString() });
    await api.createChangeSet({ ...putBody("other"), jobId: "2", path: PATH });
    const all = await api.listChangeSets({ status: "all", path: PATH, limit: 1 });
    expect(all).toMatchObject({ total: 2, changeSets: [{ status: "open" }] });
    expect(all.nextAfter).toBeTruthy();
    expect(fake.calls.at(-1)?.url).toContain(`status=all&path=${encodeURIComponent(PATH)}&limit=1`);
    await api.listChangeSets({ status: "all", path: PATH, limit: 1, after: all.nextAfter! });
    expect(fake.calls.at(-1)?.url).toContain(`&after=${encodeURIComponent(all.nextAfter!)}`);
    clock.value = new Date(Date.parse(expiring.expiresAt));
    expect((await api.getChangeSet({ id: expiring.id })).status).toBe("expired");
    expect((await api.listChangeSets({ status: "open", limit: 20 })).changeSets.every(({ status }) => status === "open")).toBe(true);
  });

  it("validates and returns preview diff fields, approve replay, reject, history, and rollback", async () => {
    const { api, fake } = setup();
    const created = await createSet(api);
    const diff = await api.getChangeSetDiff({ id: created.id, path: PATH, context: 2 });
    expect(diff).toMatchObject({ status: "open", stale: false, truncated: false, entries: [{ path: PATH, op: "put", stale: false, diff: { state: "ready", unified: expect.any(String), truncated: false } }] });
    const approved = await api.approveChangeSet({ id: created.id, message: "approved" });
    const eventCount = fake.state.events.length;
    expect(await api.approveChangeSet({ id: created.id })).toEqual(approved);
    expect(fake.state.events).toHaveLength(eventCount);

    const rejectedSet = await createSet(api, "reject", "another");
    expect((await api.rejectChangeSet({ id: rejectedSet.id, reason: "superseded" })).status).toBe("rejected");
    const history = await api.getHistory({ limit: 1 });
    expect(history).toMatchObject({ path: PATH, headVersion: 2, versions: [{ version: 2 }], nextBefore: 2 });
    expect(fake.calls.at(-1)?.url).toContain(`limit=1`);
    const older = await api.getHistory({ limit: 1, before: history.nextBefore! });
    expect(older).toMatchObject({ versions: [{ version: 1 }], nextBefore: null });
    expect(fake.calls.at(-1)?.url).toContain("limit=1&before=2");
    const rollback = await api.rollback({ toVersion: 1, expectedVersion: 2, author: "Takazudo", message: "Restore" });
    expect(rollback).toMatchObject({ version: 3, rollbackOf: 1, identicalToHead: true });
    expect(fake.calls.at(-1)?.body).toBe(JSON.stringify({ toVersion: 1, expectedVersion: 2, author: "Takazudo", message: "Restore" }));
  });

  it("adds the stable job-derived idempotency key without changing the rollback JSON body", async () => {
    const { api, fake } = setup();
    await api.rollback({ toVersion: 1, expectedVersion: 1, jobId: "42" });
    expect(fake.calls.at(-1)).toMatchObject({
      method: "POST",
      headers: {
        authorization: `Bearer ${WRITE}`,
        "content-type": "application/json",
        "idempotency-key": "policy-job-42",
      },
      body: JSON.stringify({ toVersion: 1, expectedVersion: 1 }),
    });
  });
});

describe("stash API runtime validation and bounded errors", () => {
  it("rejects malformed success bodies for every consumed JSON operation after exactly one fetch", async () => {
    const methods: Array<(api: StashApi) => Promise<unknown>> = [
      (api) => api.getFile(),
      (api) => api.createChangeSet(putBody()),
      (api) => api.listChangeSets({ status: "all", limit: 20 }),
      (api) => api.getChangeSet({ id: "chs_178813440000000000001" }),
      (api) => api.getChangeSetDiff({ id: "chs_178813440000000000001" }),
      (api) => api.approveChangeSet({ id: "chs_178813440000000000001" }),
      (api) => api.rejectChangeSet({ id: "chs_178813440000000000001" }),
      (api) => api.getHistory({ limit: 20 }),
      (api) => api.rollback({ toVersion: 1, expectedVersion: 1 }),
    ];
    for (const invoke of methods) {
      const calls: string[] = [];
      const response = new Response("{}", { status: 200, headers: { ETag: '"v1-hash"', "X-Stash-Version": "1", "Content-Type": "application/json" } });
      await expect(invoke(apiWithFetch(responseFetch(response, calls)))).rejects.toMatchObject({ status: 200, code: "unknown" });
      expect(calls).toHaveLength(1);
    }
  });

  it("validates bodyless 304 headers instead of parsing JSON", async () => {
    const calls: string[] = [];
    await expect(apiWithFetch(responseFetch(new Response(null, { status: 304 }), calls)).getFile()).rejects.toMatchObject({ status: 304, code: "unknown" });
    expect(calls).toHaveLength(1);
  });

  it("rejects mismatched file versions and unpinned success statuses", async () => {
    const fileBody = JSON.stringify({ path: PATH, version: 1, body: "policy", deleted: false });
    const mismatched = new Response(fileBody, { status: 200, headers: { ETag: '"v2-hash"', "X-Stash-Version": "2", "Content-Type": "application/json" } });
    await expect(apiWithFetch(responseFetch(mismatched)).getFile()).rejects.toMatchObject({ status: 200, code: "unknown" });

    const set = { id: "chs_178813440000000000001", status: "open", expiresAt: "2026-09-01T00:00:00.000Z", commitId: null, entries: [{ path: PATH, op: "put", baseVersion: 1, stale: false }] };
    await expect(apiWithFetch(responseFetch(new Response(JSON.stringify(set), { status: 200 }))).createChangeSet(putBody())).rejects.toMatchObject({ status: 200, code: "unknown" });
  });

  it("normalizes root file-deleted without retaining message/current", async () => {
    const { api, fake } = setup();
    const file = fake.state.files.get(PATH)!;
    file.versions.push({ version: 2, hash: null, body: null, kind: "delete", author: "secret-author", message: "secret upstream message", createdAt: clock.value.toISOString(), rollbackOf: null });
    const error = await api.getFile().catch((caught: unknown) => caught) as StashApiError;
    expect(error).toMatchObject({ status: 404, code: "file-deleted", message: "Stash API request failed with status 404 and code file-deleted" });
    expect(error).not.toHaveProperty("current");
    expect(error.message).not.toContain("secret");
  });

  it("retains only bounded conflict paths/expected versions on both 409 and 404", async () => {
    const { api, fake } = setup();
    const created = await createSet(api);
    const raw: FakeConflict[] = [{ path: PATH, expectedVersion: 1, current: { version: 2, hash: "secret", deleted: false, kind: "put", author: "secret", createdAt: clock.value.toISOString() } }];
    fake.state.approveConflicts.set(created.id, raw);
    const conflict = await api.approveChangeSet({ id: created.id }).catch((caught: unknown) => caught) as StashApiError;
    expect(conflict).toMatchObject({ status: 409, code: "commit-conflict", conflicts: [{ path: PATH, expectedVersion: 1 }] });
    expect(conflict.conflicts?.[0]).not.toHaveProperty("current");

    fake.state.approveConflicts.delete(created.id);
    fake.state.approveRaceConflicts.set(created.id, raw);
    const raced = await api.approveChangeSet({ id: created.id }).catch((caught: unknown) => caught) as StashApiError;
    expect(raced).toMatchObject({ status: 409, code: "commit-conflict", conflicts: [{ path: PATH, expectedVersion: 1 }] });

    const deletion = await api.createChangeSet({ jobId: "delete-seam", body: "candidate", baseVersion: 1 });
    fake.state.changeSets.get(deletion.id)!.entries = [{ op: "delete", path: PATH, baseVersion: 1 }];
    fake.state.approveConflicts.set(deletion.id, [{ path: PATH, expectedVersion: 1, current: null }]);
    const missing = await api.approveChangeSet({ id: deletion.id }).catch((caught: unknown) => caught) as StashApiError;
    expect(missing).toMatchObject({ status: 404, code: "not-found", conflicts: [{ path: PATH, expectedVersion: 1 }] });

    const many = Array.from({ length: 25 }, (_, index) => ({ path: `policy/${index}.md`, expectedVersion: index + 1, current: { body: "must not survive" } }));
    const boundedApi = apiWithFetch(responseFetch(new Response(JSON.stringify({ error: { code: "commit-conflict", message: "discard" }, current: { body: "discard" }, conflicts: many }), { status: 409 })));
    const bounded = await boundedApi.getFile().catch((caught: unknown) => caught) as StashApiError;
    expect(bounded.conflicts).toHaveLength(20);
    expect(bounded.conflicts?.at(-1)).toEqual({ path: "policy/19.md", expectedVersion: 20 });
    expect(bounded).not.toHaveProperty("current");
  });

  it("normalizes unknown codes, malformed JSON, network failures, and never retries any status", async () => {
    const cases: Array<[number, string, string]> = [
      [400, "validation", "validation"],
      [401, "unauthorized", "unauthorized"],
      [403, "scope", "scope"],
      [404, "not-found", "not-found"],
      [409, "commit-conflict", "commit-conflict"],
      [413, "payload-too-large", "payload-too-large"],
      [422, "idempotency-key-reused", "idempotency-key-reused"],
      [429, "rate-limited", "rate-limited"],
      [500, "internal", "internal"],
      [501, "not-implemented", "unknown"],
    ];
    for (const [status, wireCode, normalizedCode] of cases) {
      const calls: string[] = [];
      const response = new Response(JSON.stringify({ error: { code: wireCode, message: "do not retain" } }), { status });
      const error = await apiWithFetch(responseFetch(response, calls)).getFile().catch((caught: unknown) => caught) as StashApiError;
      expect(calls).toHaveLength(1);
      expect(error.message).toBe(`Stash API request failed with status ${response.status} and code ${error.code}`);
      expect(error.code).toBe(normalizedCode);
    }
    const malformed = await apiWithFetch(responseFetch(new Response("not json", { status: 500 }))).getFile().catch((caught: unknown) => caught) as StashApiError;
    expect(malformed).toMatchObject({ status: 500, code: "unknown" });
    let networkCalls = 0;
    const network = apiWithFetch((async () => { networkCalls++; throw new Error("credential and body"); }) as FetchLike);
    await expect(network.getFile()).rejects.toMatchObject({ status: 0, code: "unknown" });
    expect(networkCalls).toBe(1);
  });

  it("reaches 429 with a valid zhs_ token and performs no retry", async () => {
    const { api, fake } = setup({ rateLimit: { read: 0 } });
    await expect(api.getFile()).rejects.toMatchObject({ status: 429, code: "rate-limited" });
    expect(fake.calls).toHaveLength(1);
  });

  it("surfaces idempotency reuse, expired/closed/reject asymmetry, and no upstream content in logs", async () => {
    const { api, fake } = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = await createSet(api, "same-job", "one");
    const eventCount = fake.state.events.length;
    expect(await createSet(api, "same-job", "one")).toEqual(first);
    expect(fake.state.events).toHaveLength(eventCount);
    await expect(createSet(api, "same-job", "two")).rejects.toMatchObject({ status: 422, code: "idempotency-key-reused" });

    const expiresAt = new Date(clock.value.getTime() + 1).toISOString();
    const expiring = await api.createChangeSet({ ...putBody("expiry"), jobId: "expiry", expiresAt });
    clock.value = new Date(Date.parse(expiresAt));
    await expect(api.approveChangeSet({ id: expiring.id })).rejects.toMatchObject({ status: 409, code: "change-set-expired" });
    expect((await api.rejectChangeSet({ id: expiring.id })).status).toBe("rejected");
    await expect(api.approveChangeSet({ id: expiring.id })).rejects.toMatchObject({ status: 409, code: "change-set-closed" });
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe("stash API source boundaries", () => {
  it("contains no hostname literal, framework/SDK, retry loop, or production fake import", async () => {
    const source = await (await import("./api?raw")).default as string;
    expect(source).not.toContain("stash.invalid");
    expect(source).not.toMatch(/test-support|@takazudo|hono|zod|retry|setTimeout/);
    expect(source.match(/\bfetch\b/g)?.length).toBeGreaterThan(0);
  });
});
