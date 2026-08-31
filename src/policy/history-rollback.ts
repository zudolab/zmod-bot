/**
 * Stash-only policy history and rollback commands.
 *
 * These commands deliberately share the durable `policy_update` job kind
 * with the proposal route, but never share its GitHub fallback. The history
 * surface contains only bounded, safe version metadata; rollback is fenced
 * by an authoritative head read and the stash API's expected-version check.
 *
 * This module owns no logging. In particular, a remote error's message,
 * response body, policy document, or credential must never reach Slack or a
 * log line.
 */
import type { Env } from "../env";
import {
  buildMessagePayload,
  mrkdwnSection,
  type SlackMessagePayload,
} from "../slack/blocks";
import type { PolicyCommand } from "../slack/commands";
import type { FetchLike, NowFn } from "../types";
import {
  createStashApi,
  StashApiError,
  StashConfigurationError,
  StashTransportError,
  type HistoryPage,
  type RollbackResult,
  type StashApi,
} from "../stash/api";
import { invalidateLivePolicyCache } from "../stash/policy-reader";
import { adoptPolicyRollbackAttempt } from "../stash/rollback-attempt-store";
import { POLICY_DOC_PATH } from "./contract";

/** One history request is kept below the stash API's hard limit. */
export const POLICY_HISTORY_PAGE_SIZE = 50;
/** A malformed or never-ending cursor cannot hold a Worker open forever. */
export const POLICY_HISTORY_MAX_PAGES = 20;
/** Bound the amount of remote metadata retained by one command. */
export const POLICY_HISTORY_MAX_ITEMS = 500;
/** Keep the rendered list comfortably inside Slack's section ceiling. */
export const POLICY_HISTORY_MAX_RENDERED_ITEMS = 50;
/** History and rollback share the same bounded remote operation. */
export const POLICY_STASH_OPERATION_DEADLINE_MS = 5_000;
/** The complete history scan has a finite wall-clock bound. */
export const POLICY_HISTORY_SCAN_DEADLINE_MS = 15_000;

/** A transport/deadline failure must reach the durable job retry path. */
class PolicyStashOperationTimeoutError extends Error {
  constructor() {
    super("stash operation deadline exceeded");
    this.name = "PolicyStashOperationTimeoutError";
  }
}

/** A bounded response/shape failure is terminal, but never exposes its detail. */
class PolicyHistoryValidationError extends Error {
  constructor() {
    super("stash policy response validation failed");
    this.name = "PolicyHistoryValidationError";
  }
}

export interface PolicyHistoryRollbackDeps {
  env: Env;
  fetch: FetchLike;
  now: NowFn;
  stashApi?: StashApi;
  /** Injected for tests; production uses the same-isolate reader cache. */
  invalidatePolicyCache?: () => void;
}

export interface PolicyHistoryRollbackInput {
  jobId: number;
  command: PolicyCommand;
}

type PolicyRollbackInput = Omit<PolicyHistoryRollbackInput, "command"> & {
  command: Extract<PolicyCommand, { operation: "rollback" }>;
};

interface CollectedHistory {
  headVersion: number;
  deleted: boolean;
  versions: HistoryPage["versions"];
  truncated: boolean;
}

interface HistoryVersion {
  version: number;
  kind: "put" | "delete" | "rollback";
  rollbackOf: number | null;
  createdAt: string;
}

const HISTORY_KIND_LABEL: Record<HistoryVersion["kind"], string> = {
  put: "更新",
  delete: "削除",
  rollback: "ロールバック",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function withDeadline<T>(
  milliseconds: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const pending = work(controller.signal);
  // A transport that ignores AbortSignal must not leave a late rejection
  // unhandled after the bounded operation has returned.
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PolicyStashOperationTimeoutError());
      }, milliseconds);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function parseHistoryVersion(value: unknown): HistoryVersion {
  if (
    !isRecord(value)
    || !isPositiveInteger(value.version)
    || (value.kind !== "put" && value.kind !== "delete" && value.kind !== "rollback")
    || !(value.rollbackOf === null || isPositiveInteger(value.rollbackOf))
    || !isIsoTimestamp(value.createdAt)
  ) {
    throw new PolicyHistoryValidationError();
  }
  return { version: value.version, kind: value.kind, rollbackOf: value.rollbackOf, createdAt: value.createdAt };
}

