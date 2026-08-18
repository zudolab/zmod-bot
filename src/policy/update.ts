/**
 * Pure-logic middle of `@bot policy`: select the configured LLM, request
 * one complete revised policy document, and return only a validated
 * document or a typed non-write outcome. GitHub and Slack deliberately
 * do not appear in this dependency surface.
 *
 * Policy documents, operator requests, prompts, and model output are
 * never logged. Logs below contain closed reason tokens and mechanical
 * counts only.
 */
import { appendUsageLog, type RepoDeps } from "../db/repos";
import type { Env } from "../env";
import { createClaudeProvider } from "../llm/claude";
import {
  checkBudgetGuard,
  classifyCallFailure,
  withDeadline,
  type FallbackReason,
  type GuardTrip,
} from "../llm/guards";
import type { LlmProvider, LlmProviderId, LlmRequest, LlmResult } from "../llm/provider";
import { createWorkersAiProvider } from "../llm/workers-ai";
import { errorSnippet, log } from "../ops/log";
import {
  DIY_BUILD_GUIDE_INTRO,
  DISCORD_BLOCK,
  EVALUATION_CLAUSE,
  GREETING_LINE,
  NEKOPOS_SHIPPING_LINES,
  YAMATO_SHIPPING_LINE,
} from "../reply/templates";
import type { FetchLike, NowFn } from "../types";
import {
  POLICY_DAILY_CAP,
  POLICY_HEADER,
  POLICY_MAX_BYTES,
  POLICY_MAX_REQUEST_CHARS,
  POLICY_REQUIRED_HEADINGS,
  POLICY_UPDATE_DEADLINE_MS,
} from "./contract";

export type PolicyValidationReason =
  | "header_changed"
  | "required_headings"
  | "too_large"
  | "code_fence"
  | "control_character"
  | "new_url"
  | "fixed_clause";

export type PolicyRejectionReason =
  | "request_too_long"
  | "budget_exceeded"
  | "timeout"
  | "rate_limited"
  | "provider_error"
  | "refusal"
  | "max_tokens"
  | "truncated"
  | PolicyValidationReason;

export type PolicyUpdateResult =
  | { kind: "accepted"; document: string; provider: LlmProviderId; model: string }
  | { kind: "no_change"; provider: LlmProviderId; model: string }
  | { kind: "rejected"; reason: PolicyRejectionReason; provider?: LlmProviderId; model?: string };

export interface PolicyUpdateInput {
  currentDocument: string;
  request: string;
}

export interface PolicyUpdateDeps {
  env: Env;
  /** Used only to construct the selected LLM adapter; this module performs no other fetch. */
  fetch: FetchLike;
  /** Defaults to a real clock. Injected for the UTC-day budget window and accounting timestamp. */
  now?: NowFn;
  /** Overrides POLICY_DAILY_CAP in tests. */
  dailyCap?: number;
  /** Overrides POLICY_UPDATE_DEADLINE_MS in tests. */
  deadlineMs?: number;
  /** Test seam for the LLM boundary; production selects from env. */
  provider?: LlmProvider;
}

const textEncoder = new TextEncoder();
const TEMPLATE_SLOT = /\{[a-z_]+\}/g;

/**
 * The exact fixed-clause spans compose rejects, derived from the exported
 * template constants rather than copied. Slot-bearing constants are
 * split the same way as compose's output guard because a filled slot
 * means the raw constant can never occur in a finished reply.
 */
export const POLICY_FORBIDDEN_FIXED_CLAUSES: readonly string[] = [
  GREETING_LINE,
  YAMATO_SHIPPING_LINE,
  NEKOPOS_SHIPPING_LINES,
  EVALUATION_CLAUSE,
  DIY_BUILD_GUIDE_INTRO,
  DISCORD_BLOCK,
]
  .flatMap((clause) => clause.split(TEMPLATE_SLOT))
  .map((span) => span.trim())
  .filter((span) => span !== "");

