import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolicyLastKnownGoodRow } from "../db/schema";
import { createMockD1 } from "../db/test-support";
import {
  POLICY_DOC_PATH,
  POLICY_HEADER,
  POLICY_MAX_BYTES,
  POLICY_REQUIRED_HEADINGS,
} from "../policy/contract";
import { POLICY_CONTENT } from "../policy/generated";
import type { FetchLike } from "../types";
import {
  POLICY_CACHE_TTL_MS,
  POLICY_READ_DEADLINE_MS,
  createPolicyReader,
  readLivePolicy,
  resetLivePolicyReaderForTests,
  isStructurallyValidPolicy,
  type PolicyReadWarning,
  type PolicyReaderStore,
} from "./policy-reader";

const BASE_URL = "https://stash.example.test";
const STASH = "policy-live";
const READ_TOKEN = `zhs_${"r".repeat(43)}`;
const START = 10_000;

function policy(label: string): string {
  return `${POLICY_CONTENT}\n${label}\n`;
}

function row(version: number, document = policy(`v${version}`), confirmedAt = START): PolicyLastKnownGoodRow {
  return {
    path: POLICY_DOC_PATH,
    document,
    version,
    etag: `"etag-v${version}"`,
    confirmed_at: confirmedAt,
  };
}

function fileResponse(version: number, document: string | null, etag = `"etag-v${version}"`): Response {
  return new Response(JSON.stringify({
    path: POLICY_DOC_PATH,
    version,
    body: document,
    deleted: false,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: etag, "X-Stash-Version": String(version) },
  });
}

function notModified(version: number, etag = `"etag-v${version}"`): Response {
  return new Response(null, {
    status: 304,
    headers: { ETag: etag, "X-Stash-Version": String(version) },
  });
}

function errorResponse(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message: "secret upstream body" }, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createMemoryStore(initial: PolicyLastKnownGoodRow | null = null) {
  let current = initial;
  const get = vi.fn(async () => current);
  const put = vi.fn(async (input: { version: number; document: string; etag: string }) => {
    if (
      current !== null
      && (input.version < current.version
        || (input.version === current.version
          && (input.document !== current.document || input.etag !== current.etag)))
    ) return false;
    current = row(input.version, input.document, nowMs);
    current.etag = input.etag;
    return true;
  });
  return { store: { get, put } satisfies PolicyReaderStore, get, put, current: () => current };
}

let nowMs = START;

function input(
  fetch: FetchLike,
  store: PolicyReaderStore,
  warn = vi.fn<(warning: PolicyReadWarning) => void>(),
) {
  return {
    baseUrl: BASE_URL,
    stash: STASH,
    readToken: READ_TOKEN,
    fetch,
    store,
    now: () => new Date(nowMs),
    warn,
  };
}

afterEach(() => {
  resetLivePolicyReaderForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  nowMs = START;
});

describe("policy read-time structural validation", () => {
  it("checks only exact header placement, fixed heading order, and UTF-8 bytes", () => {
    expect(isStructurallyValidPolicy(POLICY_CONTENT)).toBe(true);
    expect(isStructurallyValidPolicy(`prefix\n${POLICY_CONTENT}`)).toBe(false);
    expect(isStructurallyValidPolicy(POLICY_CONTENT.replace(`${POLICY_REQUIRED_HEADINGS[1]}\n`, ""))).toBe(false);
    expect(isStructurallyValidPolicy(`${POLICY_HEADER}\n\n${POLICY_REQUIRED_HEADINGS[1]}\n\nx\n\n${POLICY_REQUIRED_HEADINGS[0]}\n\nx\n\n${POLICY_REQUIRED_HEADINGS[2]}\n`)).toBe(false);
    expect(isStructurallyValidPolicy(`${POLICY_CONTENT}${"あ".repeat(POLICY_MAX_BYTES)}`)).toBe(false);

    // Read-time validation deliberately does not adopt the edit validator's
    // URL/fixed-clause rules.
    expect(isStructurallyValidPolicy(`${POLICY_CONTENT}\nhttps://example.test/new\n`)).toBe(true);
  });
});