function parseHistoryPage(value: unknown): HistoryPage {
  if (!isRecord(value)) throw new PolicyHistoryValidationError();
  if (
    value.path !== POLICY_DOC_PATH
    || !isPositiveInteger(value.headVersion)
    || typeof value.deleted !== "boolean"
    || !isNonNegativeInteger(value.total)
    || !Array.isArray(value.versions)
    || value.versions.length > POLICY_HISTORY_PAGE_SIZE
    || !(value.nextBefore === null || isPositiveInteger(value.nextBefore))
  ) {
    throw new PolicyHistoryValidationError();
  }
  const versions = value.versions.map(parseHistoryVersion).map((version) => ({
    ...version,
    hash: null,
  }));
  return {
    path: POLICY_DOC_PATH,
    headVersion: value.headVersion,
    deleted: value.deleted,
    total: value.total,
    versions,
    nextBefore: value.nextBefore,
  };
}

async function collectHistory(stash: StashApi): Promise<CollectedHistory> {
  return withDeadline(POLICY_HISTORY_SCAN_DEADLINE_MS, async (signal) => {
    const versions: HistoryPage["versions"] = [];
    const cursors = new Set<number>();
    let before: number | undefined;
    let headVersion: number | undefined;
    let deleted = false;
    let truncated = false;

    for (let pageNumber = 0; pageNumber < POLICY_HISTORY_MAX_PAGES; pageNumber += 1) {
      if (before !== undefined) {
        if (cursors.has(before)) throw new PolicyHistoryValidationError();
        cursors.add(before);
      }

      const page = parseHistoryPage(await stash.getHistory({
        path: POLICY_DOC_PATH,
        limit: POLICY_HISTORY_PAGE_SIZE,
        ...(before === undefined ? {} : { before }),
        signal,
      }));
      headVersion ??= page.headVersion;
      deleted = page.deleted;

      if (page.versions.length === 0 && page.nextBefore !== null) {
        throw new PolicyHistoryValidationError();
      }

      for (const version of page.versions) {
        if (versions.length >= POLICY_HISTORY_MAX_ITEMS) {
          truncated = true;
          break;
        }
        versions.push(version);
      }
      if (versions.length >= POLICY_HISTORY_MAX_ITEMS && page.nextBefore !== null) {
        truncated = true;
        break;
      }
      if (page.nextBefore === null) {
        return { headVersion: headVersion!, deleted, versions, truncated };
      }
      if (cursors.has(page.nextBefore)) throw new PolicyHistoryValidationError();
      before = page.nextBefore;
    }

    truncated = true;
    if (headVersion === undefined) throw new PolicyHistoryValidationError();
    return { headVersion, deleted, versions, truncated };
  });
}

function historyPayload(history: CollectedHistory): SlackMessagePayload {
  const lines = [`ポリシー履歴（現在のバージョン: v${history.headVersion}）`];
  if (history.deleted) lines.push("現在のポリシーは削除済みです。");
  if (history.versions.length === 0) {
    lines.push("履歴がありません。");
  } else {
    lines.push(
      ...history.versions.slice(0, POLICY_HISTORY_MAX_RENDERED_ITEMS).map(
        (version) => `v${version.version} — ${HISTORY_KIND_LABEL[version.kind]} — ${version.createdAt}`,
      ),
    );
  }
  if (history.truncated || history.versions.length > POLICY_HISTORY_MAX_RENDERED_ITEMS) {
    lines.push("履歴が多いため、一部のみ表示しています。");
  }
  return buildMessagePayload(
    [mrkdwnSection("policy_history", lines.join("\n"))],
    "ポリシー履歴",
  );
}

function isValidRollbackResult(value: RollbackResult, expectedVersion: number, targetVersion: number): boolean {
  return isPositiveInteger(value.version)
    && value.version === expectedVersion + 1
    && isPositiveInteger(value.rollbackOf)
    && value.rollbackOf === targetVersion
    && isPositiveInteger(value.changeId)
    && isIsoTimestamp(value.createdAt);
}

function rollbackPayload(version: number, rollbackOf: number): SlackMessagePayload {
  return buildMessagePayload(
    [mrkdwnSection(
      "policy_rollback",
      `ポリシーを v${rollbackOf} の内容へ戻しました。新しいバージョンは v${version} です。`,
    )],
    "ポリシーをロールバックしました",
  );
}

function refusalPayload(text: string): SlackMessagePayload {
  return buildMessagePayload([mrkdwnSection("policy_operation_error", text)], text);
}

