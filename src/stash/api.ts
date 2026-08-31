import { POLICY_DOC_PATH } from "../policy/contract";
import type { FetchLike } from "../types";

const TOKEN_PATTERN = /^zhs_[A-Za-z0-9_-]{43}$/;
const STASH_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const CHANGE_SET_ID_PATTERN = /^chs_\d{13}[0-9a-f]{8}$/;
const COMMIT_ID_PATTERN = /^cmt_\d{13}[0-9a-f]{8}$/;
const QUOTED_ETAG_PATTERN = /^"[^"\r\n]+"$/;
const MAX_ERROR_BODY_CHARS = 65_536;
const MAX_CONFLICTS = 20;
const MAX_DIFF_BYTES = 1_048_576;
const MAX_INLINE_BODY_BYTES = 5_000_000;
const MAX_PAGE_ITEMS = 200;
const MAX_CHANGE_SET_ENTRIES = 20;

export const STASH_ERROR_CODES = [
  "validation", "invalid-path", "body-not-well-formed", "unauthorized", "scope", "not-found",
  "file-deleted", "version-not-found", "stale", "exists", "already-deleted", "gc-busy",
  "already-rotated", "token-expired", "commit-conflict", "change-set-expired", "change-set-closed",
  "rate-limited", "payload-too-large", "idempotency-key-reused", "rollback-target-tombstone",
  "unsupported-representation", "upload-session-not-open", "upload-session-expired", "upload-size-mismatch",
  "upload-hash-mismatch", "range-not-satisfiable", "internal",
] as const;
const ERROR_CODES = new Set<string>(STASH_ERROR_CODES);

export type StashErrorCode = (typeof STASH_ERROR_CODES)[number];
export type NormalizedStashErrorCode = StashErrorCode | "unknown";

export interface StashApiOptions {
  baseUrl: string | undefined;
  stash: string | undefined;
  readToken: string | undefined;
  writeToken: string | undefined;
  /** The only injected transport. */
  fetch: FetchLike;
}

export interface StashConflict {
  path: string;
  expectedVersion: number | null;
}

export class StashConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StashConfigurationError";
  }
}

/** Bounded remote failure. No upstream message, response, current head, or credential is retained. */
export class StashApiError extends Error {
  readonly status: number;
  readonly code: NormalizedStashErrorCode;
  readonly conflicts?: readonly StashConflict[];

  constructor(status: number, code: NormalizedStashErrorCode, conflicts?: readonly StashConflict[]) {
    super(`Stash API request failed with status ${status} and code ${code}`);
    this.name = "StashApiError";
    this.status = status;
    this.code = code;
    if (conflicts !== undefined && conflicts.length > 0) this.conflicts = conflicts;
  }
}

export interface StashFile {
  path: typeof POLICY_DOC_PATH;
  version: number;
  body: string | null;
  responseEtag: string;
  stashVersion: number;
}

export type GetFileResult =
  | { kind: "file"; file: StashFile }
  | { kind: "not-modified"; responseEtag: string; stashVersion: number };

export type ChangeSetStatus = "open" | "applied" | "rejected" | "expired";
export type ChangeSetEntryOp = "put" | "copy" | "delete" | "rollback";

export interface ChangeSetEntry {
  path: typeof POLICY_DOC_PATH;
  op: ChangeSetEntryOp;
  baseVersion: number | null;
  stale: boolean;
}

export interface ChangeSet {
  id: string;
  status: ChangeSetStatus;
  expiresAt: string;
  commitId: string | null;
  entries: ChangeSetEntry[];
}

export interface ChangeSetPage {
  changeSets: ChangeSet[];
  nextAfter: string | null;
  total: number;
}

export type ChangeSetDiff =
  | { state: "same" }
  | { state: "binary" }
  | { state: "oversized" }
  | { state: "ready"; unified: string; truncated: boolean };

export interface ChangeSetDiffResult {
  entries: Array<{ path: typeof POLICY_DOC_PATH; op: ChangeSetEntryOp; stale: boolean; diff: ChangeSetDiff }>;
  stale: boolean;
  status: ChangeSetStatus;
  truncated: boolean;
}

export interface ApproveResult {
  status: "applied";
  commit: {
    id: string;
    entries: Array<{ path: typeof POLICY_DOC_PATH; version: number; kind: "put" | "delete" | "rollback" }>;
  };
}

export interface HistoryPage {
  path: typeof POLICY_DOC_PATH;
  headVersion: number;
  deleted: boolean;
  total: number;
  versions: Array<{
    version: number;
    kind: "put" | "delete" | "rollback";
    hash: string | null;
    createdAt: string;
  }>;
  nextBefore: number | null;
}

