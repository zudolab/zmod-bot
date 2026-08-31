import type { FetchLike } from "../types";

const PIN = "89f72efb79fc7890597aa32b632939ae9e4fb46c";
const STASH = "policy";
const SEEDED_PATH = "policy/reply-guidance.md";
const SEEDED_HASH = "9ddf6d76d858a8b65c250f405f085600b6559d7b59bf7efea488f12ee30b22e2";
const DAY_MS = 86_400_000;

type JsonObject = Record<string, unknown>;
type ChangeSetStatus = "open" | "applied" | "rejected";

export interface FakeStashCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeVersion {
  version: number;
  hash: string | null;
  body: string | null;
  kind: "put" | "delete" | "rollback";
  author: string;
  message: string;
  createdAt: string;
  rollbackOf: number | null;
}

export interface FakeFile {
  path: string;
  versions: FakeVersion[];
  inline: boolean;
}

export interface FakeConflict {
  path: string;
  expectedVersion: number | null;
  current: ReturnType<typeof currentFor>;
}

export interface FakeChangeSet {
  id: string;
  stash: string;
  status: ChangeSetStatus;
  author: string;
  message: string;
  meta: JsonObject;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  commitId: string | null;
  entries: Array<{
    path: string;
    op: "put" | "delete" | "rollback" | "copy";
    baseVersion: number | null;
    body?: string;
    toVersion?: number;
  }>;
}

export interface FakeStashState {
  stash: string;
  files: Map<string, FakeFile>;
  changeSets: Map<string, FakeChangeSet>;
  commits: Map<string, JsonObject>;
  idempotency: Map<string, { canonicalBody: string; changeSetId: string }>;
  /** Rollback idempotency retains the pinned canonical request fingerprint. */
  rollbackIdempotency: Map<string, { fingerprint: string; result: JsonObject }>;
  events: JsonObject[];
  approveConflicts: Map<string, FakeConflict[]>;
  approveRaceConflicts: Map<string, FakeConflict[]>;
  requestCounts: Map<string, number>;
  nextChangeSet: number;
  nextCommit: number;
  nextChange: number;
}

export interface FakeStashOptions {
  now: () => Date;
  writeToken: string;
  readToken: string;
  rateLimit?: number | { read?: number; write?: number; diff?: number };
  /** The one explicitly named bootstrap test may disable the normal existing policy head. */
  seedExistingHead?: boolean;
}

function json(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function error(status: number, code: string, message: string, extra: JsonObject = {}): Response {
  return json({ error: { code, message }, ...extra }, status);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function headersObject(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()]);
}

function head(file: FakeFile | undefined): FakeVersion | null {
  return file?.versions.at(-1) ?? null;
}

function bodyBytes(body: string | null): number {
  return body === null ? 0 : new TextEncoder().encode(body).byteLength;
}

function canonicalJson(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.keys(candidate as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonicalize((candidate as Record<string, unknown>)[key])]),
      );
    }
    return candidate;
  };
  return JSON.stringify(canonicalize(value));
}

function rollbackFingerprint(
  path: string,
  input: { toVersion?: number; expectedVersion?: number; author?: string; message?: string; meta?: JsonObject },
): string {
  return canonicalJson({
    op: "rollback",
    path,
    expectedVersion: input.expectedVersion,
    bodyHash: null,
    contentType: "text/plain; charset=utf-8",
    toVersion: input.toVersion ?? null,
    author: input.author ?? "",
    message: input.message ?? "",
    meta: input.meta ?? {},
    skipIfUnchanged: false,
  });
}

function currentFor(version: FakeVersion | null): {
  version: number;
  hash: string | null;
  deleted: boolean;
  kind: FakeVersion["kind"];
  author: string;
  createdAt: string;
} | null {
  return version === null
    ? null
    : {
        version: version.version,
        hash: version.hash,
        deleted: version.kind === "delete",
        kind: version.kind,
        author: version.author,
        createdAt: version.createdAt,
      };
}

