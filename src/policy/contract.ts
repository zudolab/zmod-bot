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
