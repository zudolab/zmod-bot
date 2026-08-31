/**
 * Fail-open live policy resolution.
 *
 * The constructed reader owns only isolate-local cache state. All I/O is
 * injected per read, which keeps tests deterministic and lets the exported
 * singleton share a cache without capturing one request's Worker bindings.
 */
import type { PolicyLastKnownGoodRow } from "../db/schema";
import type { Env } from "../env";
import {
  POLICY_DOC_PATH,
  POLICY_HEADER,
  POLICY_MAX_BYTES,
  POLICY_REQUIRED_HEADINGS,
} from "../policy/contract";
import { POLICY_CONTENT } from "../policy/generated";
import type { FetchLike, NowFn } from "../types";
import { DeadlineExceededError, withDeadline } from "../llm/guards";
import { log } from "../ops/log";
import {
  createStashApi,
  StashApiError,
  type NormalizedStashErrorCode,
} from "./api";
import {
  getPolicyLastKnownGood,
  putPolicyLastKnownGood,
  type PutPolicyLastKnownGoodInput,
} from "./policy-store";

export const POLICY_CACHE_TTL_MS = 30_000;
export const POLICY_READ_DEADLINE_MS = 1_500;

export type LivePolicySource = "cache" | "stash" | "last_known_good" | "compiled";

export interface LivePolicyResult {
  document: string;
  source: LivePolicySource;
  ageMs: number;
}

/** Closed warning shape: it deliberately has no free-text or body field. */
export interface PolicyReadWarning {
  source: "last_known_good" | "compiled";
  configured: true;
  status: number;
  normalizedCode: NormalizedStashErrorCode;
  count: 1;
  ageMs: number;
}

export interface PolicyReaderStore {
  get(): Promise<PolicyLastKnownGoodRow | null>;
  put(input: PutPolicyLastKnownGoodInput): Promise<boolean>;
}

export interface ConstructedPolicyReadInput {
  baseUrl: string | undefined;
  stash: string | undefined;
  readToken: string | undefined;
  fetch: FetchLike;
  store: PolicyReaderStore;
  now: NowFn;
  warn?: (warning: PolicyReadWarning) => void;
}

export interface LivePolicyReadInput {
  env: Pick<Env, "DB" | "STASH_BASE_URL" | "STASH_NAME" | "STASH_READ_TOKEN">;
  fetch: FetchLike;
  now?: NowFn;
}

export interface PolicyReader {
  readLivePolicy(input: ConstructedPolicyReadInput): Promise<LivePolicyResult>;
  /** Invalidates both fresh and expired cache identities. */
  invalidate(): void;
  /** Explicit alias used by tests to prevent isolate cache leakage. */
  reset(): void;
}

interface ConfirmedPolicy {
  document: string;
  version: number;
  etag: string;
  confirmedAt: number;
}

interface FailureSummary {
  status: number;
  code: NormalizedStashErrorCode;
}

const TOKEN_PATTERN = /^zhs_[A-Za-z0-9_-]{43}$/;
const STASH_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const QUOTED_ETAG_PATTERN = /^"[^"\r\n]+"$/;
const textEncoder = new TextEncoder();

/** Read validation is intentionally narrower than policy edit validation. */
export function isStructurallyValidPolicy(document: unknown): document is string {
  if (typeof document !== "string" || !document.startsWith(`${POLICY_HEADER}\n`)) return false;

  let previousHeadingIndex = -1;
  for (const heading of POLICY_REQUIRED_HEADINGS) {
    const headingIndex = document.indexOf(`\n${heading}\n`);
    if (headingIndex === -1 || headingIndex <= previousHeadingIndex) return false;
    previousHeadingIndex = headingIndex;
  }

  return textEncoder.encode(document).byteLength <= POLICY_MAX_BYTES;
}