function makeState(now: Date, seed: boolean): FakeStashState {
  const files = new Map<string, FakeFile>();
  if (seed) {
    files.set(SEEDED_PATH, {
      path: SEEDED_PATH,
      inline: true,
      versions: [
        {
          version: 1,
          hash: SEEDED_HASH,
          body: "Seeded reply guidance\n",
          kind: "put",
          author: "seed",
          message: "Seed policy",
          createdAt: now.toISOString(),
          rollbackOf: null,
        },
      ],
    });
  }
  return {
    stash: STASH,
    files,
    changeSets: new Map(),
    commits: new Map(),
    idempotency: new Map(),
    rollbackIdempotency: new Map(),
    events: [],
    approveConflicts: new Map(),
    approveRaceConflicts: new Map(),
    requestCounts: new Map(),
    nextChangeSet: 1,
    nextCommit: 1,
    nextChange: 1,
  };
}

function publicChangeSet(set: FakeChangeSet, state: FakeStashState, now: Date): JsonObject {
  // Pinned Worker source: workers/stash/src/d1/change-sets.ts:148-153,430-462 (inclusive read-time expiry and record mapping).
  const status = set.status === "open" && Date.parse(set.expiresAt) <= now.getTime() ? "expired" : set.status;
  return {
    ...set,
    status,
    entries: [...set.entries]
      // Pinned Worker source: workers/stash/src/d1/sql/change-sets.ts:18-20 (entries are selected ORDER BY path).
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => {
        const current = currentFor(head(state.files.get(entry.path)));
        return { ...entry, body: undefined, toVersion: undefined, current, stale: (current?.version ?? null) !== entry.baseVersion };
      }),
  };
}

function makeId(prefix: "chs" | "cmt", value: number, now: Date): string {
  return `${prefix}_${String(now.getTime()).padStart(13, "0")}${String(value).padStart(8, "0")}`;
}

function limitFor(
  configured: FakeStashOptions["rateLimit"],
  kind: "read" | "write" | "diff",
): number | undefined {
  return typeof configured === "number" ? configured : configured?.[kind];
}

function eventOrigin(request: Request): string | null {
  const value = request.headers.get("X-Stash-Client-Id");
  // Pinned Worker source: workers/stash/src/events/publish.ts:16-20 and packages/core/src/schemas.ts:17-28.
  return value !== null && /^[!-~](?:[ -~]{0,62}[!-~])?$/.test(value) ? value : null;
}

