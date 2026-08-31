/**
 * Stable contract for policy/reply-guidance.md.
 *
 * The later policy validator uses these values to keep bot-authored policy
 * changes inside the one file's intentionally small, reviewable surface.
 */

/** The only file the policy PR loop may edit. */
export const POLICY_DOC_PATH = "policy/reply-guidance.md";

/**
 * Immutable metadata at the top of the policy document. Keep this exact
 * block stable: later validators use it to identify the document and explain
 * its trust boundary to anyone editing it by hand or through the bot.
 */
export const POLICY_HEADER = `<!--
This file is bot-editable via \`@bot policy\`.
Its content is injected into the compose system prompt.
It must never contain URLs, fixed reply clauses, or customer data.
-->`;

/** Required Markdown H2 headings, in their fixed order. */
export const POLICY_REQUIRED_HEADINGS = [
  "## Tone and register",
  "## Paragraph and link formatting",
  "## 追加ガイダンス",
] as const;

/** Maximum UTF-8 byte size of the tracked policy document. */
export const POLICY_MAX_BYTES = 8192;

/** Maximum UTF-16 code-unit length accepted for an operator's edit request. */
export const POLICY_MAX_REQUEST_CHARS = 1000;

/** Policy-edit calls allowed per UTC day. Kept deliberately small: edits are rare and human-reviewed. */
export const POLICY_DAILY_CAP = 20;

/** Wall-clock bound for the policy editor call. Policy edits run outside Slack's acknowledgement path. */
export const POLICY_UPDATE_DEADLINE_MS = 30_000;

/** How long a stash-backed policy proposal remains available for review. */
export const POLICY_APPROVAL_WINDOW_MS = 72 * 60 * 60 * 1_000;