export interface RollbackResult {
  commitId: string;
  version: number;
  hash: string;
  rollbackOf: number;
  identicalToHead: boolean;
  changeId: number;
  createdAt: string;
}

export interface CreateChangeSetInput {
  jobId: string;
  path?: string;
  body: string;
  baseVersion: number;
  contentType?: string;
  author?: string;
  message?: string;
  expiresAt?: string;
  signal?: AbortSignal;
}

export interface StashApi {
  getFile(input?: { path?: string; ifNoneMatch?: string; signal?: AbortSignal }): Promise<GetFileResult>;
  createChangeSet(input: CreateChangeSetInput): Promise<ChangeSet>;
  listChangeSets(input: { status: "open" | "all"; path?: string; limit: number; after?: string; signal?: AbortSignal }): Promise<ChangeSetPage>;
  getChangeSet(input: { id: string; signal?: AbortSignal }): Promise<ChangeSet>;
  getChangeSetDiff(input: { id: string; path?: string; context?: number; signal?: AbortSignal }): Promise<ChangeSetDiffResult>;
  approveChangeSet(input: { id: string; author?: string; message?: string; signal?: AbortSignal }): Promise<ApproveResult>;
  rejectChangeSet(input: { id: string; reason?: string; signal?: AbortSignal }): Promise<ChangeSet>;
  getHistory(input: { path?: string; limit: number; before?: number; signal?: AbortSignal }): Promise<HistoryPage>;
  rollback(input: { path?: string; toVersion: number; expectedVersion: number; author?: string; message?: string; signal?: AbortSignal }): Promise<RollbackResult>;
}

interface Context {
  baseUrl: string;
  stash: string;
  readToken: string | undefined;
  writeToken: string | undefined;
  fetch: FetchLike;
}

export function assertPolicyPath(path: string): asserts path is typeof POLICY_DOC_PATH {
  if (path !== POLICY_DOC_PATH) throw new StashConfigurationError(`stash access is restricted to ${POLICY_DOC_PATH}`);
}