export function createFakeStash(options: FakeStashOptions): {
  fetch: FetchLike;
  state: FakeStashState;
  calls: FakeStashCall[];
  reset(): void;
} {
  const calls: FakeStashCall[] = [];
  const state = makeState(options.now(), options.seedExistingHead !== false);

  function reset(): void {
    calls.length = 0;
    Object.assign(state, makeState(options.now(), options.seedExistingHead !== false));
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const rawBody = request.body === null ? null : await request.clone().text();
    calls.push({ url: request.url, method: request.method, headers: headersObject(request.headers), body: rawBody });

    const authorization = request.headers.get("Authorization");
    const token = /^Bearer ([^\s]+)$/.exec(authorization ?? "")?.[1];
    // Pinned Worker source: workers/stash/src/auth.ts:22-28,49-86 (all token parsing/lookup failures collapse to 401).
    if (url.pathname.startsWith("/v1/") && token !== options.writeToken && token !== options.readToken) {
      return error(401, "unauthorized", "A valid bearer token is required.");
    }

    const route = /^\/v1\/stashes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const requestedStash = route?.[1] === undefined ? undefined : decodeURIComponent(route[1]);
    // Pinned Worker source: workers/stash/src/auth.ts:95-107 (foreign stash concealment precedes same-stash scope rejection).
    if (requestedStash !== undefined && requestedStash !== state.stash) {
      return error(404, "not-found", "The requested resource was not found.");
    }
    const writeRoute = request.method !== "GET";
    // Pinned Worker source: workers/stash/src/auth.ts:95-107 (a same-stash read principal on a write route gets scope).
    if (requestedStash !== undefined && writeRoute && token === options.readToken) {
      return error(403, "scope", "This token does not have write access.");
    }

    const routeKind: "read" | "write" | "diff" = url.pathname.endsWith("/diff")
      ? "diff"
      : writeRoute
        ? "write"
        : "read";
    const configuredLimit = limitFor(options.rateLimit, routeKind);
    const limitKey = `${token}:${routeKind}`;
    const count = (state.requestCounts.get(limitKey) ?? 0) + 1;
    state.requestCounts.set(limitKey, count);
    // Pinned Worker source: workers/stash/src/rate-limit.ts:105-140 (admin bypass; zhs_ principals receive 429 + Retry-After).
    if (token?.startsWith("zhs_") && configuredLimit !== undefined && count > configuredLimit) {
      const response = error(429, "rate-limited", "The request was rate limited.");
      response.headers.set("Retry-After", "60");
      return response;
    }

    // Pinned Worker source: workers/stash/src/routes/meta.ts:16-28 (stash principal identity response).
    if (request.method === "GET" && url.pathname === "/v1/me") {
      return json({
        principal: "stash",
        stash: state.stash,
        tokenId: token === options.writeToken ? "tok_write" : "tok_read",
        scope: token === options.writeToken ? "write" : "read",
        expiresAt: null,
      });
    }

    let body: unknown = {};
    const contentType = request.headers.get("Content-Type");
    // Pinned Worker source: workers/stash/src/routes/change-sets.ts:22-35,103-107,149-153 (Hono JSON validation sees {} when Content-Type is absent).
    if (rawBody !== null && /^application\/([a-z-.]+\+)?json(?:;|$)/i.test(contentType ?? "")) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        // Pinned Worker source: workers/stash/src/errors.ts:6-20 (unexpected malformed-json parser failures become internal 500).
        return error(500, "internal", "An internal error occurred.");
      }
    }

    const fileMatch = /^\/v1\/stashes\/[^/]+\/files\/(.+)$/.exec(url.pathname);
    // Pinned Worker source: workers/stash/src/routes/files.ts:159-194 (file GET, tombstone, ETag, and 304 response shape).
    if (request.method === "GET" && fileMatch?.[1] !== undefined) {
      const path = decodeURIComponent(fileMatch[1]);
      const file = state.files.get(path);
      const versionParam = url.searchParams.get("version");
      const version = versionParam === null ? head(file) : file?.versions.find((item) => item.version === Number(versionParam)) ?? null;
      if (version === null) return error(404, versionParam === null ? "not-found" : "version-not-found", versionParam === null ? "File not found." : "Version not found.");
      if (version.kind === "delete" && versionParam === null) {
        return error(404, "file-deleted", "The file head is deleted.", { current: currentFor(version) });
      }
      const etag = `"v${version.version}-${version.kind === "delete" ? "deleted" : version.hash}"`;
      const responseHeaders = { ETag: etag, "X-Stash-Version": String(version.version) };
      const matches = (request.headers.get("If-None-Match") ?? "")
        .split(",")
        .some((candidate) => ["*", etag].includes(candidate.trim().replace(/^W\//i, "")));
      if (matches) return new Response(null, { status: 304, headers: responseHeaders });
      return json(
        {
          path,
          version: version.version,
          hash: version.hash,
          size: bodyBytes(version.body),
          kind: version.kind,
          author: version.author,
          message: version.message,
          meta: {},
          createdAt: version.createdAt,
          deleted: version.kind === "delete",
          body: file?.inline === false ? null : version.body,
          representation: "text",
          contentAccess: file?.inline === false ? "raw" : "inline",
          contentType: "text/plain; charset=utf-8",
          byteSize: bodyBytes(version.body),
          etag: version.hash,
        },
        200,
        responseHeaders,
      );
    }

    const collectionMatch = /^\/v1\/stashes\/[^/]+\/change-sets$/.exec(url.pathname);
    // Pinned Worker source: workers/stash/src/routes/change-sets.ts:22-61 and d1/change-sets.ts:538-625 (validated create and staging).
    if (request.method === "POST" && collectionMatch) {
      const inputBody = body as { entries?: FakeChangeSet["entries"]; author?: string; message?: string; meta?: JsonObject; expiresAt?: string };
      if (!Array.isArray(inputBody.entries) || inputBody.entries.length === 0) {
        return error(400, "validation", "Invalid change-set input.");
      }
      // Pinned Worker source: workers/stash/src/d1/change-sets.ts:271-282 (stage-time path/base/delete validation).
      for (const entry of inputBody.entries) {
        if (entry.baseVersion === null && state.files.has(entry.path)) {
          return error(400, "validation", `Invalid change-set entry ${entry.path}: the path already exists`);
        }
        const file = state.files.get(entry.path);
        if (entry.baseVersion !== null && file === undefined) {
          return error(400, "validation", `Invalid change-set entry ${entry.path}: the base path does not exist`);
        }
        if (entry.baseVersion !== null && !file?.versions.some((version) => version.version === entry.baseVersion)) {
          return error(400, "validation", `Invalid change-set entry ${entry.path}: base version ${entry.baseVersion} does not exist`);
        }
        if (entry.op === "delete" && head(file)?.kind === "delete") {
          return error(400, "validation", `Invalid change-set entry ${entry.path}: the current head is already deleted`);
        }
      }
      const key = request.headers.get("Idempotency-Key");
      const canonicalBody = canonical(body);
      // Pinned Worker source: workers/stash/src/d1/change-sets.ts:576-589 (same body replays; a different body is 422).
      if (key !== null && state.idempotency.has(key)) {
        const prior = state.idempotency.get(key)!;
        if (prior.canonicalBody !== canonicalBody) {
          return error(422, "idempotency-key-reused", "Idempotency key was already used for a different change set.");
        }
        const replay = state.changeSets.get(prior.changeSetId)!;
        return json(publicChangeSet(replay, state, options.now()), 201, { "Idempotent-Replayed": "true" });
      }
      const now = options.now();
      const id = makeId("chs", state.nextChangeSet++, now);
      const set: FakeChangeSet = {
        id,
        stash: state.stash,
        status: "open",
        author: inputBody.author ?? "",
        message: inputBody.message ?? "",
        meta: { ...(inputBody.meta ?? {}), changeSetId: id },
        expiresAt: inputBody.expiresAt ?? new Date(now.getTime() + 14 * DAY_MS).toISOString(),
        createdBy: "tok_write",
        createdAt: now.toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        commitId: null,
        // Pinned Worker source: workers/stash/src/d1/sql/change-sets.ts:18-20 (all later reads observe path order).
        entries: [...inputBody.entries].sort((a, b) => a.path.localeCompare(b.path)),
      };
      state.changeSets.set(id, set);
      if (key !== null) state.idempotency.set(key, { canonicalBody, changeSetId: id });
      state.events.push({ type: "change-set", changeSetId: id, stash: state.stash, status: "open", paths: set.entries.map(({ path }) => path), origin: eventOrigin(request) });
      return json(publicChangeSet(set, state, now), 201);
    }

    // Pinned Worker source: workers/stash/src/d1/change-sets.ts:978-1009 and sql/change-sets.ts:31-68 (status/path/cursor pagination).
    if (request.method === "GET" && collectionMatch) {
      const now = options.now();
      const status = url.searchParams.get("status") ?? "open";
      const path = url.searchParams.get("path");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const after = url.searchParams.get("after");
      let sets = [...state.changeSets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      sets = sets.filter((set) => status === "all" || publicChangeSet(set, state, now).status === status);
      if (path !== null) sets = sets.filter((set) => set.entries.some((entry) => entry.path === path));
      const total = sets.length;
      if (after !== null) {
        const index = sets.findIndex((set) => btoa(`${Date.parse(set.createdAt)}:${set.id}`) === after);
        sets = index < 0 ? [] : sets.slice(index + 1);
      }
      const page = sets.slice(0, limit);
      const nextAfter = sets.length > limit && page.at(-1) !== undefined
        ? btoa(`${Date.parse(page.at(-1)!.createdAt)}:${page.at(-1)!.id}`)
        : null;
      return json({ changeSets: page.map((set) => publicChangeSet(set, state, now)), nextAfter, total });
    }

    const decisionMatch = /^\/v1\/stashes\/[^/]+\/change-sets\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
    // Pinned Worker source: workers/stash/src/routes/change-sets.ts:103-175 and d1/change-sets.ts:793-968 (decision shapes).
    if (request.method === "POST" && decisionMatch?.[1] !== undefined && decisionMatch[2] !== undefined) {
      const set = state.changeSets.get(decisionMatch[1]);
      if (set === undefined) return error(404, "not-found", "Change set not found.");
      const now = options.now();
      if (decisionMatch[2] === "approve") {
        // Pinned Worker source: workers/stash/src/d1/change-sets.ts:807-810,897-903 (applied replay returns the persisted result without re-emitting events).
        if (set.status === "applied") return json({ status: "applied", commit: state.commits.get(set.id) ?? commitFor(set, state) });
        if (set.status !== "open") return error(409, "change-set-closed", "Change set is already closed.");
        // Pinned Worker source: workers/stash/src/d1/change-sets.ts:815-817 (expiry is inclusive on approval).
        if (Date.parse(set.expiresAt) <= now.getTime()) return error(409, "change-set-expired", "Change set has expired.");
        const actualConflicts = set.entries.flatMap((entry): FakeConflict[] => {
          const current = currentFor(head(state.files.get(entry.path)));
          return (current?.version ?? null) === entry.baseVersion
            ? []
            : [{ path: entry.path, expectedVersion: entry.baseVersion, current }];
        });
        const initial = state.approveConflicts.get(set.id) ?? (actualConflicts.length > 0 ? actualConflicts : undefined);
        // Pinned Worker source: workers/stash/src/d1/change-sets.ts:417-427,823-825 (normal conflict and single missing-delete 404 shapes).
        if (initial !== undefined) return conflictResponse(initial, set);
        const race = state.approveRaceConflicts.get(set.id);
        // Pinned Worker source: workers/stash/src/d1/change-sets.ts:897-909 (post-claim race is re-read and returned with conflicts[]).
        if (race !== undefined) return conflictResponse(race, set);
        set.status = "applied";
        set.decidedAt = now.toISOString();
        set.decidedBy = "tok_write";
        set.commitId = makeId("cmt", state.nextCommit++, now);
        const decision = body as { author?: string; message?: string };
        const appliedSet = { ...set, author: decision.author ?? set.author, message: decision.message ?? set.message };
        applyEntries(appliedSet, state, now);
        const commit = commitFor(appliedSet, state);
        state.commits.set(set.id, commit);
        // Pinned Worker source: workers/stash/src/routes/change-sets.ts:119-130 and events/publish.ts:22-45 (ordered change, commit, decision events).
        const commitEntries = commit.entries as Array<{ path: string; changeId: number; version: number; kind: string }>;
        state.events.push(
          ...commitEntries.map((entry) => ({ type: "change", changeId: entry.changeId, commitId: commit.id, stash: state.stash, path: entry.path, version: entry.version, kind: entry.kind, origin: eventOrigin(request), createdAt: commit.createdAt })),
          { type: "commit", commitId: commit.id, stash: state.stash, entryCount: commit.entryCount, firstChangeId: commit.firstChangeId, lastChangeId: commit.lastChangeId, origin: eventOrigin(request) },
          { type: "change-set", changeSetId: set.id, stash: state.stash, status: "applied", paths: set.entries.map(({ path }) => path), origin: eventOrigin(request) },
        );
        return json({ status: "applied", commit });
      }
      // Pinned Worker source: workers/stash/src/d1/change-sets.ts:941-968 (reject may close an expired open row and returns rejected).
      if (set.status !== "open") return error(409, "change-set-closed", "Change set is already closed.");
      set.status = "rejected";
      set.decidedAt = now.toISOString();
      set.decidedBy = "tok_write";
      set.decisionReason = typeof (body as JsonObject).reason === "string" ? (body as JsonObject).reason as string : null;
      state.events.push({ type: "change-set", changeSetId: set.id, stash: state.stash, status: "rejected", paths: set.entries.map(({ path }) => path), origin: eventOrigin(request) });
      return json(publicChangeSet(set, state, now));
    }

    const diffMatch = /^\/v1\/stashes\/[^/]+\/change-sets\/([^/]+)\/diff$/.exec(url.pathname);
    // Pinned Worker source: workers/stash/src/d1/change-sets.ts:1012-1125 (change-set diff response and path filtering).
    if (request.method === "GET" && diffMatch?.[1] !== undefined) {
      const set = state.changeSets.get(diffMatch[1]);
      if (set === undefined) return error(404, "not-found", "Change set not found.");
      const requestedPath = url.searchParams.get("path");
      const entries = set.entries.filter((entry) => requestedPath === null || entry.path === requestedPath).map((entry) => {
        const file = state.files.get(entry.path);
        const current = currentFor(head(file));
        const base = currentFor(entry.baseVersion === null ? null : file?.versions.find((version) => version.version === entry.baseVersion) ?? null);
        return {
          path: entry.path,
          op: entry.op,
          base,
          candidate: entry.op === "delete" ? null : { version: (entry.baseVersion ?? 0) + 1, hash: SEEDED_HASH, deleted: false, kind: "put", author: set.author, createdAt: set.createdAt },
          current,
          stale: (current?.version ?? null) !== entry.baseVersion,
          diff: { state: "ready", unified: `--- a/${entry.path}\n+++ b/${entry.path}\n`, truncated: false, hunks: [], stats: { added: 0, removed: 0 } },
        };
      });
      if (requestedPath !== null && entries.length === 0) return error(404, "not-found", "Change-set entry not found.");
      return json({ entries, stale: entries.some((entry) => entry.stale), status: publicChangeSet(set, state, options.now()).status, truncated: false });
    }

    const getSetMatch = /^\/v1\/stashes\/[^/]+\/change-sets\/([^/]+)$/.exec(url.pathname);
    // Pinned Worker source: workers/stash/src/routes/change-sets.ts:78-85 and d1/change-sets.ts:970-975 (single record read).
    if (request.method === "GET" && getSetMatch?.[1] !== undefined) {
      const set = state.changeSets.get(getSetMatch[1]);
      return set === undefined ? error(404, "not-found", "Change set not found.") : json(publicChangeSet(set, state, options.now()));
    }

    const historyMatch = /^\/v1\/stashes\/[^/]+\/history\/(.+)$/.exec(url.pathname);
    // Pinned Worker source: workers/stash/src/d1/reads.ts:692-718 (descending history, limit+1, nextBefore).
    if (request.method === "GET" && historyMatch?.[1] !== undefined) {
      const path = decodeURIComponent(historyMatch[1]);
      const file = state.files.get(path);
      if (file === undefined) return error(404, "not-found", "File not found.");
      const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const candidates = [...file.versions].reverse().filter((version) => version.version < before);
      const versions = candidates.slice(0, limit).map(versionRecord);
      return json({ path, headVersion: head(file)!.version, deleted: head(file)!.kind === "delete", total: file.versions.length, versions, nextBefore: candidates.length > limit ? versions.at(-1)?.version ?? null : null });
    }

    const rollbackMatch = /^\/v1\/stashes\/[^/]+\/rollback\/(.+)$/.exec(url.pathname);
    // Pinned Worker source: workers/stash/src/routes/files.ts:259-287 and schemas.ts:81-87 (rollback request/result transport shape).
    if (request.method === "POST" && rollbackMatch?.[1] !== undefined) {
      const path = decodeURIComponent(rollbackMatch[1]);
      const inputBody = body as { toVersion?: number; expectedVersion?: number; author?: string; message?: string; meta?: JsonObject };
      const key = request.headers.get("Idempotency-Key");
      const prior = key === null ? undefined : state.rollbackIdempotency.get(key);
      // Pinned Worker source: workers/stash/src/d1/writes.ts:530-548 and
      // packages/core/src/canonical.ts:34-46. Replay is checked before the
      // live head and hashes every canonical rollback field/default.
      const fingerprint = rollbackFingerprint(path, inputBody);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return error(422, "idempotency-key-reused", "Idempotency key was already used for a different rollback.");
        }
        return json(prior.result, 201, { "Idempotent-Replayed": "true" });
      }
      const file = state.files.get(path);
      const currentHead = head(file);
      if (file === undefined || currentHead === null) return error(404, "not-found", "File not found.");
      if (!Number.isInteger(inputBody.toVersion) || !Number.isInteger(inputBody.expectedVersion)) return error(400, "validation", "Invalid rollback input.");
      if (currentHead.version !== inputBody.expectedVersion) return error(409, "stale", "The expected version is stale.", { current: currentFor(currentHead) });
      const target = file.versions.find((version) => version.version === inputBody.toVersion);
      if (target === undefined) return error(404, "version-not-found", "Version not found.");
      if (target.kind === "delete") return error(422, "rollback-target-tombstone", "The rollback target is deleted.");
      const now = options.now();
      const version: FakeVersion = { ...target, version: currentHead.version + 1, kind: "rollback", author: inputBody.author ?? "", message: inputBody.message ?? "", createdAt: now.toISOString(), rollbackOf: target.version };
      file.versions.push(version);
      const result = { commitId: makeId("cmt", state.nextCommit++, now), version: version.version, hash: version.hash, rollbackOf: target.version, identicalToHead: target.hash === currentHead.hash, changeId: state.nextChange++, createdAt: now.toISOString(), representation: "text", contentType: "text/plain; charset=utf-8", byteSize: bodyBytes(version.body), etag: version.hash };
      if (key !== null) state.rollbackIdempotency.set(key, { fingerprint, result });
      state.events.push({ type: "change", changeId: result.changeId, commitId: result.commitId, stash: state.stash, path, version: version.version, kind: "rollback", origin: eventOrigin(request), createdAt: result.createdAt });
      return json(result, 201);
    }

    // Pinned Worker source: workers/stash/src/routes/index.ts:38-44 (authenticated unmatched v1 routes use non-ErrorCode 501).
    if (url.pathname.startsWith("/v1/")) return error(501, "not-implemented", "This route is not implemented yet.");
    // Pinned Worker source: workers/stash/src/app.ts:79-81 (non-v1 misses use the normal 404 envelope).
    return error(404, "not-found", "The requested resource was not found.");
  };

  return { fetch: fakeFetch as FetchLike, state, calls, reset };
}

