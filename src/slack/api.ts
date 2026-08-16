/**
 * Slack Web API client — raw `fetch`, no `@slack/*` package (CLAUDE.md
 * non-negotiable). Ported from readycrew-viewer's production
 * `app/src/slack/slack-helpers.ts` (`slackApiCall` and friends) — same
 * hardening, adapted to this repo's injected-deps shape instead of a
 * Worker `Env` lookup: missing-token guard, injected fetch/sleep, 429
 * (+ opt-in 5xx) `retry-after` backoff bounded by maxRetries, and
 * sanitized error-code interpolation so an attacker-controlled Slack
 * response can't inject arbitrary text into a thrown error message.
 */
import type { FetchLike, SleepFn } from "../types";
import type { SlackMessagePayload } from "./blocks";

export interface SlackApiDeps {
  botToken: string;
  fetch: FetchLike;
  /** Injected so retry/backoff tests run instantly; defaults to a real setTimeout-based sleep. */
  sleep?: SleepFn;
  /** Caps the retry loop; only ever lowers it below DEFAULT_MAX_RETRIES, never raises it — see the clamp in callSlackApi. */
  maxRetries?: number;
  /**
   * Opt in to retrying HTTP 5xx on the same budget as 429. Off by default:
   * the reply-post path fails fast rather than stalling, matching
   * readycrew-viewer's notify-path default. A cron/sweep-style caller
   * (e.g. the job delivery worker, issue #10) can opt in.
   */
  retryServerErrors?: boolean;
}

const SLACK_API_BASE_URL = "https://slack.com/api";

// Deliberately small: a slow retry here stalls whatever per-item flow is
// waiting on the reply (readycrew-viewer's equivalent "notify path"
// constants).
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 2_000;
const FALLBACK_RETRY_BASE_MS = 1_000;

// The error code from a `{ok: false, error: "..."}` Slack response is
// attacker-influenceable response data (Slack itself, or anything that
// can trigger a Slack API error) — only interpolate it into a thrown
// error message when it matches Slack's own documented error-code shape,
// otherwise fall back to a generic message with no code appended.
const SLACK_ERROR_CODE_PATTERN = /^[a-z0-9_]+$/i;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Slack does not always send `retry-after` (and never does on a 5xx), so
// a header-less backoff is needed or the retry loop would fire every
// attempt back-to-back against an endpoint that just asked to slow down.
function fallbackBackoffMs(attempt: number): number {
  return Math.min(FALLBACK_RETRY_BASE_MS * 2 ** attempt, MAX_RETRY_AFTER_MS);
}

/** `retry-after` (seconds) in ms, or an exponential fallback when the header is absent/unparseable. Always clamped to MAX_RETRY_AFTER_MS. */
function retryAfterMilliseconds(value: string | null, attempt: number): number {
  const seconds = value === null ? NaN : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackBackoffMs(attempt);
  return Math.min(Math.round(seconds * 1_000), MAX_RETRY_AFTER_MS);
}

/**
 * Core Slack Web API POST request shared by every method below: token
 * presence check, fetch/sleep injection, 429 (+ opt-in 5xx) retry-after
 * backoff, HTTP-status and malformed-JSON errors, and the `ok !== true`
 * path with sanitized error-code interpolation.
 */
