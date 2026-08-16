/**
 * One interface behind Workers AI and Claude — see epic issue #1's
 * provider table for which task uses which by default (COMPOSE_PROVIDER
 * / AUTHOR_PROVIDER / POLISH_PROVIDER in src/env.ts). Implementation of
 * the adapters is issue #11's responsibility.
 */
import type { FetchLike } from "../types";

export interface LlmCompletionInput {
  prompt: string;
  /**
   * Required, not optional — Workers AI's Llama model silently defaults
   * to 256 output tokens and returns truncated output rather than an
   * error when this is omitted. See CLAUDE.md non-negotiable.
   */
  maxTokens: number;
}

export interface LlmCompletionResult {
  text: string;
}

export interface LlmProviderDeps {
  fetch: FetchLike;
}

export interface LlmProvider {
  complete(deps: LlmProviderDeps, input: LlmCompletionInput): Promise<LlmCompletionResult>;
}

/** Which of the four LLM-backed jobs this call is for — see epic issue #1's provider table. */
export type LlmTask = "assemble_section" | "author_ref" | "refresh_ref" | "polish";