/** Kept byte-for-byte aligned with src/github/api.ts's safe job-id character constraint. */
export function assertJobId(jobId: string): void {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw new StashConfigurationError("policy job id is invalid");
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new StashConfigurationError("STASH_BASE_URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new StashConfigurationError("STASH_BASE_URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^\/*$/.test(parsed.pathname)
  ) {
    throw new StashConfigurationError("STASH_BASE_URL must be an https origin");
  }
  return parsed.origin;
}

function normalizeStash(value: string | undefined): string {
  if (typeof value !== "string" || !STASH_PATTERN.test(value)) {
    throw new StashConfigurationError("STASH_NAME is invalid");
  }
  return value;
}

function tokenFor(ctx: Context, kind: "read" | "write"): string {
  const token = kind === "read" ? ctx.readToken : ctx.writeToken;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new StashConfigurationError(kind === "read" ? "STASH_READ_TOKEN is invalid" : "STASH_WRITE_TOKEN is invalid");
  }
  return token;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function assertChangeSetId(value: string): void {
  if (!CHANGE_SET_ID_PATTERN.test(value)) throw new StashConfigurationError("change-set id is invalid");
}

function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new StashConfigurationError(`${name} is invalid`);
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new StashConfigurationError("limit is invalid");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullablePositive(value: unknown): value is number | null {
  return value === null || isPositive(value);
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalidSuccess(status: number): never {
  throw new StashApiError(status, "unknown");
}

async function parseSuccess(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return invalidSuccess(response.status);
  }
}

function normalizeCode(value: unknown): NormalizedStashErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value)
    ? value as StashErrorCode
    : "unknown";
}

function normalizeConflicts(payload: unknown, status: number): StashConflict[] | undefined {
  if ((status !== 409 && status !== 404) || !isObject(payload) || !Array.isArray(payload.conflicts)) return undefined;
  const output: StashConflict[] = [];
  for (const conflict of payload.conflicts.slice(0, MAX_CONFLICTS)) {
    if (!isObject(conflict) || typeof conflict.path !== "string" || conflict.path.length < 1 || utf8Bytes(conflict.path) > 512) continue;
    if (!(conflict.expectedVersion === null || isPositive(conflict.expectedVersion))) continue;
    output.push({ path: conflict.path, expectedVersion: conflict.expectedVersion });
  }
  return output.length === 0 ? undefined : output;
}

async function remoteError(response: Response): Promise<never> {
  let payload: unknown;
  try {
    const text = await response.text();
    payload = text.length <= MAX_ERROR_BODY_CHARS ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  const code = normalizeCode(isObject(payload) && isObject(payload.error) ? payload.error.code : undefined);
  throw new StashApiError(response.status, code, normalizeConflicts(payload, response.status));
}

async function request(
  ctx: Context,
  tokenKind: "read" | "write",
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = tokenFor(ctx, tokenKind);
  let response: Response;
  try {
    response = await ctx.fetch(`${ctx.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
  } catch {
    throw new StashApiError(0, "unknown");
  }
  if (!response.ok && response.status !== 304) return remoteError(response);
  return response;
}

function responseHeaders(response: Response): { responseEtag: string; stashVersion: number } {
  const responseEtag = response.headers.get("ETag");
  const rawVersion = response.headers.get("X-Stash-Version");
  const stashVersion = rawVersion === null ? NaN : Number(rawVersion);
  if (responseEtag === null || !QUOTED_ETAG_PATTERN.test(responseEtag) || !isPositive(stashVersion)) {
    return invalidSuccess(response.status);
  }
  return { responseEtag, stashVersion };
}

function parseEntry(value: unknown, status: number): ChangeSetEntry {
  if (!isObject(value) || value.path !== POLICY_DOC_PATH || !["put", "copy", "delete", "rollback"].includes(String(value.op)) || !isNullablePositive(value.baseVersion) || typeof value.stale !== "boolean") {
    return invalidSuccess(status);
  }
  return { path: value.path, op: value.op as ChangeSetEntryOp, baseVersion: value.baseVersion, stale: value.stale };
}

function parseChangeSet(value: unknown, status: number): ChangeSet {
  const changeSetStatus = isObject(value) && typeof value.status === "string" ? value.status : undefined;
  if (
    !isObject(value) ||
    !CHANGE_SET_ID_PATTERN.test(String(value.id)) ||
    !["open", "applied", "rejected", "expired"].includes(String(changeSetStatus)) ||
    !isIso(value.expiresAt) ||
    !(changeSetStatus === "applied"
      ? isNonEmptyString(value.commitId) && COMMIT_ID_PATTERN.test(value.commitId)
      : value.commitId === null) ||
    !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_CHANGE_SET_ENTRIES
  ) return invalidSuccess(status);
  return {
    id: value.id as string,
    status: value.status as ChangeSetStatus,
    expiresAt: value.expiresAt,
    commitId: changeSetStatus === "applied" ? value.commitId as string : null,
    entries: value.entries.map((entry) => parseEntry(entry, status)),
  };
}

function parseDiff(value: unknown, status: number): ChangeSetDiff {
  if (!isObject(value) || typeof value.state !== "string") return invalidSuccess(status);
  if (value.state === "same" || value.state === "binary" || value.state === "oversized") return { state: value.state };
  if (value.state !== "ready" || typeof value.unified !== "string" || utf8Bytes(value.unified) > MAX_DIFF_BYTES || typeof value.truncated !== "boolean") {
    return invalidSuccess(status);
  }
  return { state: "ready", unified: value.unified, truncated: value.truncated };
}

export function createStashApi(options: StashApiOptions): StashApi {
  const ctx: Context = {
    baseUrl: normalizeBaseUrl(options.baseUrl),
    stash: normalizeStash(options.stash),
    readToken: options.readToken,
    writeToken: options.writeToken,
    fetch: options.fetch,
  };
  const stashRoot = `/v1/stashes/${encodeURIComponent(ctx.stash)}`;

  return {
    async getFile(input = {}) {
      const path = input.path ?? POLICY_DOC_PATH;
      assertPolicyPath(path);
      if (input.ifNoneMatch !== undefined && !QUOTED_ETAG_PATTERN.test(input.ifNoneMatch)) {
        throw new StashConfigurationError("If-None-Match must be an exact quoted ETag");
      }
      const response = await request(ctx, "read", `${stashRoot}/files/${encodePath(path)}`, {
        headers: input.ifNoneMatch === undefined ? {} : { "If-None-Match": input.ifNoneMatch },
        signal: input.signal,
      });
      if (response.status !== 200 && response.status !== 304) return invalidSuccess(response.status);
      const headers = responseHeaders(response);
      if (response.status === 304) return { kind: "not-modified", ...headers };
      const payload = await parseSuccess(response);
      if (!isObject(payload) || payload.path !== path || !isPositive(payload.version) || payload.version !== headers.stashVersion || !(typeof payload.body === "string" || payload.body === null) || (typeof payload.body === "string" && utf8Bytes(payload.body) > MAX_INLINE_BODY_BYTES) || payload.deleted !== false) {
        return invalidSuccess(response.status);
      }
      return { kind: "file", file: { path, version: payload.version, body: payload.body, ...headers } };
    },

    async createChangeSet(input) {
      const path = input.path ?? POLICY_DOC_PATH;
      assertPolicyPath(path);
      assertJobId(input.jobId);
      assertPositive(input.baseVersion, "baseVersion");
      if (input.expiresAt !== undefined && !isIso(input.expiresAt)) throw new StashConfigurationError("expiresAt is invalid");
      const entry = { op: "put", path, baseVersion: input.baseVersion, body: input.body, contentType: input.contentType ?? "text/markdown; charset=utf-8" };
      const body = {
        entries: [entry],
        ...(input.author === undefined ? {} : { author: input.author }),
        ...(input.message === undefined ? {} : { message: input.message }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      };
      const response = await request(ctx, "write", `${stashRoot}/change-sets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `policy-job-${input.jobId}` },
        body: JSON.stringify(body),
        signal: input.signal,
      });
      if (response.status !== 201) return invalidSuccess(response.status);
      const created = parseChangeSet(await parseSuccess(response), response.status);
      if (created.entries.length !== 1 || created.entries[0]?.op !== "put" || created.entries[0].baseVersion !== input.baseVersion) {
        return invalidSuccess(response.status);
      }
      return created;
    },

    async listChangeSets(input) {
      assertLimit(input.limit);
      const path = input.path ?? POLICY_DOC_PATH;
      assertPolicyPath(path);
      const query = new URLSearchParams({ status: input.status, path, limit: String(input.limit) });
      if (input.after !== undefined) query.set("after", input.after);
      const response = await request(ctx, "read", `${stashRoot}/change-sets?${query}`, { signal: input.signal });
      if (response.status !== 200) return invalidSuccess(response.status);
      const payload = await parseSuccess(response);
      if (!isObject(payload) || !Array.isArray(payload.changeSets) || payload.changeSets.length > input.limit || payload.changeSets.length > MAX_PAGE_ITEMS || !(payload.nextAfter === null || typeof payload.nextAfter === "string") || !isNonNegative(payload.total)) {
        return invalidSuccess(response.status);
      }
      return { changeSets: payload.changeSets.map((set) => parseChangeSet(set, response.status)), nextAfter: payload.nextAfter, total: payload.total };
    },

    async getChangeSet(input) {
      assertChangeSetId(input.id);
      const response = await request(ctx, "read", `${stashRoot}/change-sets/${encodeURIComponent(input.id)}`, { signal: input.signal });
      if (response.status !== 200) return invalidSuccess(response.status);
      return parseChangeSet(await parseSuccess(response), response.status);
    },

    async getChangeSetDiff(input) {
      assertChangeSetId(input.id);
      const query = new URLSearchParams();
      if (input.path !== undefined) {
        assertPolicyPath(input.path);
        query.set("path", input.path);
      }
      if (input.context !== undefined) {
        if (!Number.isSafeInteger(input.context) || input.context < 0) throw new StashConfigurationError("context is invalid");
        query.set("context", String(input.context));
      }
      const suffix = query.size === 0 ? "" : `?${query}`;
      const response = await request(ctx, "read", `${stashRoot}/change-sets/${encodeURIComponent(input.id)}/diff${suffix}`, { signal: input.signal });
      if (response.status !== 200) return invalidSuccess(response.status);
      const payload = await parseSuccess(response);
      if (!isObject(payload) || !Array.isArray(payload.entries) || payload.entries.length > MAX_CHANGE_SET_ENTRIES || typeof payload.stale !== "boolean" || !["open", "applied", "rejected", "expired"].includes(String(payload.status)) || typeof payload.truncated !== "boolean") {
        return invalidSuccess(response.status);
      }
      const entries: ChangeSetDiffResult["entries"] = payload.entries.map((entry) => {
        if (!isObject(entry) || entry.path !== POLICY_DOC_PATH || !["put", "copy", "delete", "rollback"].includes(String(entry.op)) || typeof entry.stale !== "boolean") {
          return invalidSuccess(response.status);
        }
        return { path: POLICY_DOC_PATH, op: entry.op as ChangeSetEntryOp, stale: entry.stale, diff: parseDiff(entry.diff, response.status) };
      });
      return { entries, stale: payload.stale, status: payload.status as ChangeSetStatus, truncated: payload.truncated };
    },

    async approveChangeSet(input) {
      assertChangeSetId(input.id);
      const body = { ...(input.author === undefined ? {} : { author: input.author }), ...(input.message === undefined ? {} : { message: input.message }) };
      const response = await request(ctx, "write", `${stashRoot}/change-sets/${encodeURIComponent(input.id)}/approve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: input.signal,
      });
      if (response.status !== 200) return invalidSuccess(response.status);
      const payload = await parseSuccess(response);
      if (!isObject(payload) || payload.status !== "applied" || !isObject(payload.commit) || !isNonEmptyString(payload.commit.id) || !COMMIT_ID_PATTERN.test(payload.commit.id) || !Array.isArray(payload.commit.entries) || payload.commit.entries.length < 1 || payload.commit.entries.length > MAX_CHANGE_SET_ENTRIES) {
        return invalidSuccess(response.status);
      }
      const entries: ApproveResult["commit"]["entries"] = payload.commit.entries.map((entry) => {
        if (!isObject(entry) || entry.path !== POLICY_DOC_PATH || !isPositive(entry.version) || !["put", "delete", "rollback"].includes(String(entry.kind))) return invalidSuccess(response.status);
        return { path: POLICY_DOC_PATH, version: entry.version, kind: entry.kind as "put" | "delete" | "rollback" };
      });
      return { status: "applied", commit: { id: payload.commit.id, entries } };
    },

    async rejectChangeSet(input) {
      assertChangeSetId(input.id);
      const body = input.reason === undefined ? {} : { reason: input.reason };
      const response = await request(ctx, "write", `${stashRoot}/change-sets/${encodeURIComponent(input.id)}/reject`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: input.signal,
      });
      if (response.status !== 200) return invalidSuccess(response.status);
      const rejected = parseChangeSet(await parseSuccess(response), response.status);
      if (rejected.status !== "rejected") return invalidSuccess(response.status);
      return rejected;
    },

    async getHistory(input) {
      assertLimit(input.limit);
      const path = input.path ?? POLICY_DOC_PATH;
      assertPolicyPath(path);
      const query = new URLSearchParams({ limit: String(input.limit) });
      if (input.before !== undefined) {
        assertPositive(input.before, "before");
        query.set("before", String(input.before));
      }
      const response = await request(ctx, "read", `${stashRoot}/history/${encodePath(path)}?${query}`, { signal: input.signal });
      if (response.status !== 200) return invalidSuccess(response.status);
      const payload = await parseSuccess(response);
      if (!isObject(payload) || payload.path !== path || !isPositive(payload.headVersion) || typeof payload.deleted !== "boolean" || !isNonNegative(payload.total) || !Array.isArray(payload.versions) || payload.versions.length > input.limit || payload.versions.length > MAX_PAGE_ITEMS || !(payload.nextBefore === null || isPositive(payload.nextBefore))) {
        return invalidSuccess(response.status);
      }
      const versions = payload.versions.map((version) => {
        if (!isObject(version) || !isPositive(version.version) || !["put", "delete", "rollback"].includes(String(version.kind)) || !(version.hash === null || isNonEmptyString(version.hash)) || !isIso(version.createdAt)) return invalidSuccess(response.status);
        return { version: version.version, kind: version.kind as "put" | "delete" | "rollback", hash: version.hash, createdAt: version.createdAt };
      });
      return { path, headVersion: payload.headVersion, deleted: payload.deleted, total: payload.total, versions, nextBefore: payload.nextBefore };
    },

    async rollback(input) {
      const path = input.path ?? POLICY_DOC_PATH;
      assertPolicyPath(path);
      assertPositive(input.toVersion, "toVersion");
      assertPositive(input.expectedVersion, "expectedVersion");
      const body = {
        toVersion: input.toVersion,
        expectedVersion: input.expectedVersion,
        ...(input.author === undefined ? {} : { author: input.author }),
        ...(input.message === undefined ? {} : { message: input.message }),
      };
      const response = await request(ctx, "write", `${stashRoot}/rollback/${encodePath(path)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: input.signal,
      });
      if (response.status !== 201) return invalidSuccess(response.status);
      const payload = await parseSuccess(response);
      if (!isObject(payload) || !isNonEmptyString(payload.commitId) || !COMMIT_ID_PATTERN.test(payload.commitId) || payload.version !== input.expectedVersion + 1 || !isNonEmptyString(payload.hash) || payload.rollbackOf !== input.toVersion || typeof payload.identicalToHead !== "boolean" || !isPositive(payload.changeId) || !isIso(payload.createdAt)) {
        return invalidSuccess(response.status);
      }
      return { commitId: payload.commitId, version: payload.version, hash: payload.hash, rollbackOf: payload.rollbackOf, identicalToHead: payload.identicalToHead, changeId: payload.changeId, createdAt: payload.createdAt };
    },
  };
}
