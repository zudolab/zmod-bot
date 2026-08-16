/**
 * Compose orchestration: LLM-assembled resource section
 * (COMPOSE_PROVIDER, src/llm/provider.ts) -> guards (src/llm/guards.ts)
 * -> deterministic fallback render (src/reply/render.ts) on any guard
 * trip. See CLAUDE.md: "deterministic skeleton, LLM middle,
 * deterministic fallback." Implementation is issue #13's responsibility.
 */
import type { Env } from "../env";
import type { ProductRef } from "../refs/model";
import type { FetchLike } from "../types";

export interface ComposeReplyInput {
  ref: ProductRef;
  arrivalSchedule: string | null;
  discord: boolean;
  direct: boolean;
}

export interface ComposeReplyDeps {
  env: Env;
  fetch: FetchLike;
}

export interface ComposeReplyResult {
  text: string;
  /** True when a guard tripped and src/reply/render.ts's deterministic path was used instead of the LLM output. */
  usedFallback: boolean;
}

export async function composeReply(deps: ComposeReplyDeps, input: ComposeReplyInput): Promise<ComposeReplyResult> {
  throw new Error("not implemented: composeReply");
}
