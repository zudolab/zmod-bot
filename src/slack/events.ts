/**
 * `POST /slack/events` — Slack Events API ingress: URL verification
 * challenge, signature check (src/slack/verify.ts), channel allow-list,
 * de-dup + durable job intake (src/db/repos.ts recordIncomingEvent).
 *
 * Every ignored event still returns 200 — see CLAUDE.md non-negotiable:
 * a non-2xx for an event this bot doesn't want spends one of Slack's
 * three retries to reach the identical conclusion.
 *
 * Implementation is issue #6's responsibility.
 */
import type { Env } from "../env";
import type { RouteContext } from "../router";

export async function handleSlackEvents(context: RouteContext): Promise<Response> {
  throw new Error("not implemented: handleSlackEvents");
}

/** The subset of Slack's app_mention event payload this bot reads. */
export interface SlackAppMentionEvent {
  type: "app_mention";
  event_ts: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

/** True when `channelId` is in SLACK_ALLOWED_CHANNEL_IDS (see src/env.ts parseCommaSeparated). */
export function isAllowedChannel(env: Env, channelId: string): boolean {
  throw new Error("not implemented: isAllowedChannel");
}
