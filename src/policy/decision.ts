/** Crash-safe delivery of one durable stash policy decision. */
import type { Env } from "../env";
import type { JobRow, PolicyDecisionRemoteResult, PolicyDecisionRow } from "../db/schema";
import type { RepoDeps } from "../db/repos";
import { log } from "../ops/log";
import {
  buildMessagePayload,
  mrkdwnSection,
  type SlackMessagePayload,
} from "../slack/blocks";
import { ACTION_IDS, encodeButtonValue } from "../slack/commands";
import { updateMessage, type SlackApiDeps } from "../slack/api";
import {
  createStashApi,
  STASH_ERROR_CODES,
  StashApiError,
  StashTransportError,
  type NormalizedStashErrorCode,
  type StashApi,
} from "../stash/api";
import {
  getPolicyDecision,
  markPolicyDecisionSlackUpdateComplete,
  recordPolicyDecisionRemoteResult,
} from "../stash/coordination-store";
import { invalidateLivePolicyCache } from "../stash/policy-reader";
import type { FetchLike, NowFn, SleepFn } from "../types";

const DECISION_EVENT = /^policy-decision:(chs_\d{13}[0-9a-f]{8}):(\d+)$/;
const MAX_STASH_CONFLICTS = 20;
const KNOWN_STASH_CODES = new Set<string>([...STASH_ERROR_CODES, "unknown"]);

export interface PolicyDecisionJobDeps {
  fetch: FetchLike;
  now: NowFn;
  sleep?: SleepFn;
  stashApi?: StashApi;
  invalidatePolicyCache?: () => void;
}

interface DecisionIdentity {
  changeSetId: string;
  decisionEpoch: number;
}

export async function runPolicyDecisionJob(
  env: Env,
  job: JobRow,
  deps: PolicyDecisionJobDeps,
): Promise<void> {
  const identity = parseDecisionIdentity(job);
  const repoDeps: RepoDeps = { db: env.DB, now: deps.now };
  let decision = await getPolicyDecision(repoDeps, identity.changeSetId, identity.decisionEpoch);
  if (decision === null) throw new Error("policy decision outbox is missing");
  if (decision.slack_update_completed === 1) return;

  const slackDeps: SlackApiDeps = {
    botToken: env.SLACK_BOT_TOKEN,
    fetch: deps.fetch,
    sleep: deps.sleep,
    retryServerErrors: true,
  };

  if (decision.remote_result === "pending") {
    const stash = deps.stashApi ?? createStashApi({
      baseUrl: env.STASH_BASE_URL,
      stash: env.STASH_NAME,
      readToken: env.STASH_READ_TOKEN,
      writeToken: env.STASH_WRITE_TOKEN,
      fetch: deps.fetch,
    });
    decision = await resolveRemote(repoDeps, stash, decision, deps.invalidatePolicyCache ?? invalidateLivePolicyCache);
  }

  await updateMessage(slackDeps, {
    channel: decision.channel_id,
    ts: decision.review_message_ts,
    payload: terminalPayload(decision),
  });
  await markPolicyDecisionSlackUpdateComplete(repoDeps, identity);
}

async function resolveRemote(
  repoDeps: RepoDeps,
  stash: StashApi,
  decision: PolicyDecisionRow,
  invalidate: () => void,
): Promise<PolicyDecisionRow> {
  let status: "open" | "applied" | "rejected" | "expired";
  try {
    status = (await stash.getChangeSet({ id: decision.change_set_id })).status;
  } catch (error) {
    return handleRemoteError(repoDeps, decision, error);
  }

  if (status === "applied") return persistRemote(repoDeps, decision, "applied");
  if (status === "rejected") return persistRemote(repoDeps, decision, "rejected");
  if (status === "expired" && decision.action === "approve") {
    return persistRemote(repoDeps, decision, "expired", "change-set-expired");
  }

  try {
    if (decision.action === "approve") {
      // Omitting author is intentional: the permanent version retains the proposer.
      const approved = await stash.approveChangeSet({ id: decision.change_set_id });
      invalidate();
      const entry = approved.commit.entries[0];
      return persistRemote(
        repoDeps,
        decision,
        "applied",
        null,
        entry?.version ?? null,
        approved.commit.id,
      );
    }
    await stash.rejectChangeSet({ id: decision.change_set_id });
    return persistRemote(repoDeps, decision, "rejected");
  } catch (error) {
    return handleRemoteError(repoDeps, decision, error);
  }
}

