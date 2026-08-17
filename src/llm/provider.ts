/**
 * One interface behind Workers AI and Claude — see epic issue #1's
 * provider table for which task uses which by default (COMPOSE_PROVIDER
 * / AUTHOR_PROVIDER / POLISH_PROVIDER in src/env.ts).
 *
 * Adapters only: no guards, no fallback, no orchestration. A provider
 * returns what the model said plus enough envelope to judge it; deciding
 * whether that output is fit to send to a customer is src/llm/guards.ts
 * and src/reply/compose.ts (issue #13).
 */
import type { ComposeProviderName } from "../env";

/**
 * Provider ids are exactly the values COMPOSE_PROVIDER / AUTHOR_PROVIDER
 * / POLISH_PROVIDER can hold, so selecting a provider from an env var is
 * a total map with no cast and no default branch.
 */
export type LlmProviderId = ComposeProviderName;

export interface LlmRequest {
  /** System prompt. Empty string means "no system prompt" — not a placeholder. */
  system: string;
  user: string;
  /**
   * Required, not optional, and validated at runtime as well —
   * Workers AI's Llama model silently defaults to 256 output tokens and
   * returns *truncated output rather than an error* when this is
   * omitted. There is no downstream symptom except text that stops
   * mid-sentence. See CLAUDE.md non-negotiable.
   */
  maxTokens: number;
  signal?: AbortSignal;
}

/**
 * Why the model stopped, normalized across providers.
 *
 * `"unknown"` is honest, not a failure: Workers AI does not report a
 * stop reason at all, so a Workers AI result is always `"unknown"` and
 * its `truncated` flag comes from the token-count heuristic instead
 * (src/llm/workers-ai.ts `looksTruncated`).
 */
export type LlmStopReason = "end" | "max_tokens" | "refusal" | "unknown";

export interface LlmResult {
  /**
   * The model's text. Empty on a refusal — check `stopReason` before
   * treating an empty string as a bug.
   */
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  /** The model that actually served the call, as reported by the provider where it reports one. */
  model: string;
  /**
   * The provider's whole response envelope, `usage` object included.
   * Do NOT strip this to "just the text": the token counts are the
   * cheapest production diagnostic there is, and the only thing that
   * makes a silent cap-hit visible after the fact.
   */
  raw: unknown;
  stopReason: LlmStopReason;
  /**
   * Output was cut short by the token cap. Authoritative for Claude
   * (`stop_reason: "max_tokens"`), inferred for Workers AI.
   */
  truncated: boolean;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  run(req: LlmRequest): Promise<LlmResult>;
}

/** A binding/credential is missing or unusable. Not retryable — nothing about the request would fix it. */
export class LlmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigurationError";
  }
}

/** The caller built an invalid request. Raised before any provider call, so nothing is spent. */
export class LlmRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmRequestError";
  }
}

/** The provider was reached and failed, or answered in a shape we cannot read. */
export class LlmProviderError extends Error {
  readonly provider: LlmProviderId;
  readonly status?: number;

  constructor(provider: LlmProviderId, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmProviderError";
    this.provider = provider;
    this.status = options?.status;
  }
}

/**
 * Every adapter's first statement. `maxTokens` being a required *type*
 * only protects TypeScript callers — this is what stops an untyped
 * boundary (a JSON job payload, a `JSON.parse` result) from reaching
 * `AI.run` without a cap and silently truncating at 256.
 *
 * Throws before any network or binding call, so a bad request costs
 * nothing.
 */
export function assertLlmRequest(provider: LlmProviderId, req: LlmRequest): void {
  const maxTokens: unknown = req?.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1) {
    // Report the value only when it is a number; anything else is
    // described by type, so a mis-wired caller cannot smuggle arbitrary
    // text into an error message the next layer will log.
    const seen = typeof maxTokens === "number" ? String(maxTokens) : typeof maxTokens;
    throw new LlmRequestError(`${provider}: maxTokens is required and must be a positive integer (got ${seen})`);
  }
  const user: unknown = req?.user;
  if (typeof user !== "string" || user.trim().length === 0) {
    // Never interpolate the value — it is the customer-facing prompt.
    throw new LlmRequestError(`${provider}: user prompt is required and must be a non-empty string`);
  }
  const system: unknown = req.system;
  if (typeof system !== "string") {
    throw new LlmRequestError(`${provider}: system must be a string (use "" for no system prompt)`);
  }
}

/**
 * Which of the four LLM-backed jobs a call is for — see epic issue #1's
 * provider table. Kept here from the scaffold: the adapters are
 * task-agnostic, but the caller that picks between them (issue #13) maps
 * task -> env var -> provider id.
 */
export type LlmTask = "assemble_section" | "author_ref" | "refresh_ref" | "polish";