function conflictResponse(conflicts: FakeConflict[], set: FakeChangeSet): Response {
  const missingDelete = conflicts.length === 1 && conflicts[0]?.current === null && set.entries.find((entry) => entry.path === conflicts[0]?.path)?.op === "delete";
  return error(missingDelete ? 404 : 409, missingDelete ? "not-found" : "commit-conflict", missingDelete ? `File not found: ${conflicts[0]?.path}` : "One or more change-set entries conflict.", { conflicts });
}

function commitFor(set: FakeChangeSet, state: FakeStashState): JsonObject {
  const firstChangeId = Math.max(1, state.nextChange - set.entries.length);
  return {
    id: set.commitId,
    stash: set.stash,
    source: "change-set",
    sourceId: set.id,
    author: set.author,
    message: set.message,
    meta: { ...set.meta, commitId: set.commitId },
    entryCount: set.entries.length,
    firstChangeId,
    lastChangeId: Math.max(1, state.nextChange - 1),
    revertsCommitId: null,
    createdBy: "tok_write",
    createdAt: set.decidedAt,
    entries: set.entries.map((entry, index) => {
      const version = head(state.files.get(entry.path));
      return { path: entry.path, op: entry.op, version: version?.version ?? 1, kind: version?.kind ?? "put", changeId: firstChangeId + index, hash: version?.hash ?? null, size: bodyBytes(version?.body ?? null), contentType: "text/plain; charset=utf-8", representation: "text", rollbackOf: version?.rollbackOf ?? null };
    }),
  };
}