export function createPolicyReader(): PolicyReader {
  let cache: ConfirmedPolicy | null = null;
  let generation = 0;

  function invalidate(): void {
    cache = null;
    generation += 1;
  }

  async function readLivePolicy(input: ConstructedPolicyReadInput): Promise<LivePolicyResult> {
    if (!hasCompleteReadConfig(input)) return compiledResult();

    const startedGeneration = generation;
    const nowMs = safeNow(input.now);
    const cached = validConfirmedPolicy(cache);
    if (cached !== null && ageMs(nowMs, cached.confirmedAt) < POLICY_CACHE_TTL_MS) {
      return resultFromConfirmed(cached, "cache", nowMs);
    }

    let stored = await safeGet(input.store);
    let baseline = newerConfirmed(cached, stored);
    let failure: FailureSummary = { status: 0, code: "unknown" };

    try {
      const api = createStashApi({
        baseUrl: input.baseUrl,
        stash: input.stash,
        readToken: input.readToken,
        writeToken: undefined,
        fetch: input.fetch,
      });
      const abortController = new AbortController();
      let remote;
      try {
        remote = await withDeadline(
          api.getFile({
            ...(baseline === null ? {} : { ifNoneMatch: baseline.etag }),
            signal: abortController.signal,
          }),
          POLICY_READ_DEADLINE_MS,
        );
      } catch (error) {
        if (error instanceof DeadlineExceededError) abortController.abort();
        throw error;
      }

      failure = { status: remote.kind === "not-modified" ? 304 : 200, code: "unknown" };
      const confirmed = confirmedFromRemote(remote, baseline, safeNow(input.now));
      if (
        confirmed !== null
        && startedGeneration === generation
        && !isOlderOrConflicting(confirmed, baseline)
        && !isOlderOrConflicting(confirmed, cache)
      ) {
        const persisted = await safePut(input.store, confirmed);
        if (persisted) {
          if (startedGeneration === generation && installCache(confirmed)) {
            return { document: confirmed.document, source: "stash", ageMs: 0 };
          }
        } else {
          // A false fence commonly means a newer concurrent write won. Read
          // that identity once so the stale response cannot become fallback.
          stored = newerConfirmed(stored, await safeGet(input.store));
          baseline = newerConfirmed(baseline, stored);
        }
      }
    } catch (error) {
      failure = summarizeFailure(error);
    }

    // Re-check storage after a stale/fenced result. Only D1 is an allowed
    // degraded layer; an expired in-memory value is never silently revived.
    const fallback = newerConfirmed(stored, await safeGet(input.store));
    const selected = fallback === null
      ? compiledResult()
      : resultFromConfirmed(fallback, "last_known_good", safeNow(input.now));
    safeWarn(input.warn, {
      source: selected.source === "last_known_good" ? "last_known_good" : "compiled",
      configured: true,
      status: failure.status,
      normalizedCode: failure.code,
      count: 1,
      ageMs: selected.ageMs,
    });
    return selected;
  }

  function installCache(candidate: ConfirmedPolicy): boolean {
    if (isOlderOrConflicting(candidate, cache)) return false;
    cache = candidate;
    return true;
  }

  return { readLivePolicy, invalidate, reset: invalidate };
}

const isolateReader = createPolicyReader();

/** Production isolate singleton. The Worker request still injects fetch, clock, env, and D1. */
export async function readLivePolicy(input: LivePolicyReadInput): Promise<LivePolicyResult> {
  try {
    const now = input.now ?? (() => new Date());
    return await isolateReader.readLivePolicy({
      baseUrl: input.env.STASH_BASE_URL,
      stash: input.env.STASH_NAME,
      readToken: input.env.STASH_READ_TOKEN,
      fetch: input.fetch,
      now,
      store: {
        get: () => getPolicyLastKnownGood({ db: input.env.DB, now }),
        put: (candidate) => putPolicyLastKnownGood({ db: input.env.DB, now }, candidate),
      },
      warn: logPolicyWarning,
    });
  } catch {
    // The constructed path already absorbs expected remote/storage failures.
    // This final guard protects the public never-reject contract from an
    // unexpected dependency or runtime failure without exposing it.
    return compiledResult();
  }
}

/** Called only after a successful policy approve or rollback. */
export function invalidateLivePolicyCache(): void {
  isolateReader.invalidate();
}

/** Keeps the production singleton from leaking cache identities between tests. */
export function resetLivePolicyReaderForTests(): void {
  isolateReader.reset();
}

