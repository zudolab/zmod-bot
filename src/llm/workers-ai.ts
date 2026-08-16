/**
 * Workers AI adapter — `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, per
 * epic issue #1's provider table (the default for COMPOSE_PROVIDER and
 * POLISH_PROVIDER).
 *
 * Three of this file's decisions come from a sibling project's
 * post-mortem, where each cost real debugging time
 * (`l-lessons-cloudflare-workers-ai`); they read as over-caution and are
 * not:
 *   - `max_tokens` is always sent (LlmRequest.maxTokens is required and
 *     re-validated at runtime). Omitting it caps output at 256 tokens
 *     with no error — only text that stops mid-sentence.
 *   - the whole envelope, `usage` included, is kept in `LlmResult.raw`.
 *   - no `gateway: { id }` option is passed. See `run` below.
 */
import { logLlmCall, logLlmError } from "../ops/log";
import {
  assertLlmRequest,
  LlmProviderError,
  type LlmProvider,
  type LlmProviderId,
  type LlmRequest,
  type LlmResult,
} from "./provider";

export const WORKERS_AI_PROVIDER_ID: LlmProviderId = "workers-ai";

/** Pinned as a module constant — a model swap is a code change, reviewed, not an env-var surprise. */
export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Output-token counts that are almost certainly a cap rather than a
 * model-chosen stopping point. 256 is Llama's silent Workers AI default
 * and therefore the one that matters most; the rest are the values a
 * caller is likely to have asked for.
 */
const ROUND_TOKEN_CAPS: ReadonlySet<number> = new Set([256, 512, 1024, 2048, 4096, 8192, 16384]);

export interface WorkersAiDeps {
  /**
   * The `AI` binding (src/env.ts `Env["AI"]`). Tests pass a recording
   * fake cast to `Ai` — the real type is used here so a malformed
   * `AI.run` input is a compile error rather than a runtime surprise.
   */
  ai: Ai;
}

/**
 * The highest-signal truncation diagnostic there is: a round
 * `completion_tokens` (256 / 512 / 1024 …) means you hit a cap, a
 * non-round one (247) is real model output that ended on its own.
 *
 * Deliberately reads only the token counter, never the text: output that
 * hit a cap does not reliably *look* cut off (it can stop on a clean
 * sentence boundary), so a "does it look finished" veto would hide
 * exactly the case this exists to catch. Corroborating against the text
 * is the caller's job (guards, issue #13).
 *
 * `maxTokens` is the stronger signal when known — reaching the exact
 * budget you asked for is a cap hit by definition, round number or not.
 * A round count *below* the requested budget still returns true: it
 * means the cap we sent was ignored, which is the same bug wearing a
 * different hat.
 */
export function looksTruncated(envelope: unknown, maxTokens?: number): boolean {
  const completionTokens = readCompletionTokens(envelope);
  if (completionTokens === undefined) return false;
  if (maxTokens !== undefined && completionTokens >= maxTokens) return true;
  return ROUND_TOKEN_CAPS.has(completionTokens);
}

/**
 * `env.AI.run` wraps every text call as `{ response, usage, tool_calls }`
 * — but `response` is typed as `string` and is not always one. With
 * `response_format` the payload arrives as `{ response: "<json string>" }`
 * on some calls and `{ response: <object> }` on others; the guarantee is
 * best-effort, so both shapes are accepted here and an object is
 * re-serialized so `LlmResult.text` is always a string. Validating what
 * that string contains is downstream's job.
 */
export function readWorkersAiText(envelope: unknown): string {
  if (typeof envelope === "string") return envelope;
  if (!isRecord(envelope)) {
    throw new LlmProviderError(WORKERS_AI_PROVIDER_ID, "unreadable response envelope (not an object)");
  }
  const response: unknown = envelope.response;
  if (typeof response === "string") return response;
  if (isRecord(response) || Array.isArray(response)) return JSON.stringify(response);
  throw new LlmProviderError(
    WORKERS_AI_PROVIDER_ID,
    `unreadable response envelope (response was ${response === undefined ? "absent" : typeof response})`,
  );
}

export function createWorkersAiProvider(deps: WorkersAiDeps): LlmProvider {
  return {
    id: WORKERS_AI_PROVIDER_ID,

    async run(req: LlmRequest): Promise<LlmResult> {
      assertLlmRequest(WORKERS_AI_PROVIDER_ID, req);

      const messages = buildMessages(req);

      let raw: unknown;
      try {
        raw = await deps.ai.run(
          WORKERS_AI_MODEL,
          { messages, max_tokens: req.maxTokens },
          // Options carry the abort signal and NOTHING else. Do not add
          // `gateway: { id }` here: a named AI Gateway that has not been
          // provisioned in the Cloudflare dashboard returns error 2001 on
          // every call, which is what dark-shipped a sibling project. A
          // gateway may be wired later — after it exists in the account.
          req.signal ? { signal: req.signal } : undefined,
        );
      } catch (error) {
        logLlmError({ provider: WORKERS_AI_PROVIDER_ID, model: WORKERS_AI_MODEL, error });
        throw new LlmProviderError(WORKERS_AI_PROVIDER_ID, "AI binding call failed", { cause: error });
      }

      const text = readWorkersAiText(raw);
      const tokensIn = readPromptTokens(raw);
      const tokensOut = readCompletionTokens(raw);
      const truncated = looksTruncated(raw, req.maxTokens);

      logLlmCall({
        provider: WORKERS_AI_PROVIDER_ID,
        model: WORKERS_AI_MODEL,
        tokensIn,
        tokensOut,
        // Workers AI reports no stop reason at all — see LlmStopReason.
        stopReason: "unknown",
        truncated,
      });

      return {
        text,
        tokensIn,
        tokensOut,
        model: WORKERS_AI_MODEL,
        raw,
        stopReason: "unknown",
        truncated,
      };
    },
  };
}

function buildMessages(req: LlmRequest): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [];
  if (req.system.trim().length > 0) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.user });
  return messages;
}

function readUsage(envelope: unknown): Record<string, unknown> | undefined {
  if (!isRecord(envelope)) return undefined;
  const usage: unknown = envelope.usage;
  return isRecord(usage) ? usage : undefined;
}

function readUsageCount(envelope: unknown, key: string): number | undefined {
  const value = readUsage(envelope)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPromptTokens(envelope: unknown): number | undefined {
  return readUsageCount(envelope, "prompt_tokens");
}

function readCompletionTokens(envelope: unknown): number | undefined {
  return readUsageCount(envelope, "completion_tokens");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
