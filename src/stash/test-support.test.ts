import { describe, expect, it } from "vitest";
import { createFakeStash, fakeStashContract, type FakeChangeSet, type FakeConflict } from "./test-support";

const WRITE = "zhs_write_test";
const READ = "zhs_read_test";
const BASE = "https://stash.test";
const POLICY = "policy/reply-guidance.md";
const clock = { value: new Date("2026-08-31T00:00:00.000Z") };

function fake(overrides: Partial<Parameters<typeof createFakeStash>[0]> = {}) {
  const result = createFakeStash({ now: () => clock.value, writeToken: WRITE, readToken: READ, ...overrides });
  if (overrides.seedExistingHead !== false) expect(result.state.files.has(POLICY)).toBe(true);
  return result;
}

function request(fetch: typeof globalThis.fetch, path: string, options: { token?: string; method?: string; body?: unknown; rawBody?: string; contentType?: boolean; headers?: Record<string, string> } = {}) {
  const headers = new Headers(options.headers);
  if (options.token !== "") headers.set("Authorization", `Bearer ${options.token ?? WRITE}`);
  if (options.body !== undefined || options.rawBody !== undefined) {
    if (options.contentType !== false) headers.set("Content-Type", "application/json");
  }
  return fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

interface CreateBody {
  entries: Array<
    | { op: "put"; path: string; baseVersion: number | null; body: string }
    | { op: "delete"; path: string; baseVersion: number }
  >;
  author: string;
  message: string;
  expiresAt?: string;
}

function createBody(path = POLICY, baseVersion: number | null = 1, body = "updated\n"): CreateBody {
  return { entries: [{ op: "put" as const, path, baseVersion, body }], author: "Takazudo", message: "Update policy" };
}

async function createSet(api: ReturnType<typeof fake>, body: CreateBody = createBody(), headers: Record<string, string> = {}) {
  const response = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", body, headers });
  expect(response.status).toBe(201);
  return await response.json() as FakeChangeSet;
}

describe("createFakeStash", () => {
  it("has one explicitly named bootstrap case without an existing head", async () => {
    const api = fake({ seedExistingHead: false });
    expect(api.state.files.size).toBe(0);
    const response = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", body: createBody(POLICY, null) });
    expect(response.status).toBe(201);
  });

  it("models 401 auth collapse, foreign concealment, same-stash scope, and zhs_ rate limiting", async () => {
    const api = fake({ rateLimit: { read: 1 } });
    for (const token of ["", "bad", "zhs_unknown"]) {
      const response = await request(api.fetch, "/v1/me", { token });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
    expect((await request(api.fetch, "/v1/stashes/foreign/change-sets", { token: READ, method: "POST", body: createBody() })).status).toBe(404);
    expect(await (await request(api.fetch, "/v1/stashes/policy/change-sets", { token: READ, method: "POST", body: createBody() })).json()).toMatchObject({ error: { code: "scope" } });

    expect((await request(api.fetch, "/v1/me", { token: READ })).status).toBe(200);
    const limited = await request(api.fetch, "/v1/me", { token: READ });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });

  it("rejects null base for an existing path and handles Content-Type/malformed JSON exactly", async () => {
    const api = fake();
    const existing = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", body: createBody(POLICY, null) });
    expect(existing.status).toBe(400);
    expect(await existing.json()).toEqual({ error: { code: "validation", message: `Invalid change-set entry ${POLICY}: the path already exists` } });
    const missingDelete = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", body: { entries: [{ op: "delete", path: "missing.md", baseVersion: 1 }], author: "x", message: "delete" } });
    expect(await missingDelete.json()).toMatchObject({ error: { code: "validation", message: "Invalid change-set entry missing.md: the base path does not exist" } });

    const noTypeCreate = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", body: createBody(), contentType: false });
    expect(noTypeCreate.status).toBe(400);
    const malformed = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", rawBody: "{" });
    expect(malformed.status).toBe(500);

    const set = await createSet(api);
    const approved = await request(api.fetch, `/v1/stashes/policy/change-sets/${set.id}/approve`, { method: "POST", rawBody: JSON.stringify({ ignored: true }), contentType: false });
    expect(approved.status).toBe(200);
    const rejectSet = await createSet(api, createBody("policy/second.md", null));
    const rejected = await request(api.fetch, `/v1/stashes/policy/change-sets/${rejectSet.id}/reject`, { method: "POST", rawBody: JSON.stringify({ ignored: true }), contentType: false });
    expect(rejected.status).toBe(200);
  });

  it("sorts entries, computes inclusive expiry at read time, paginates lists, and supports get/diff", async () => {
    const api = fake();
    const first = await createSet(api, { ...createBody("z.md", null), entries: [{ op: "put", path: "z.md", baseVersion: null, body: "z" }, { op: "put", path: "a.md", baseVersion: null, body: "a" }], expiresAt: new Date(clock.value.getTime() + 1_000).toISOString() });
    await createSet(api, createBody("b.md", null));
    expect(first.entries.map((entry) => entry.path)).toEqual(["a.md", "z.md"]);

    const page1 = await (await request(api.fetch, "/v1/stashes/policy/change-sets?status=all&limit=1")).json() as { changeSets: FakeChangeSet[]; nextAfter: string; total: number };
    expect(page1.changeSets).toHaveLength(1);
    expect(page1.nextAfter).toBeTruthy();
    expect(page1.total).toBe(2);
    const page2 = await (await request(api.fetch, `/v1/stashes/policy/change-sets?status=all&limit=1&after=${encodeURIComponent(page1.nextAfter)}`)).json() as { changeSets: FakeChangeSet[] };
    expect(page2.changeSets).toHaveLength(1);

    clock.value = new Date(Date.parse(first.expiresAt));
    const got = await (await request(api.fetch, `/v1/stashes/policy/change-sets/${first.id}`)).json() as FakeChangeSet;
    expect(got.status).toBe("expired");
    const diff = await (await request(api.fetch, `/v1/stashes/policy/change-sets/${first.id}/diff?path=a.md`)).json() as { entries: Array<{ path: string }>; status: string };
    expect(diff).toMatchObject({ entries: [{ path: "a.md" }], status: "expired" });
  });

  it("models normal, later-race, and single-delete approval conflicts with conflicts[]", async () => {
    clock.value = new Date("2026-08-31T00:00:00.000Z");
    const api = fake();
    const current = { version: 2, hash: "new", deleted: false, kind: "put" as const, author: "other", createdAt: clock.value.toISOString() };
    const normal = await createSet(api);
    api.state.approveConflicts.set(normal.id, [{ path: POLICY, expectedVersion: 1, current }]);
    const normalResponse = await request(api.fetch, `/v1/stashes/policy/change-sets/${normal.id}/approve`, { method: "POST", body: {} });
    expect(normalResponse.status).toBe(409);
    expect(await normalResponse.json()).toMatchObject({ error: { code: "commit-conflict" }, conflicts: [{ path: POLICY }] });

    const race = await createSet(api);
    api.state.approveRaceConflicts.set(race.id, [{ path: POLICY, expectedVersion: 1, current }]);
    expect((await request(api.fetch, `/v1/stashes/policy/change-sets/${race.id}/approve`, { method: "POST", body: {} })).status).toBe(409);

    const deletion = await createSet(api, { entries: [{ op: "delete", path: POLICY, baseVersion: 1 }], author: "x", message: "delete" });
    const missing: FakeConflict[] = [{ path: POLICY, expectedVersion: 1, current: null }];
    api.state.approveConflicts.set(deletion.id, missing);
    const missingResponse = await request(api.fetch, `/v1/stashes/policy/change-sets/${deletion.id}/approve`, { method: "POST", body: {} });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({ error: { code: "not-found" }, conflicts: missing });
  });

  it("returns stable applied replay without another event, while expired approve fails and reject succeeds", async () => {
    const api = fake();
    const set = await createSet(api);
    const applied = await request(api.fetch, `/v1/stashes/policy/change-sets/${set.id}/approve`, { method: "POST", body: {} });
    const result = await applied.json() as { commit: { id: string } };
    const eventCount = api.state.events.length;
    api.state.files.get(POLICY)!.versions.push({ ...api.state.files.get(POLICY)!.versions.at(-1)!, version: 3, body: "later", hash: "later" });
    const replay = await request(api.fetch, `/v1/stashes/policy/change-sets/${set.id}/approve`, { method: "POST", body: {} });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBeNull();
    const replayBody = await replay.json() as { commit: { id: string; entries: Array<{ version: number }> } };
    expect(replayBody).toMatchObject({ commit: { id: result.commit.id, entries: [{ version: 2 }] } });
    expect(api.state.events).toHaveLength(eventCount);

    const expired = await createSet(api, { ...createBody("expired.md", null), expiresAt: new Date(clock.value.getTime() + 1).toISOString() });
    clock.value = new Date(Date.parse(expired.expiresAt));
    expect(await (await request(api.fetch, `/v1/stashes/policy/change-sets/${expired.id}/approve`, { method: "POST", body: {} })).json()).toMatchObject({ error: { code: "change-set-expired" } });
    const rejected = await request(api.fetch, `/v1/stashes/policy/change-sets/${expired.id}/reject`, { method: "POST", body: { reason: "superseded" } });
    expect(await rejected.json()).toMatchObject({ status: "rejected", decisionReason: "superseded" });
  });

  it("implements create idempotency replay and rejects key reuse with a different body", async () => {
    clock.value = new Date("2026-08-31T00:00:00.000Z");
    const api = fake();
    const first = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", body: createBody(), headers: { "Idempotency-Key": "same" } });
    const firstBody = await first.json() as { id: string };
    const eventCount = api.state.events.length;
    const replay = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", body: createBody(), headers: { "Idempotency-Key": "same" } });
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await replay.json()).toMatchObject({ id: firstBody.id });
    expect(api.state.events).toHaveLength(eventCount);
    const reused = await request(api.fetch, "/v1/stashes/policy/change-sets", { method: "POST", body: { ...createBody(), message: "different" }, headers: { "Idempotency-Key": "same" } });
    expect(reused.status).toBe(422);
  });

  it("fences rollback idempotency by the expected head version", async () => {
    const api = fake();
    const file = api.state.files.get(POLICY)!;
    file.versions.push({ ...file.versions[0]!, version: 2, body: "second", hash: "second" });
    const headers = { "Idempotency-Key": "policy-job-rollback-1" };
    const first = await request(api.fetch, `/v1/stashes/policy/rollback/${POLICY}`, {
      method: "POST",
      body: { toVersion: 1, expectedVersion: 2 },
      headers,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const changedExpected = await request(api.fetch, `/v1/stashes/policy/rollback/${POLICY}`, {
      method: "POST",
      body: { toVersion: 1, expectedVersion: 3 },
      headers,
    });
    expect(changedExpected.status).toBe(422);
    expect((await changedExpected.json()) as Record<string, unknown>).toMatchObject({ error: { code: "idempotency-key-reused" } });

    const replay = await request(api.fetch, `/v1/stashes/policy/rollback/${POLICY}`, {
      method: "POST",
      body: { toVersion: 1, expectedVersion: 2 },
      headers,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(file.versions).toHaveLength(3);
  });

  it("serves quoted ETags, empty 304s, null inline bodies, and root-level tombstone current", async () => {
    const api = fake();
    const first = await request(api.fetch, `/v1/stashes/policy/files/${POLICY}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("ETag")).toMatch(/^"v1-/);
    expect(first.headers.get("X-Stash-Version")).toBe("1");
    const notModified = await request(api.fetch, `/v1/stashes/policy/files/${POLICY}`, { headers: { "If-None-Match": first.headers.get("ETag")! } });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get("ETag")).toBe(first.headers.get("ETag"));
    expect(notModified.headers.get("X-Stash-Version")).toBe("1");

    api.state.files.get(POLICY)!.inline = false;
    expect(await (await request(api.fetch, `/v1/stashes/policy/files/${POLICY}`)).json()).toMatchObject({ body: null, contentAccess: "raw" });
    api.state.files.get(POLICY)!.versions.push({ version: 2, hash: null, body: null, kind: "delete", author: "x", message: "gone", createdAt: clock.value.toISOString(), rollbackOf: null });
    const deleted = await request(api.fetch, `/v1/stashes/policy/files/${POLICY}`);
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual({ error: { code: "file-deleted", message: "The file head is deleted." }, current: { version: 2, hash: null, deleted: true, kind: "delete", author: "x", createdAt: clock.value.toISOString() } });
  });

  it("paginates history, rolls back with pinned bodies, and returns unmatched v1 501", async () => {
    const api = fake();
    const file = api.state.files.get(POLICY)!;
    file.versions.push({ ...file.versions[0]!, version: 2, body: "second", hash: "second", createdAt: new Date(clock.value.getTime() + 1).toISOString() });
    const history = await (await request(api.fetch, `/v1/stashes/policy/history/${POLICY}?limit=1`)).json() as { versions: Array<{ version: number }>; nextBefore: number };
    expect(history).toMatchObject({ versions: [{ version: 2 }], nextBefore: 2 });

    const rollbackBody = { toVersion: 1, expectedVersion: 2, author: "Takazudo", message: "Restore" };
    const rollback = await request(api.fetch, `/v1/stashes/policy/rollback/${POLICY}`, { method: "POST", body: rollbackBody });
    expect(rollback.status).toBe(201);
    expect(await rollback.json()).toMatchObject({ version: 3, rollbackOf: 1, identicalToHead: false });
    expect(api.calls.at(-1)).toMatchObject({ method: "POST", body: JSON.stringify(rollbackBody) });

    const unknown = await request(api.fetch, "/v1/stashes/policy/future-route");
    expect(unknown.status).toBe(501);
    expect(await unknown.json()).toMatchObject({ error: { code: "not-implemented" } });
  });

  it("records calls, exposes mutable state, and reset restores the seeded baseline", async () => {
    const api = fake();
    await createSet(api);
    expect(api.calls[0]).toMatchObject({ url: `${BASE}/v1/stashes/policy/change-sets`, method: "POST", headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" } });
    expect(api.state.changeSets.size).toBe(1);
    api.reset();
    expect(api.calls).toEqual([]);
    expect(api.state.changeSets.size).toBe(0);
    expect(api.state.files.has(POLICY)).toBe(true);
    expect(fakeStashContract.commit).toHaveLength(40);
  });
});
