/**
 * Claude API adapter — raw `fetch` to api.anthropic.com, no SDK (CLAUDE.md
 * non-negotiable). Default for AUTHOR_PROVIDER per epic issue #1's
 * provider table (authoring/refreshing a reference needs to read the
 * live site and write polite JA from scratch — beyond what the
 * assemble-only Workers AI path is for). Implementation is issue #11's
 * responsibility.
 */
import type { FetchLike } from "../types";
import type { LlmProvider } from "./provider";

export interface ClaudeProviderDeps {
  apiKey: string;
  fetch: FetchLike;
}

export function createClaudeProvider(deps: ClaudeProviderDeps): LlmProvider {
  throw new Error("not implemented: createClaudeProvider");
}
