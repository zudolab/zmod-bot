/**
 * Parses an app_mention's text into a command, and gates the admin-only
 * ones. Flags/subcommands per data/seed/source-skill.md's original
 * `/l-reply-purchase` workflow (`--discord`, `--direct`) plus the ref
 * management commands from epic issue #1. Implementation is issue #14's
 * responsibility.
 */
import type { Env } from "../env";

export type ParsedCommand =
  | { kind: "reply"; query: string; discord: boolean; direct: boolean }
  | { kind: "ref_show"; slug: string }
  | { kind: "ref_history"; slug: string }
  | { kind: "ref_new"; query: string }
  | { kind: "ref_refresh"; slug: string }
  | { kind: "ref_restore"; slug: string; version: number }
  | { kind: "polish"; text: string }
  | { kind: "unknown"; raw: string };

/** Strips the leading `<@BOT_ID>` mention and parses flags/subcommands from the remaining text. */
export function parseCommand(rawText: string, botUserId: string): ParsedCommand {
  throw new Error("not implemented: parseCommand");
}

/**
 * Gate for `ref new/refresh/restore` and approval-button clicks —
 * SLACK_ADMIN_USER_IDS only, per CLAUDE.md "writes are gated" and epic
 * issue #1 decision 8.
 */
export function isAdminUser(env: Env, userId: string): boolean {
  throw new Error("not implemented: isAdminUser");
}
