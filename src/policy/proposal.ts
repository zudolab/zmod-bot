/**
 * Stash-backed orchestration for the admin `@bot policy` command.
 *
 * The policy editor is intentionally downstream of two durable fences: the
 * exact-path D1 lease and the authoritative stash head read. The lease keeps
 * concurrent jobs from spending editor calls, while the generation renewal
 * immediately before create prevents a worker whose lease went stale during
 * the editor call from publishing a candidate against an old owner.
 *
 * This module never logs policy text, requests, diffs, model output, stash
 * messages, or credentials. Failures at the config/read/parse/structure
 * boundary become a bounded Japanese refusal rather than a GitHub fallback.
 */
import type { Env } from "../env";
import {
  buildMessagePayload,
  mrkdwnSection,
  type SlackMessagePayload,
} from "../slack/blocks";
import { buildPolicyReviewPayload } from "../slack/commands";
import type { FetchLike, NowFn } from "../types";
import {
  createStashApi,
  type ChangeSet,
  type ChangeSetDiffResult,
  type StashApi,
} from "../stash/api";
import {
  acquirePolicyProposalLease,
  POLICY_PROPOSAL_LEASE_MS,
  releasePolicyProposalLease,
  renewPolicyProposalLease,
} from "../stash/coordination-store";
import type { RepoDeps } from "../db/repos";
import {
  POLICY_APPROVAL_WINDOW_MS,
  POLICY_DOC_PATH,
  POLICY_UPDATE_DEADLINE_MS,
} from "./contract";
import {
  updatePolicy as defaultUpdatePolicy,
  validatePolicyCandidate,
  type PolicyUpdateDeps,
  type PolicyUpdateInput,
  type PolicyUpdateResult,
} from "./update";

/** The complete stash route's scan deadline, including every page. */
export const POLICY_CHANGE_SET_SCAN_DEADLINE_MS = 15_000;

/** Bound for each authoritative read, create, or diff request. */
export const POLICY_STASH_OPERATION_DEADLINE_MS = 5_000;

// Keep the route's named timing contract available from its orchestration
// boundary as well as the lower-level lease/contract modules.
export { POLICY_APPROVAL_WINDOW_MS, POLICY_PROPOSAL_LEASE_MS };

/** The stash list endpoint accepts at most 200 rows per page. */
const POLICY_CHANGE_SET_PAGE_SIZE = 200;

const EXISTING_POLICY_PR_TEXT = "既存のポリシーPRがオープン中です。";
const IN_PROGRESS_TEXT = "ポリシー変更案を作成中です。少し待ってから再試行してください。";
const REFUSAL_TEXT = "ポリシー更新案を作成できませんでした。";

/** Injected policy editor seam; the production default is src/policy/update.ts. */
export type PolicyProposalUpdateFn = (
  deps: PolicyUpdateDeps,
  input: PolicyUpdateInput,
) => Promise<PolicyUpdateResult>;

export interface StashPolicyProposalDeps {
  env: Env;
  fetch: FetchLike;
  now: NowFn;
  /** Focused tests can provide the already-constructed fake-backed client. */
  stashApi?: StashApi;
  /** Focused tests can provide a deterministic editor result. */
  updatePolicy?: PolicyProposalUpdateFn;
}

export interface StashPolicyProposalInput {
  jobId: number;
  request: string;
}

export type StashPolicyProposalResult =
  | { kind: "in_progress"; payload: SlackMessagePayload }
  | { kind: "existing"; payload: SlackMessagePayload; changeSet: ChangeSet }
  | { kind: "no_change"; payload: SlackMessagePayload }
  | { kind: "rejected"; payload: SlackMessagePayload; reason: string }
  | { kind: "refused"; payload: SlackMessagePayload }
  | { kind: "created"; payload: SlackMessagePayload; changeSet: ChangeSet; diff: ChangeSetDiffResult };

function operationalPayload(text: string, summary = text): SlackMessagePayload {
  return buildMessagePayload([mrkdwnSection("policy_status", text)], summary);
}

function inProgressResult(): StashPolicyProposalResult {
  return { kind: "in_progress", payload: operationalPayload(IN_PROGRESS_TEXT) };
}

function existingResult(changeSet: ChangeSet): StashPolicyProposalResult {
  return {
    kind: "existing",
    payload: operationalPayload(EXISTING_POLICY_PR_TEXT, "既存のポリシーPRがあります"),
    changeSet,
  };
}

