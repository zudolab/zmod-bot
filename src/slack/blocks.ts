/**
 * Block Kit builders. Implementation is issue #5's responsibility.
 */

/**
 * Wraps `text` as a single `rich_text_preformatted` block — literal
 * content, never mrkdwn. See CLAUDE.md non-negotiable: mrkdwn round-trips
 * `&` / `<` / `>` through HTML entities, so what the human copies out of
 * Slack must equal what the generator produced only via this block type.
 */
export function buildReplyBlocks(text: string): unknown[] {
  throw new Error("not implemented: buildReplyBlocks");
}

export interface ApprovalButtonsInput {
  actionId: string;
  /** Opaque token identifying the pending D1 draft row — never the draft content itself (Slack caps `value` at 2000 chars; see epic issue #1 decision 8). */
  value: string;
}

/** Builds an actions block with approve/cancel buttons for a pending gated write (ref new/refresh/restore). */
export function buildApprovalBlocks(input: ApprovalButtonsInput): unknown[] {
  throw new Error("not implemented: buildApprovalBlocks");
}

/** Builds the "no reference found" block with an inline "create a reference" button — see epic issue #1 decision 7. */
export function buildMissingRefBlocks(query: string): unknown[] {
  throw new Error("not implemented: buildMissingRefBlocks");
}