describe("fail-open live policy reader", () => {
  it.each([
    { baseUrl: undefined, stash: STASH, readToken: READ_TOKEN },
    { baseUrl: BASE_URL, stash: undefined, readToken: READ_TOKEN },
    { baseUrl: BASE_URL, stash: STASH, readToken: undefined },
    { baseUrl: "http://stash.example.test", stash: STASH, readToken: READ_TOKEN },
    { baseUrl: BASE_URL, stash: "Bad_Stash", readToken: READ_TOKEN },
    { baseUrl: BASE_URL, stash: STASH, readToken: "secret" },
  ])("returns compiled with zero I/O for incomplete config %#", async (config) => {
    const reader = createPolicyReader();
    const fetch = vi.fn<FetchLike>();
    const store = { get: vi.fn(), put: vi.fn() } as unknown as PolicyReaderStore;
    const warn = vi.fn();

    await expect(reader.readLivePolicy({ ...input(fetch, store, warn), ...config })).resolves.toEqual({
      document: POLICY_CONTENT,
      source: "compiled",
      ageMs: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("persists a valid 200, serves a fresh cache, then conditionally confirms an exact quoted ETag after TTL", async () => {
    const reader = createPolicyReader();
    const memory = createMemoryStore();
    const document = policy("remote v3");
    const fetch = vi.fn<FetchLike>()
      .mockResolvedValueOnce(fileResponse(3, document, '"opaque/etag-3"'))
      .mockResolvedValueOnce(notModified(3, '"opaque/etag-3"'));
    const warn = vi.fn();

    await expect(reader.readLivePolicy(input(fetch, memory.store, warn))).resolves.toEqual({
      document,
      source: "stash",
      ageMs: 0,
    });
    expect(memory.put).toHaveBeenCalledWith({ version: 3, document, etag: '"opaque/etag-3"' });

    nowMs += POLICY_CACHE_TTL_MS - 1;
    await expect(reader.readLivePolicy(input(fetch, memory.store, warn))).resolves.toEqual({
      document,
      source: "cache",
      ageMs: POLICY_CACHE_TTL_MS - 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await expect(reader.readLivePolicy(input(fetch, memory.store, warn))).resolves.toEqual({
      document,
      source: "stash",
      ageMs: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondInit = fetch.mock.calls[1]?.[1];
    expect(new Headers(secondInit?.headers).get("If-None-Match")).toBe('"opaque/etag-3"');
    expect(memory.put).toHaveBeenLastCalledWith({ version: 3, document, etag: '"opaque/etag-3"' });
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses the exact D1 ETag for a valid bodyless 304", async () => {
    const reader = createPolicyReader();
    const lkg = row(7, policy("stored"), START - 2_000);
    lkg.etag = '"quoted-current"';
    const memory = createMemoryStore(lkg);
    const fetch = vi.fn<FetchLike>().mockResolvedValue(notModified(7, '"quoted-current"'));

    await expect(reader.readLivePolicy(input(fetch, memory.store))).resolves.toMatchObject({
      document: lkg.document,
      source: "stash",
      ageMs: 0,
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("If-None-Match")).toBe('"quoted-current"');
  });

  const failures: Array<{
    name: string;
    response: () => Response | Promise<Response>;
    status: number;
    code?: string;
  }> = [
    { name: "fetch throws", response: () => Promise.reject(new Error("Bearer secret")), status: 0 },
    { name: "malformed JSON", response: () => new Response("{", { status: 200, headers: { ETag: '"e"', "X-Stash-Version": "1" } }), status: 200 },
    { name: "malformed success", response: () => new Response(JSON.stringify({ path: POLICY_DOC_PATH, version: 2, body: policy("x"), deleted: false }), { status: 200, headers: { ETag: '"e"', "X-Stash-Version": "1" } }), status: 200 },
    { name: "invalid policy", response: () => fileResponse(1, "not policy"), status: 200 },
    { name: "body null", response: () => fileResponse(1, null), status: 200 },
    { name: "401", response: () => errorResponse(401, "unauthorized"), status: 401, code: "unauthorized" },
    { name: "429", response: () => errorResponse(429, "rate-limited"), status: 429, code: "rate-limited" },
    { name: "500", response: () => errorResponse(500, "internal"), status: 500, code: "internal" },
    { name: "501 unknown", response: () => errorResponse(501, "new-secret-code"), status: 501, code: "unknown" },
    { name: "404 not-found", response: () => errorResponse(404, "not-found"), status: 404, code: "not-found" },
    { name: "404 file-deleted current", response: () => errorResponse(404, "file-deleted", { current: { body: "must not leak", token: READ_TOKEN } }), status: 404, code: "file-deleted" },
  ];

  it.each(failures)("degrades once to valid LKG with one bounded warning for $name", async ({ response, status, code }) => {
    const reader = createPolicyReader();
    const lkg = row(4, policy("safe lkg"), START - 500);
    const memory = createMemoryStore(lkg);
    const fetch = vi.fn<FetchLike>().mockImplementation(response as FetchLike);
    const warn = vi.fn();

    await expect(reader.readLivePolicy(input(fetch, memory.store, warn))).resolves.toEqual({
      document: lkg.document,
      source: "last_known_good",
      ageMs: 500,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({
      source: "last_known_good",
      configured: true,
      status,
      normalizedCode: code ?? "unknown",
      count: 1,
      ageMs: 500,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(READ_TOKEN);
  });

  it("wins against a never-resolving fetch at 1500ms, aborts its signal, and does not retry", async () => {
    vi.useFakeTimers();
    const reader = createPolicyReader();
    const lkg = row(2, policy("deadline lkg"), START - 100);
    const memory = createMemoryStore(lkg);
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<FetchLike>((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const warn = vi.fn();

    const pending = reader.readLivePolicy(input(fetch, memory.store, warn));
    await vi.advanceTimersByTimeAsync(POLICY_READ_DEADLINE_MS);

    await expect(pending).resolves.toMatchObject({ source: "last_known_good", document: lkg.document });
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("swallows D1 reads when a valid remote can be persisted", async () => {
    const reader = createPolicyReader();
    const document = policy("remote despite read failure");
    const store: PolicyReaderStore = {
      get: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
      put: vi.fn().mockResolvedValue(true),
    };

    await expect(reader.readLivePolicy(input(vi.fn<FetchLike>().mockResolvedValue(fileResponse(1, document)), store))).resolves.toEqual({
      document,
      source: "stash",
      ageMs: 0,
    });
  });

  it("swallows D1 write failure into a valid LKG fallback", async () => {
    const reader = createPolicyReader();
    const lkg = row(1, policy("lkg"), START - 250);
    const store: PolicyReaderStore = {
      get: vi.fn().mockResolvedValue(lkg),
      put: vi.fn().mockRejectedValue(new Error("D1 secret")),
    };
    const warn = vi.fn();

    await expect(reader.readLivePolicy(input(vi.fn<FetchLike>().mockResolvedValue(fileResponse(2, policy("remote"))), store, warn))).resolves.toEqual({
      document: lkg.document,
      source: "last_known_good",
      ageMs: 250,
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { ...row(1), path: "other.md" },
    { ...row(1), document: "invalid" },
    { ...row(1), etag: "unquoted" },
    { ...row(1), version: 0 },
    { ...row(1), confirmed_at: Number.NaN },
  ])("uses the compiled floor for absent or invalid LKG %#", async (stored) => {
    const reader = createPolicyReader();
    const store: PolicyReaderStore = {
      get: vi.fn().mockResolvedValue(stored),
      put: vi.fn(),
    };
    const warn = vi.fn();

    await expect(reader.readLivePolicy(input(vi.fn<FetchLike>().mockRejectedValue(new Error("down")), store, warn))).resolves.toEqual({
      document: POLICY_CONTENT,
      source: "compiled",
      ageMs: 0,
    });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ source: "compiled", ageMs: 0 }));
  });

  it("does not let an older remote result replace newer LKG state", async () => {
    const reader = createPolicyReader();
    const lkg = row(9, policy("newest"), START - 300);
    const memory = createMemoryStore(lkg);
    const warn = vi.fn();

    await expect(reader.readLivePolicy(input(
      vi.fn<FetchLike>().mockResolvedValue(fileResponse(8, policy("stale"))),
      memory.store,
      warn,
    ))).resolves.toEqual({ document: lkg.document, source: "last_known_good", ageMs: 300 });
    expect(memory.put).not.toHaveBeenCalled();
    expect(memory.current()).toEqual(lkg);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("re-reads D1 after a write fence and returns the newer concurrent winner", async () => {
    const reader = createPolicyReader();
    const old = row(3, policy("initial"), START - 400);
    const winner = row(7, policy("concurrent winner"), START - 25);
    const get = vi.fn()
      .mockResolvedValueOnce(old)
      .mockResolvedValue(winner);
    const store: PolicyReaderStore = { get, put: vi.fn().mockResolvedValue(false) };
    const warn = vi.fn();

    await expect(reader.readLivePolicy(input(
      vi.fn<FetchLike>().mockResolvedValue(fileResponse(4, policy("lost race"))),
      store,
      warn,
    ))).resolves.toEqual({
      document: winner.document,
      source: "last_known_good",
      ageMs: 25,
    });
    expect(get).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not let an older concurrent result replace newer cache state", async () => {
    const reader = createPolicyReader();
    const memory = createMemoryStore();
    let resolveOlder!: (response: Response) => void;
    const olderPending = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    const oldFetch = vi.fn<FetchLike>().mockReturnValue(olderPending);
    const newFetch = vi.fn<FetchLike>().mockResolvedValue(fileResponse(6, policy("new cache")));

    const oldRead = reader.readLivePolicy(input(oldFetch, memory.store));
    await Promise.resolve();
    const newRead = reader.readLivePolicy(input(newFetch, memory.store));
    await expect(newRead).resolves.toMatchObject({ document: policy("new cache"), source: "stash" });
    resolveOlder(fileResponse(5, policy("old remote")));
    await expect(oldRead).resolves.not.toMatchObject({ document: policy("old remote"), source: "stash" });

    nowMs += 1;
    const unusedFetch = vi.fn<FetchLike>();
    await expect(reader.readLivePolicy(input(unusedFetch, memory.store))).resolves.toMatchObject({
      document: policy("new cache"),
      source: "cache",
    });
    expect(unusedFetch).not.toHaveBeenCalled();
  });

  it("invalidates constructed cache and always returns a finite nonnegative age", async () => {
    const reader = createPolicyReader();
    const memory = createMemoryStore();
    const firstFetch = vi.fn<FetchLike>().mockResolvedValue(fileResponse(1, policy("cache")));
    await reader.readLivePolicy(input(firstFetch, memory.store));

    nowMs = 0; // A clock moving backwards is clamped rather than exposed.
    await expect(reader.readLivePolicy(input(vi.fn<FetchLike>(), memory.store))).resolves.toMatchObject({
      source: "cache",
      ageMs: 0,
    });

    reader.invalidate();
    const afterInvalidate = vi.fn<FetchLike>().mockRejectedValue(new Error("offline"));
    const result = await reader.readLivePolicy(input(afterInvalidate, memory.store));
    expect(afterInvalidate).toHaveBeenCalledOnce();
    expect(Number.isFinite(result.ageMs)).toBe(true);
    expect(result.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("never rejects even when the warning sink fails", async () => {
    const reader = createPolicyReader();
    const memory = createMemoryStore(null);
    const warn = vi.fn(() => { throw new Error(`do not expose ${READ_TOKEN}`); });

    await expect(reader.readLivePolicy(input(
      vi.fn<FetchLike>().mockRejectedValue(new Error("remote")),
      memory.store,
      warn,
    ))).resolves.toEqual({ document: POLICY_CONTENT, source: "compiled", ageMs: 0 });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("the production singleton emits one closed redacted log object", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = createMockD1();

    await expect(readLivePolicy({
      env: {
        DB: db,
        STASH_BASE_URL: BASE_URL,
        STASH_NAME: STASH,
        STASH_READ_TOKEN: READ_TOKEN,
      },
      fetch: vi.fn<FetchLike>().mockResolvedValue(errorResponse(404, "file-deleted", {
        current: { body: "private policy", credential: READ_TOKEN },
      })),
      now: () => new Date(START),
    })).resolves.toEqual({ document: POLICY_CONTENT, source: "compiled", ageMs: 0 });

    expect(consoleWarn).toHaveBeenCalledOnce();
    const parsed = JSON.parse(String(consoleWarn.mock.calls[0]?.[0]));
    expect(parsed).toEqual({
      level: "warn",
      msg: "policy.live.degraded",
      source: "compiled",
      configured: true,
      status: 404,
      normalizedCode: "file-deleted",
      count: 1,
      ageMs: 0,
    });
    expect(String(consoleWarn.mock.calls[0]?.[0])).not.toContain("private policy");
    expect(String(consoleWarn.mock.calls[0]?.[0])).not.toContain(READ_TOKEN);
  });
});