function errorPayload(error: unknown, operation: PolicyCommand["operation"]): SlackMessagePayload {
  if (error instanceof StashConfigurationError) {
    return refusalPayload("Stashの設定が不足しているため、この操作は利用できません。");
  }
  if (error instanceof StashApiError) {
    if (error.code === "stale") {
      return refusalPayload("現在のポリシーが更新されているため、ロールバックを中止しました。最新の履歴を確認してください。");
    }
    if (error.code === "not-found" || error.code === "version-not-found" || error.code === "file-deleted" || error.code === "rollback-target-tombstone") {
      return refusalPayload(operation === "history" ? "ポリシー履歴が見つかりませんでした。" : "対象のポリシーまたはバージョンが見つかりませんでした。");
    }
    if (error.code === "unauthorized" || error.code === "scope" || error.code === "token-expired") {
      return refusalPayload("Stashへのアクセス権限を確認してください。");
    }
    if (error.code === "rate-limited") {
      return refusalPayload("Stashの利用制限に達しました。時間をおいて再試行してください。");
    }
    if (error.code === "internal") {
      return refusalPayload("Stashで処理できませんでした。必要に応じて再試行してください。");
    }
    if (error.code === "unknown") {
      return refusalPayload("Stash側でこの操作は利用できません。");
    }
  }
  return refusalPayload("ポリシー操作を完了できませんでした。必要に応じて再試行してください。");
}

function hasStashWriteRoute(env: Env): boolean {
  return typeof env.STASH_BASE_URL === "string"
    && env.STASH_BASE_URL.length > 0
    && typeof env.STASH_WRITE_TOKEN === "string"
    && env.STASH_WRITE_TOKEN.length > 0;
}

function buildStash(deps: PolicyHistoryRollbackDeps): StashApi {
  if (!hasStashWriteRoute(deps.env)) {
    throw new StashConfigurationError("stash write route is not configured");
  }
  return deps.stashApi ?? createStashApi({
    baseUrl: deps.env.STASH_BASE_URL,
    stash: deps.env.STASH_NAME,
    readToken: deps.env.STASH_READ_TOKEN,
    writeToken: deps.env.STASH_WRITE_TOKEN,
    fetch: deps.fetch,
  });
}

async function runHistory(
  stash: StashApi,
): Promise<SlackMessagePayload> {
  return historyPayload(await collectHistory(stash));
}

async function runRollback(
  stash: StashApi,
  deps: PolicyHistoryRollbackDeps,
  input: PolicyRollbackInput,
): Promise<SlackMessagePayload> {
  const current = await withDeadline(POLICY_STASH_OPERATION_DEADLINE_MS, (signal) =>
    stash.getFile({ path: POLICY_DOC_PATH, signal }),
  );
  if (
    current.kind !== "file"
    || current.file.path !== POLICY_DOC_PATH
    || !isPositiveInteger(current.file.version)
    || !isPositiveInteger(current.file.stashVersion)
    || current.file.stashVersion !== current.file.version
  ) {
    throw new PolicyHistoryValidationError();
  }

  const attempt = await adoptPolicyRollbackAttempt(
    { db: deps.env.DB, now: deps.now },
    {
      jobId: input.jobId,
      targetVersion: input.command.version,
      expectedVersion: current.file.version,
    },
  );

  const result = await withDeadline(POLICY_STASH_OPERATION_DEADLINE_MS, (signal) =>
    stash.rollback({
      path: POLICY_DOC_PATH,
      toVersion: input.command.version,
      expectedVersion: attempt.expected_version,
      jobId: String(input.jobId),
      signal,
    }),
  );
  if (!isValidRollbackResult(result, attempt.expected_version, input.command.version)) {
    throw new PolicyHistoryValidationError();
  }
  (deps.invalidatePolicyCache ?? invalidateLivePolicyCache)();
  return rollbackPayload(result.version, result.rollbackOf);
}

/** Runs one stash-only policy history or rollback command. */
export async function runPolicyHistoryRollback(
  deps: PolicyHistoryRollbackDeps,
  input: PolicyHistoryRollbackInput,
): Promise<SlackMessagePayload> {
  try {
    const stash = buildStash(deps);
    if (input.command.operation === "history") return await runHistory(stash);
    return await runRollback(stash, deps, { jobId: input.jobId, command: input.command });
  } catch (error) {
    if (error instanceof PolicyStashOperationTimeoutError) throw error;
    if (error instanceof StashTransportError) throw error;
    if (error instanceof StashConfigurationError || error instanceof StashApiError || error instanceof PolicyHistoryValidationError) {
      return errorPayload(error, input.command.operation);
    }
    throw error;
  }
}

/** Descriptive alias for callers/tests that use the command's full name. */
export const runPolicyHistoryCommand = runPolicyHistoryRollback;