function refusalResult(): StashPolicyProposalResult {
  return { kind: "refused", payload: operationalPayload(REFUSAL_TEXT) };
}

function updateOutcomeResult(outcome: PolicyUpdateResult): StashPolicyProposalResult {
  if (outcome.kind === "no_change") {
    return { kind: "no_change", payload: operationalPayload("変更なしと判断しました。", "ポリシー変更なし") };
  }
  if (outcome.kind === "rejected") {
    return {
      kind: "rejected",
      payload: operationalPayload(
        `更新案の検証に失敗しました（${outcome.reason}）。`,
        "ポリシー更新案の検証に失敗しました",
      ),
      reason: outcome.reason,
    };
  }
  // This function is only called for a non-accepted editor outcome. Keeping
  // the default branch explicit protects the route if the result union grows.
  return refusalResult();
}

async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const pending = work(controller.signal);
  // If a transport ignores AbortSignal, the route still returns at the
  // named deadline. The parked rejection handler prevents a late transport
  // failure from becoming an unhandled rejection after the race is over.
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("stash operation deadline exceeded"));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function scanOpenChangeSets(
  stash: StashApi,
): Promise<ChangeSet[]> {
  return withDeadline(POLICY_CHANGE_SET_SCAN_DEADLINE_MS, async (signal) => {
    const open: ChangeSet[] = [];
    let after: string | undefined;
    const cursors = new Set<string>();

    for (;;) {
      if (after !== undefined) {
        if (cursors.has(after)) throw new Error("stash pagination cursor repeated");
        cursors.add(after);
      }
      const page = await stash.listChangeSets({
        status: "all",
        path: POLICY_DOC_PATH,
        limit: POLICY_CHANGE_SET_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
        signal,
      });
      if (!Array.isArray(page.changeSets) || !(page.nextAfter === null || typeof page.nextAfter === "string")) {
        throw new Error("stash change-set page has invalid pagination shape");
      }
      for (const changeSet of page.changeSets) {
        // The service computes expiry at read time. The route deliberately
        // asks for status=all and performs this final status filter locally.
        if (changeSet.status === "open" && changeSet.entries.some((entry) => entry.path === POLICY_DOC_PATH)) {
          open.push(changeSet);
        }
      }
      if (page.nextAfter === null) return open;
      after = page.nextAfter;
      // A malformed empty/repeated cursor is a structure failure, not a
      // reason to retry a remote operation indefinitely.
      if (after === "") throw new Error("stash pagination cursor is empty");
    }
  });
}

async function getAuthoritativePolicy(
  stash: StashApi,
): Promise<{ document: string; version: number }> {
  const result = await withDeadline(POLICY_STASH_OPERATION_DEADLINE_MS, (signal) =>
    stash.getFile({ path: POLICY_DOC_PATH, signal }),
  );
  if (
    result.kind !== "file"
    || result.file.path !== POLICY_DOC_PATH
    || !Number.isSafeInteger(result.file.version)
    || result.file.version <= 0
    || typeof result.file.body !== "string"
  ) {
    throw new Error("stash policy head is not an inline file");
  }
  return { document: result.file.body, version: result.file.version };
}

function acceptedDocument(
  currentDocument: string,
  outcome: PolicyUpdateResult,
): { document: string } | { rejected: string } {
  if (outcome.kind !== "accepted") return { rejected: "not_accepted" };
  // The default editor already runs this validator. Repeating the pure check
  // at the remote-write boundary keeps an injected/editor regression from
  // weakening the stash route's safety fence.
  const reason = validatePolicyCandidate(currentDocument, outcome.document);
  return reason === null ? { document: outcome.document } : { rejected: reason };
}

async function createPolicyChangeSet(
  stash: StashApi,
  input: { jobId: number; document: string; baseVersion: number; now: NowFn },
): Promise<ChangeSet> {
  const expiresAt = new Date(input.now().getTime() + POLICY_APPROVAL_WINDOW_MS).toISOString();
  return withDeadline(POLICY_STASH_OPERATION_DEADLINE_MS, (signal) =>
    stash.createChangeSet({
      jobId: String(input.jobId),
      path: POLICY_DOC_PATH,
      body: input.document,
      baseVersion: input.baseVersion,
      contentType: "text/markdown; charset=utf-8",
      expiresAt,
      signal,
    }),
  );
}

async function fetchPolicyDiff(stash: StashApi, id: string): Promise<ChangeSetDiffResult> {
  return withDeadline(POLICY_STASH_OPERATION_DEADLINE_MS, (signal) =>
    stash.getChangeSetDiff({ id, path: POLICY_DOC_PATH, signal }),
  );
}

