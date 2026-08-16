/**
 * Slack Web API client — raw `fetch`, no `@slack/*` package (CLAUDE.md
 * non-negotiable). Implementation is issue #5's responsibility.
 */
import type { FetchLike } from "../types";

export interface SlackApiDeps {
  botToken: string;
  fetch: FetchLike;
}

export interface PostMessageInput {
  channel: string;
  threadTs?: string;
  /** Block Kit blocks — see src/slack/blocks.ts. Never mrkdwn for the reply body (CLAUDE.md non-negotiable). */
  blocks: unknown[];
  /** Fallback/notification text (required by the Slack API; not what the customer-facing reply renders as). */
  text: string;
}

export interface PostMessageResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

/** POSTs to `chat.postMessage`. */
export async function postMessage(deps: SlackApiDeps, input: PostMessageInput): Promise<PostMessageResult> {
  throw new Error("not implemented: postMessage");
}

export interface UpdateMessageInput extends PostMessageInput {
  ts: string;
}

/** POSTs to `chat.update` — used to replace an approval-pending message once approved/cancelled. */
export async function updateMessage(deps: SlackApiDeps, input: UpdateMessageInput): Promise<PostMessageResult> {
  throw new Error("not implemented: updateMessage");
}