async function callSlackApi(
  deps: SlackApiDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!deps.botToken) {
    throw new Error(`SLACK_BOT_TOKEN is not configured; cannot call Slack ${method}.`);
  }
  const fetchImpl = deps.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  // Only ever narrows the budget below the default — a caller cannot ask
  // for more retries than this path is designed to afford.
  const maxRetries = Math.max(0, Math.min(deps.maxRetries ?? DEFAULT_MAX_RETRIES, DEFAULT_MAX_RETRIES));

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`${SLACK_API_BASE_URL}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.botToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(params),
      });
    } catch {
      throw new Error("Could not reach the Slack Web API.");
    }

    if (res.status === 429) {
      if (attempt >= maxRetries) throw new Error("Slack Web API rate limit retry exhausted.");
      await sleep(retryAfterMilliseconds(res.headers.get("retry-after"), attempt));
      continue;
    }
    if (deps.retryServerErrors === true && res.status >= 500 && attempt < maxRetries) {
      await sleep(retryAfterMilliseconds(res.headers.get("retry-after"), attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Slack Web API ${method} failed: HTTP ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error("Slack Web API returned malformed JSON.");
    }
    if (!body || typeof body !== "object") throw new Error("Slack Web API returned malformed JSON.");
    const apiResponse = body as Record<string, unknown>;
    if (apiResponse.ok !== true) {
      const code =
        typeof apiResponse.error === "string" && SLACK_ERROR_CODE_PATTERN.test(apiResponse.error)
          ? `: ${apiResponse.error}`
          : "";
      throw new Error(`Slack Web API ${method} was rejected${code}`);
    }
    return apiResponse;
  }
}

export interface SlackMessageIdentity {
  channel: string;
  ts: string;
}

function isMessageIdentity(value: unknown): value is SlackMessageIdentity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.channel === "string" &&
    record.channel.trim() !== "" &&
    typeof record.ts === "string" &&
    record.ts.trim() !== ""
  );
}

export interface PostMessageInput {
  channel: string;
  threadTs?: string;
  /** Built by src/slack/blocks.ts — never hand-assemble a reply payload here (CLAUDE.md non-negotiable: rich_text_preformatted only, never mrkdwn, for the reply body). */
  payload: SlackMessagePayload;
}

/** POSTs to `chat.postMessage`. */
export async function postMessage(deps: SlackApiDeps, input: PostMessageInput): Promise<SlackMessageIdentity> {
  const body = await callSlackApi(deps, "chat.postMessage", {
    ...input.payload,
    channel: input.channel,
    thread_ts: input.threadTs,
  });
  if (!isMessageIdentity(body)) throw new Error("Slack Web API success response is missing channel or ts.");
  return { channel: body.channel, ts: body.ts };
}

export interface UpdateMessageInput {
  channel: string;
  ts: string;
  payload: SlackMessagePayload;
}

/** POSTs to `chat.update` — used to replace an approval-pending message once approved/cancelled. */
export async function updateMessage(deps: SlackApiDeps, input: UpdateMessageInput): Promise<void> {
  if (!input.channel || !input.ts) {
    throw new Error("Slack message identity is incomplete; cannot update message.");
  }
  await callSlackApi(deps, "chat.update", {
    ...input.payload,
    channel: input.channel,
    ts: input.ts,
  });
}

export interface PostEphemeralInput {
  channel: string;
  /** Slack user id the ephemeral message is only visible to. */
  user: string;
  threadTs?: string;
  payload: SlackMessagePayload;
}

export interface PostEphemeralResult {
  ts: string;
}

function isEphemeralResult(value: unknown): value is { message_ts: string } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.message_ts === "string" && record.message_ts.trim() !== "";
}

/** POSTs to `chat.postEphemeral` — used for admin-only notices (e.g. an authorization rejection) that only the acting user should see. */
export async function postEphemeral(deps: SlackApiDeps, input: PostEphemeralInput): Promise<PostEphemeralResult> {
  const body = await callSlackApi(deps, "chat.postEphemeral", {
    ...input.payload,
    channel: input.channel,
    user: input.user,
    thread_ts: input.threadTs,
  });
  if (!isEphemeralResult(body)) throw new Error("Slack Web API success response is missing message_ts.");
  return { ts: body.message_ts };
}

export interface ResponseUrlPayload {
  text?: string;
  blocks?: unknown[];
  replace_original?: boolean;
  delete_original?: boolean;
  response_type?: "in_channel" | "ephemeral";
}

export interface PostToResponseUrlDeps {
  fetch: FetchLike;
  sleep?: SleepFn;
  maxRetries?: number;
}

export interface PostToResponseUrlInput {
  /** Slack's interaction `response_url` — pre-authenticated by Slack itself (needs no bot token), usable up to 5 times within 30 minutes of the interaction payload it came from. */
  responseUrl: string;
  payload: ResponseUrlPayload;
}

/**
 * POSTs to a Slack interaction `response_url`. No bot token is sent — the
 * URL itself is the credential. Unlike every other method here, a
 * successful response body is the literal string `"ok"`, not JSON, so
 * success is HTTP-status only; the `{ok: true}` body check in
 * callSlackApi does not apply and this does not route through it.
 */
export async function postToResponseUrl(deps: PostToResponseUrlDeps, input: PostToResponseUrlInput): Promise<void> {
  const fetchImpl = deps.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = Math.max(0, Math.min(deps.maxRetries ?? DEFAULT_MAX_RETRIES, DEFAULT_MAX_RETRIES));

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(input.responseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.payload),
      });
    } catch {
      throw new Error("Could not reach the Slack response_url.");
    }
    if (res.status === 429) {
      if (attempt >= maxRetries) throw new Error("Slack response_url rate limit retry exhausted.");
      await sleep(retryAfterMilliseconds(res.headers.get("retry-after"), attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Slack response_url POST failed: HTTP ${res.status}`);
    return;
  }
}
