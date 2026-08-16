/**
 * Workers AI adapter — `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, per
 * epic issue #1's provider table (the default for COMPOSE_PROVIDER and
 * POLISH_PROVIDER). Implementation is issue #11's responsibility.
 */
import type { LlmProvider } from "./provider";

export interface WorkersAiDeps {
  ai: Ai;
}

/**
 * ALWAYS pass `max_tokens` to `env.AI.run` — see src/llm/provider.ts
 * LlmCompletionInput.maxTokens and CLAUDE.md non-negotiable. Do NOT wire
 * `gateway: { id }` into the run call — an unprovisioned named AI Gateway
 * returns Cloudflare error 2001 on every call (CLAUDE.md non-negotiable).
 */
export function createWorkersAiProvider(deps: WorkersAiDeps): LlmProvider {
  throw new Error("not implemented: createWorkersAiProvider");
}
