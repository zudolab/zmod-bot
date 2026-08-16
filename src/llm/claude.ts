/**
 * Claude API adapter — raw `fetch` to api.anthropic.com, no SDK
 * (CLAUDE.md non-negotiable). Default for AUTHOR_PROVIDER per epic issue
 * #1's provider table: authoring or refreshing a reference means reading
 * the live site and writing polite JA from scratch, beyond what the
 * assemble-only Workers AI path is for.
 *
 * Two deliberate omissions:
 *   - no `temperature` / `top_p` / `top_k` / `thinking.budget_tokens` in
 *     the body. Current models reject some of these outright, and none
 *     of them are needed for short-form Japanese prose.
 *   - no streaming. The caller wants one finished string to post.
 */
import { logLlmCall, logLlmError, redactSnippet } from "../ops/log";
import type { FetchLike } from "../types";
import {
  assertLlmRequest,
  LlmConfigurationError,
  LlmProviderError,
  type LlmProvider,
  type LlmProviderId,
  type LlmRequest,
  type LlmResult,
  type LlmStopReason,
} from "./provider";

export const CLAUDE_PROVIDER_ID: LlmProviderId = "claude";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Pinned request-format version. Anthropic requires it on every call. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The cheap tier still comfortable with this task (short-form Japanese
 * prose). Only the fallback: the operator raises the tier by setting the
 * CLAUDE_MODEL var (e.g. to `claude-sonnet-5`), no code change and no
 * redeploy of this file.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5";

export interface ClaudeProviderDeps {
  /** env.ANTHROPIC_API_KEY. Blank is a configuration error, never a request. */
  apiKey: string;
  fetch: FetchLike;
  /** env.CLAUDE_MODEL. Blank or absent falls back to DEFAULT_CLAUDE_MODEL. */
  model?: string;
}

export function createClaudeProvider(deps: ClaudeProviderDeps): LlmProvider {
  const configuredModel = deps.model?.trim() ? deps.model.trim() : DEFAULT_CLAUDE_MODEL;

  return {
    id: CLAUDE_PROVIDER_ID,

    async run(req: LlmRequest): Promise<LlmResult> {
      // Checked per call rather than in the factory: wiring may build
      // every provider up front, and a missing Anthropic key must not
      // break the Workers AI path that never touches it. Still before
      // any fetch — an empty key is never sent.
      if (typeof deps.apiKey !== "string" || deps.apiKey.trim().length === 0) {
        throw new LlmConfigurationError("ANTHROPIC_API_KEY is not configured");
      }
      assertLlmRequest(CLAUDE_PROVIDER_ID, req);

      const body: Record<string, unknown> = {
        model: configuredModel,
        max_tokens: req.maxTokens,
        messages: [{ role: "user", content: req.user }],
      };
      if (req.system.trim().length > 0) body.system = req.system;

      let response: Response;
      try {
        response = await deps.fetch(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: {
            "x-api-key": deps.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (error) {
        logLlmError({ provider: CLAUDE_PROVIDER_ID, model: configuredModel, error });
        throw new LlmProviderError(CLAUDE_PROVIDER_ID, "request failed", { cause: error });
      }

      if (!response.ok) {
        // The body may echo the request back, key included — snippet it.
        const snippet = redactSnippet(await response.text().catch(() => ""));
        logLlmError({
          provider: CLAUDE_PROVIDER_ID,
          model: configuredModel,
          status: response.status,
          error: snippet,
        });
        throw new LlmProviderError(CLAUDE_PROVIDER_ID, `HTTP ${response.status}: ${snippet}`, {
          status: response.status,
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        // A JSON.parse failure quotes the offending bytes in its own
        // message, and on a 200 those bytes are the model's completion —
        // customer-facing text. Log the fact, not the parser's message;
        // the original stays reachable as `cause`, which is not logged.
        logLlmError({
          provider: CLAUDE_PROVIDER_ID,
          model: configuredModel,
          error: "response body was not valid JSON",
        });
        throw new LlmProviderError(CLAUDE_PROVIDER_ID, "unreadable response body (invalid JSON)", {
          cause: error,
        });
      }
      if (!isRecord(payload)) {
        throw new LlmProviderError(CLAUDE_PROVIDER_ID, "unreadable response body (not an object)");
      }

      const model = typeof payload.model === "string" ? payload.model : configuredModel;
      const tokensIn = readUsageCount(payload, "input_tokens");
      const tokensOut = readUsageCount(payload, "output_tokens");
      const stopReason = mapStopReason(payload.stop_reason);

      // stop_reason is read BEFORE content: a refusal is a legitimate,
      // typed outcome whose content blocks may be empty or absent, and
      // parsing them first would turn it into a thrown "unreadable
      // response" that hides what actually happened. The caller (issue
      // #13) falls back to the deterministic renderer on it.
      const text = stopReason === "refusal" ? "" : readClaudeText(payload);
      const truncated = stopReason === "max_tokens";

      logLlmCall({
        provider: CLAUDE_PROVIDER_ID,
        model,
        tokensIn,
        tokensOut,
        stopReason,
        truncated,
      });

      return { text, tokensIn, tokensOut, model, raw: payload, stopReason, truncated };
    },
  };
}

/**
 * `end_turn` and `stop_sequence` both mean "the model finished".
 * `tool_use` cannot occur here (no tools are sent) and `pause_turn` is a
 * server-tool concept; those, and any value a future API version adds,
 * map to "unknown" rather than being asserted away — an unrecognised
 * stop reason is information, not a crash.
 */
function mapStopReason(value: unknown): LlmStopReason {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "unknown";
  }
}

/** Concatenates the `type: "text"` blocks; other block types are not requested and are ignored. */
function readClaudeText(payload: Record<string, unknown>): string {
  const content: unknown = payload.content;
  if (!Array.isArray(content)) {
    throw new LlmProviderError(CLAUDE_PROVIDER_ID, "unreadable response body (content was not an array)");
  }
  return content
    .filter((block): block is { type: string; text: string } => {
      if (!isRecord(block)) return false;
      return block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("");
}

function readUsageCount(payload: Record<string, unknown>, key: string): number | undefined {
  const usage: unknown = payload.usage;
  if (!isRecord(usage)) return undefined;
  const value: unknown = usage[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