/** URLs use an ASCII allow-list so adjacent Japanese punctuation is not mistaken for part of the URL. */
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+/gi;
const URL_PROTOCOL_PATTERN = /https?:\/\//gi;
const URL_TRAILING_PUNCTUATION = /[.,;:!?']+$/;

/** Pure validator: null means the candidate is safe for a caller to hand to GitHub. */
export function validatePolicyCandidate(
  currentDocument: string,
  candidateDocument: string,
): PolicyValidationReason | null {
  if (!candidateDocument.startsWith(`${POLICY_HEADER}\n`)) return "header_changed";

  let previousHeadingIndex = -1;
  for (const heading of POLICY_REQUIRED_HEADINGS) {
    const headingIndex = candidateDocument.indexOf(`\n${heading}\n`);
    if (headingIndex === -1 || headingIndex <= previousHeadingIndex) return "required_headings";
    previousHeadingIndex = headingIndex;
  }

  if (textEncoder.encode(candidateDocument).byteLength > POLICY_MAX_BYTES) return "too_large";
  if (candidateDocument.includes("```")) return "code_fence";
  if (containsForbiddenControlCharacter(candidateDocument)) return "control_character";

  if (POLICY_FORBIDDEN_FIXED_CLAUSES.some((clause) => candidateDocument.includes(clause))) {
    return "fixed_clause";
  }

  const outputUrls = (candidateDocument.match(URL_PATTERN) ?? []).map((url) =>
    url.replace(URL_TRAILING_PUNCTUATION, ""),
  );
  // A bare protocol marker or a non-ASCII/otherwise malformed URL must
  // not slip past the narrower ASCII extractor. Every allowed URL in
  // this policy surface is represented by exactly one extracted value.
  if ((candidateDocument.match(URL_PROTOCOL_PATTERN) ?? []).length !== outputUrls.length) return "new_url";
  if (outputUrls.some((url) => !currentDocument.includes(url))) return "new_url";
  return null;
}

function containsForbiddenControlCharacter(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint === 0x0a) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

/** Conservative token estimate for mixed Japanese/English markdown: at most two UTF-8 bytes per token. */
export function estimatePolicyTokens(document: string): number {
  return Math.ceil(textEncoder.encode(document).byteLength / 2);
}

/** Always at least twice the current document estimate, with a useful floor for a small seed document. */
export function computePolicyMaxTokens(currentDocument: string): number {
  return Math.max(1024, estimatePolicyTokens(currentDocument) * 2);
}

export async function updatePolicy(
  deps: PolicyUpdateDeps,
  input: PolicyUpdateInput,
): Promise<PolicyUpdateResult> {
  if (input.request.length > POLICY_MAX_REQUEST_CHARS) {
    return { kind: "rejected", reason: "request_too_long" };
  }

  const provider = deps.provider ?? selectPolicyProvider(deps);
  const now = deps.now ?? (() => new Date());
  const repoDeps: RepoDeps = { db: deps.env.DB, now };

  const budgetTrip = await checkBudget(repoDeps, deps.dailyCap ?? POLICY_DAILY_CAP);
  if (budgetTrip !== null) {
    await recordUsage(repoDeps, provider.id, null, budgetTrip.reason);
    return { kind: "rejected", reason: "budget_exceeded", provider: provider.id };
  }

  let result: LlmResult;
  try {
    result = await callProvider(
      provider,
      buildPolicyUpdateRequest(input),
      deps.deadlineMs ?? POLICY_UPDATE_DEADLINE_MS,
    );
  } catch (error) {
    const trip = classifyCallFailure(error);
    await recordUsage(repoDeps, provider.id, null, trip.reason);
    return { kind: "rejected", reason: callReason(trip), provider: provider.id };
  }

  const terminationReason = classifyTermination(result);
  if (terminationReason !== null) {
    await recordUsage(repoDeps, provider.id, result, terminationReason);
    return {
      kind: "rejected",
      reason: terminationReason,
      provider: provider.id,
      model: result.model,
    };
  }

  if (result.text === input.currentDocument) {
    await recordUsage(repoDeps, provider.id, result, null);
    return { kind: "no_change", provider: provider.id, model: result.model };
  }

  const validationReason = validatePolicyCandidate(input.currentDocument, result.text);
  if (validationReason !== null) {
    await recordUsage(repoDeps, provider.id, result, validationReason);
    return {
      kind: "rejected",
      reason: validationReason,
      provider: provider.id,
      model: result.model,
    };
  }

  await recordUsage(repoDeps, provider.id, result, null);
  return { kind: "accepted", document: result.text, provider: provider.id, model: result.model };
}

export function selectPolicyProvider(deps: Pick<PolicyUpdateDeps, "env" | "fetch">): LlmProvider {
  const configured = deps.env.POLICY_PROVIDER?.trim();
  if (configured === "workers-ai") return createWorkersAiProvider({ ai: deps.env.AI });

  if (configured !== undefined && configured !== "" && configured !== "claude") {
    log("warn", "policy: unrecognized POLICY_PROVIDER, using the claude default", {
      configured,
    });
  }
  const policyModel = deps.env.POLICY_MODEL?.trim();
  return createClaudeProvider({
    apiKey: deps.env.ANTHROPIC_API_KEY,
    fetch: deps.fetch,
    model: policyModel || deps.env.CLAUDE_MODEL,
  });
}

const POLICY_UPDATE_SYSTEM_PROMPT = [
  "You maintain the policy document of a Slack bot. Its content is injected into the system prompt that composes Japanese customer replies.",
  "",
  "Rules, all of them absolute:",
  "- Return the COMPLETE revised Markdown document and nothing else.",
  "- Change only what the operator's request requires.",
  "- Preserve the immutable HTML-comment header block and every section heading byte-for-byte and in the same order.",
  "- Keep the document's existing language; write any new guidance in Japanese and do not translate unrelated content.",
  "- Never add URLs, code fences, or customer data.",
  "- Never add any greeting, shipping, arrival, evaluation, DIY-guide, Discord, or closing clause from a customer reply.",
  "- If the request cannot be expressed as an edit to this policy document, return the current document byte-for-byte unchanged.",
].join("\n");

export function buildPolicyUpdateRequest(input: PolicyUpdateInput): Omit<LlmRequest, "signal"> {
  return {
    system: POLICY_UPDATE_SYSTEM_PROMPT,
    user: [
      "----- BEGIN CURRENT POLICY -----",
      input.currentDocument,
      "----- END CURRENT POLICY -----",
      "",
      "----- BEGIN OPERATOR REQUEST -----",
      input.request,
      "----- END OPERATOR REQUEST -----",
    ].join("\n"),
    maxTokens: computePolicyMaxTokens(input.currentDocument),
  };
}

function classifyTermination(result: LlmResult): PolicyRejectionReason | null {
  if (result.stopReason === "refusal") return "refusal";
  if (result.stopReason === "max_tokens") return "max_tokens";
  if (result.truncated) return "truncated";
  return null;
}

async function callProvider(
  provider: LlmProvider,
  request: Omit<LlmRequest, "signal">,
  deadlineMs: number,
): Promise<LlmResult> {
  const controller = new AbortController();
  try {
    return await withDeadline(provider.run({ ...request, signal: controller.signal }), deadlineMs);
  } catch (error) {
    controller.abort();
    throw error;
  }
}

function callReason(trip: GuardTrip): Extract<PolicyRejectionReason, FallbackReason> {
  switch (trip.reason) {
    case "timeout":
    case "rate_limited":
    case "provider_error":
      return trip.reason;
    default:
      return "provider_error";
  }
}

/** Fails open like compose: one failed count is not the burst this cap exists to stop. */
async function checkBudget(repoDeps: RepoDeps, cap: number): Promise<GuardTrip | null> {
  try {
    return await checkBudgetGuard(repoDeps, { task: "policy", cap });
  } catch (error) {
    log("error", "policy: budget guard could not read usage_log — proceeding uncapped", {
      error: errorSnippet(error),
    });
    return null;
  }
}

/** Swallows its own failure; accounting must never replace a valid typed outcome with an exception. */
async function recordUsage(
  repoDeps: RepoDeps,
  provider: LlmProviderId,
  result: LlmResult | null,
  fallback: PolicyRejectionReason | FallbackReason | null,
): Promise<void> {
  try {
    await appendUsageLog(repoDeps, {
      slug: null,
      task: "policy",
      provider,
      model: result?.model ?? null,
      fallback,
      tokensIn: result?.tokensIn ?? null,
      tokensOut: result?.tokensOut ?? null,
    });
  } catch (error) {
    log("error", "policy: usage_log write failed", { error: errorSnippet(error) });
  }
}