function hasCompleteReadConfig(input: Pick<ConstructedPolicyReadInput, "baseUrl" | "stash" | "readToken">): boolean {
  if (typeof input.baseUrl !== "string" || typeof input.stash !== "string" || typeof input.readToken !== "string") {
    return false;
  }
  if (!STASH_PATTERN.test(input.stash) || !TOKEN_PATTERN.test(input.readToken)) return false;
  try {
    const parsed = new URL(input.baseUrl);
    return input.baseUrl === input.baseUrl.trim()
      && parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && /^\/*$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function confirmedFromRemote(
  remote: Awaited<ReturnType<ReturnType<typeof createStashApi>["getFile"]>>,
  baseline: ConfirmedPolicy | null,
  confirmedAt: number,
): ConfirmedPolicy | null {
  if (remote.kind === "not-modified") {
    if (
      baseline === null
      || remote.stashVersion !== baseline.version
      || remote.responseEtag !== baseline.etag
    ) return null;
    return { ...baseline, etag: remote.responseEtag, confirmedAt };
  }

  const file = remote.file;
  if (!isStructurallyValidPolicy(file.body)) return null;
  return {
    document: file.body,
    version: file.version,
    etag: file.responseEtag,
    confirmedAt,
  };
}

function validConfirmedPolicy(value: ConfirmedPolicy | null): ConfirmedPolicy | null {
  if (
    value === null
    || !isStructurallyValidPolicy(value.document)
    || !Number.isSafeInteger(value.version)
    || value.version < 1
    || !QUOTED_ETAG_PATTERN.test(value.etag)
    || !Number.isFinite(value.confirmedAt)
    || value.confirmedAt < 0
  ) return null;
  return value;
}

function confirmedFromRow(row: PolicyLastKnownGoodRow | null): ConfirmedPolicy | null {
  if (row === null || row.path !== POLICY_DOC_PATH) return null;
  return validConfirmedPolicy({
    document: row.document,
    version: row.version,
    etag: row.etag,
    confirmedAt: row.confirmed_at,
  });
}

async function safeGet(store: PolicyReaderStore): Promise<ConfirmedPolicy | null> {
  try {
    return confirmedFromRow(await store.get());
  } catch {
    return null;
  }
}

async function safePut(store: PolicyReaderStore, candidate: ConfirmedPolicy): Promise<boolean> {
  try {
    return await store.put({
      version: candidate.version,
      document: candidate.document,
      etag: candidate.etag,
    });
  } catch {
    return false;
  }
}

function newerConfirmed(left: ConfirmedPolicy | null, right: ConfirmedPolicy | null): ConfirmedPolicy | null {
  if (left === null) return right;
  if (right === null) return left;
  if (right.version > left.version) return right;
  if (right.version < left.version) return left;
  if (right.document === left.document && right.etag === left.etag && right.confirmedAt > left.confirmedAt) return right;
  return left;
}

function isOlderOrConflicting(candidate: ConfirmedPolicy, current: ConfirmedPolicy | null): boolean {
  const validCurrent = validConfirmedPolicy(current);
  if (validCurrent === null) return false;
  return candidate.version < validCurrent.version
    || (candidate.version === validCurrent.version
      && (candidate.document !== validCurrent.document || candidate.etag !== validCurrent.etag));
}

function safeNow(now: NowFn): number {
  try {
    const value = now().getTime();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function ageMs(nowMs: number, confirmedAt: number): number {
  const age = nowMs - confirmedAt;
  return Number.isFinite(age) ? Math.max(0, age) : 0;
}

function resultFromConfirmed(
  policy: ConfirmedPolicy,
  source: "cache" | "last_known_good",
  nowMs: number,
): LivePolicyResult {
  return { document: policy.document, source, ageMs: ageMs(nowMs, policy.confirmedAt) };
}

function compiledResult(): LivePolicyResult {
  return { document: POLICY_CONTENT, source: "compiled", ageMs: 0 };
}

function summarizeFailure(error: unknown): FailureSummary {
  return error instanceof StashApiError
    ? { status: error.status, code: error.code }
    : { status: 0, code: "unknown" };
}

function safeWarn(warn: ConstructedPolicyReadInput["warn"], warning: PolicyReadWarning): void {
  try {
    warn?.(warning);
  } catch {
    // A diagnostic sink can never turn the fail-open read into a failure.
  }
}

function logPolicyWarning(warning: PolicyReadWarning): void {
  log("warn", "policy.live.degraded", { ...warning });
}