async function handleRemoteError(
  repoDeps: RepoDeps,
  decision: PolicyDecisionRow,
  error: unknown,
): Promise<PolicyDecisionRow> {
  if (error instanceof StashTransportError) throw error;
  if (error instanceof StashApiError) {
    if (decision.action === "approve" && isApprovalConflict(error)) {
      return persistRemote(repoDeps, decision, "conflict", error.code);
    }
    if (error.code === "change-set-expired") {
      return persistRemote(repoDeps, decision, "expired", error.code);
    }
    if (error.code === "change-set-closed") {
      return persistRemote(repoDeps, decision, "closed", error.code);
    }
    log("warn", "policy decision remote operation failed", {
      status: error.status,
      normalizedCode: error.code,
      count: 1,
    });
    // A received stash response is terminal: malformed requests, auth,
    // rate limits, and server failures must be surfaced once, never fed back
    // into the durable queue. Persist before Slack so a crash cannot repeat
    // the remote request; the convergent terminal update resumes separately.
    return persistRemote(repoDeps, decision, "closed", error.code);
  }
  throw error;
}

function isApprovalConflict(error: StashApiError): boolean {
  if (error.code === "commit-conflict") return true;
  const conflictCount = error.conflicts?.length ?? 0;
  return error.code === "not-found" && conflictCount > 0 && conflictCount <= MAX_STASH_CONFLICTS;
}

async function persistRemote(
  repoDeps: RepoDeps,
  decision: PolicyDecisionRow,
  result: Exclude<PolicyDecisionRemoteResult, "pending">,
  remoteCode: string | null = null,
  remoteVersion: number | null = null,
  remoteCommitId: string | null = null,
): Promise<PolicyDecisionRow> {
  const recorded = await recordPolicyDecisionRemoteResult(repoDeps, {
    changeSetId: decision.change_set_id,
    decisionEpoch: decision.decision_epoch,
    result,
    remoteCode,
    remoteVersion,
    remoteCommitId,
  });
  if (recorded.decision === null || recorded.decision.remote_result === "pending") {
    throw new Error("policy decision remote result was not persisted");
  }
  return recorded.decision;
}

function parseDecisionIdentity(job: JobRow): DecisionIdentity {
  if (job.kind !== "policy_decision") throw new Error("policy decision worker received the wrong job kind");
  const match = DECISION_EVENT.exec(job.event_id);
  const epoch = Number(match?.[2]);
  if (match?.[1] === undefined || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("policy decision job identity is invalid");
  }
  return { changeSetId: match[1], decisionEpoch: epoch };
}

function terminalPayload(decision: PolicyDecisionRow): SlackMessagePayload {
  switch (decision.remote_result) {
    case "applied":
      return statusPayload("ポリシー変更を承認しました。", "ポリシー変更を承認しました");
    case "rejected":
      return statusPayload("ポリシー変更を却下しました。", "ポリシー変更を却下しました");
    case "expired":
      return statusPayload("このポリシー変更案は期限切れです。", "ポリシー変更案は期限切れです");
    case "closed":
      if (decision.remote_code !== null && decision.remote_code !== "change-set-closed") {
        return operationalPayload(decision.remote_code);
      }
      return statusPayload("このポリシー変更案はすでに終了しています。", "ポリシー変更案は終了しています");
    case "conflict":
      return conflictPayload(decision.change_set_id);
    default:
      throw new Error("policy decision terminal payload requested while pending");
  }
}

function statusPayload(text: string, summary: string): SlackMessagePayload {
  return buildMessagePayload([mrkdwnSection("policy_decision_status", text)], summary);
}

function actionButton(actionId: string, label: string, value: string, style?: "primary" | "danger"): unknown {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: label, emoji: true },
    value,
    ...(style === undefined ? {} : { style }),
  };
}

function conflictPayload(changeSetId: string): SlackMessagePayload {
  const value = encodeButtonValue({ v: 1, id: changeSetId });
  return buildMessagePayload([
    mrkdwnSection("policy_decision_conflict", "競合のため承認できませんでした。必要であれば変更案を却下してください。"),
    {
      type: "actions",
      block_id: "policy_conflict_actions",
      elements: [actionButton(ACTION_IDS.policyReject, "却下", value, "danger")],
    },
  ], "ポリシー変更案が競合しました");
}

function operationalPayload(rawCode: string): SlackMessagePayload {
  const code: NormalizedStashErrorCode = KNOWN_STASH_CODES.has(rawCode)
    ? rawCode as NormalizedStashErrorCode
    : "unknown";
  return statusPayload(
    `ポリシー変更の処理に失敗しました（code=${code}）。この操作は自動再試行されません。`,
    "ポリシー変更の処理に失敗しました",
  );
}