function applyEntries(set: FakeChangeSet, state: FakeStashState, now: Date): void {
  for (const entry of set.entries) {
    const file = state.files.get(entry.path) ?? { path: entry.path, versions: [], inline: true };
    const old = head(file);
    const target = entry.toVersion === undefined ? undefined : file.versions.find((version) => version.version === entry.toVersion);
    const body = entry.op === "rollback" ? target?.body ?? null : entry.op === "delete" ? null : entry.body ?? "";
    file.versions.push({ version: (old?.version ?? 0) + 1, hash: entry.op === "delete" ? null : target?.hash ?? SEEDED_HASH, body, kind: entry.op === "delete" ? "delete" : entry.op === "rollback" ? "rollback" : "put", author: set.author, message: set.message, createdAt: now.toISOString(), rollbackOf: entry.op === "rollback" ? entry.toVersion ?? null : null });
    state.files.set(entry.path, file);
    state.nextChange++;
  }
}

function versionRecord(version: FakeVersion): JsonObject {
  return { commitId: `cmt_history_${version.version}`, version: version.version, kind: version.kind, hash: version.hash, size: bodyBytes(version.body), rollbackOf: version.rollbackOf, author: version.author, message: version.message, meta: {}, createdAt: version.createdAt, representation: "text", contentAccess: version.kind === "delete" ? "deleted" : "inline", contentType: "text/plain; charset=utf-8", byteSize: bodyBytes(version.body), etag: version.hash };
}

export const fakeStashContract = { commit: PIN, stash: STASH, seededPath: SEEDED_PATH } as const;