/**
 * Runs one single-flight stash proposal attempt. A successful create is
 * followed by one bounded diff read so the Slack message is an inline review
 * of the actual remote candidate rather than a locally reconstructed body.
 */
export async function runStashPolicyProposal(
  deps: StashPolicyProposalDeps,
  input: StashPolicyProposalInput,
): Promise<StashPolicyProposalResult> {
  const repoDeps: RepoDeps = { db: deps.env.DB, now: deps.now };
  const acquired = await acquirePolicyProposalLease(repoDeps, {
    ownerJobId: input.jobId,
    ttlMs: POLICY_PROPOSAL_LEASE_MS,
  });
  if (!acquired.acquired || acquired.lease === null || acquired.generation === null) return inProgressResult();

  const generation = acquired.generation;
  try {
    let stash: StashApi;
    try {
      stash = deps.stashApi ?? createStashApi({
        baseUrl: deps.env.STASH_BASE_URL,
        stash: deps.env.STASH_NAME,
        readToken: deps.env.STASH_READ_TOKEN,
        writeToken: deps.env.STASH_WRITE_TOKEN,
        fetch: deps.fetch,
      });
    } catch {
      return refusalResult();
    }

    let open: ChangeSet[];
    try {
      open = await scanOpenChangeSets(stash);
    } catch {
      return refusalResult();
    }
    if (open.length > 0) return existingResult(open[0]!);

    let current: { document: string; version: number };
    try {
      current = await getAuthoritativePolicy(stash);
    } catch {
      return refusalResult();
    }

    const renewedForEditor = await renewPolicyProposalLease(repoDeps, {
      ownerJobId: input.jobId,
      generation,
      ttlMs: POLICY_PROPOSAL_LEASE_MS,
    });
    if (!renewedForEditor) return inProgressResult();

    const editor = deps.updatePolicy ?? defaultUpdatePolicy;
    let outcome: PolicyUpdateResult;
    try {
      outcome = await editor(
        {
          env: deps.env,
          fetch: deps.fetch,
          now: deps.now,
          deadlineMs: POLICY_UPDATE_DEADLINE_MS,
        },
        { currentDocument: current.document, request: input.request },
      );
    } catch {
      return refusalResult();
    }
    if (outcome.kind !== "accepted") return updateOutcomeResult(outcome);
    if (outcome.document === current.document) {
      return { kind: "no_change", payload: operationalPayload("変更なしと判断しました。", "ポリシー変更なし") };
    }

    const candidate = acceptedDocument(current.document, outcome);
    if ("rejected" in candidate) {
      return {
        kind: "rejected",
        payload: operationalPayload(
          `更新案の検証に失敗しました（${candidate.rejected}）。`,
          "ポリシー更新案の検証に失敗しました",
        ),
        reason: candidate.rejected,
      };
    }

    // This is the last durable fence. No create call is allowed unless the
    // exact generation is still live and the conditional UPDATE changed one
    // row. If the editor crossed the lease expiry, retrying re-lists first.
    const renewedForCreate = await renewPolicyProposalLease(repoDeps, {
      ownerJobId: input.jobId,
      generation,
      ttlMs: POLICY_PROPOSAL_LEASE_MS,
    });
    if (!renewedForCreate) return inProgressResult();

    let changeSet: ChangeSet;
    try {
      changeSet = await createPolicyChangeSet(stash, {
        jobId: input.jobId,
        document: candidate.document,
        baseVersion: current.version,
        now: deps.now,
      });
    } catch {
      return refusalResult();
    }

    let diff: ChangeSetDiffResult;
    try {
      diff = await fetchPolicyDiff(stash, changeSet.id);
    } catch {
      return refusalResult();
    }
    try {
      return {
        kind: "created",
        payload: buildPolicyReviewPayload({ changeSetId: changeSet.id, diff }),
        changeSet,
        diff,
      };
    } catch {
      return refusalResult();
    }
  } finally {
    try {
      await releasePolicyProposalLease(repoDeps, { ownerJobId: input.jobId, generation });
    } catch {
      // Lease release is best effort; the TTL/generation fence remains the
      // safety mechanism if a transient D1 failure prevents this cleanup.
    }
  }
}

/** Short alias for callers that describe the operation as a proposal. */
export const createStashPolicyProposal = runStashPolicyProposal;
