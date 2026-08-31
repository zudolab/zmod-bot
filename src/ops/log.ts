/**
 * Structured logging, plus the redaction helpers both LLM adapters use.
 *
 * Never pass a prompt body, a reference body, polish input, or a
 * credential as a field — see CLAUDE.md non-negotiable: those are
 * customer-facing business text. Callers pass identifiers (job id, slug,
 * event id), never the text itself.
 *
 * That rule is enforced two ways rather than trusted:
 *   - `logLlmCall` takes a closed field set (provider / model / token
 *     counts / stop reason). There is no parameter a prompt or a
 *     completion could be passed through.
 *   - every string that does reach a line goes through `redactSnippet`,
 *     which masks credential shapes and hard-truncates. A caller who
 *     slips leaks a fragment instead of the whole customer-facing text.
 *     That is a backstop, not a licence.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Hard cap on any string reaching a log line. Sized for the one thing we
 * genuinely want from an upstream failure — its error code and opening
 * words — and nothing more.
 */
export const MAX_LOG_SNIPPET_LENGTH = 160;

const TRUNCATION_MARKER = "…(truncated)";

/**
 * Credential shapes this repo could actually emit into a log: Anthropic
 * keys, Slack tokens, GitHub PATs, and an `Authorization: Bearer` value echoed back
 * inside an upstream error body. Masked before truncation, because
 * truncation alone would still leave a usable prefix.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /x(?:ox[abeprs]|app)-[A-Za-z0-9-]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /zhs_[A-Za-z0-9_-]+/g,
  /tok_[0-9a-f]{32}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

const REDACTED = "[redacted]";

/** Masks known credential shapes anywhere in a string. */
export function redactCredentials(value: string): string {
  let output = value;
  for (const pattern of CREDENTIAL_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

/**
 * The one funnel every logged string passes through: collapse
 * whitespace, mask credentials, hard-truncate. Non-strings are described
 * by type rather than serialized — serializing an unknown object is how
 * a response body ends up in a log line by accident.
 */
export function redactSnippet(value: unknown, maxLength: number = MAX_LOG_SNIPPET_LENGTH): string {
  const text = typeof value === "string" ? value : describeNonString(value);
  const normalized = redactCredentials(text.replace(/\s+/g, " ").trim());
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}${TRUNCATION_MARKER}`;
}

/** Redacted, truncated one-liner for a caught `unknown` — what adapters log on failure. */
export function errorSnippet(error: unknown, maxLength: number = MAX_LOG_SNIPPET_LENGTH): string {
  if (error instanceof Error) {
    const name = error.name || "Error";
    return redactSnippet(`${name}: ${error.message}`, maxLength);
  }
  return redactSnippet(error, maxLength);
}

function describeNonString(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return `[${typeof value}]`;
}

/** Field names the envelope owns; a caller cannot overwrite them. */
const RESERVED_FIELD_KEYS: readonly string[] = ["level", "msg"];

export function log(level: LogLevel, message: string, fields?: LogFields): void {
  const line = JSON.stringify({ level, msg: redactCredentials(message), ...redactFields(fields) });
  // Looked up on `console` at call time, never captured at module load —
  // a captured reference is not replaced by vi.spyOn, so the redaction
  // tests would silently observe nothing.
  switch (level) {
    case "error":
      console.error(line);
      return;
    case "warn":
      console.warn(line);
      return;
    case "debug":
      console.debug(line);
      return;
    default:
      console.log(line);
  }
}

function redactFields(fields?: LogFields): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};
  if (!fields) return output;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (RESERVED_FIELD_KEYS.includes(key)) continue;
    output[key] = typeof value === "string" ? redactSnippet(value) : value;
  }
  return output;
}

/**
 * The closed field set for a completed model call. Deliberately has no
 * slot for prompt or completion text — the token counts are the whole
 * diagnostic, and a round `tokensOut` is the truncation tell (see
 * src/llm/workers-ai.ts `looksTruncated`).
 */
export interface LlmCallLogFields {
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  stopReason?: string;
  truncated?: boolean;
}

export function logLlmCall(fields: LlmCallLogFields): void {
  log("info", "llm.call", { ...fields });
}

/** Failure counterpart. `error` is snippet-ed, never spread — it may carry an upstream body. */
export interface LlmErrorLogFields {
  provider: string;
  model: string;
  status?: number;
  error: unknown;
}

export function logLlmError(fields: LlmErrorLogFields): void {
  log("error", "llm.error", {
    provider: fields.provider,
    model: fields.model,
    status: fields.status,
    error: errorSnippet(fields.error),
  });
}
