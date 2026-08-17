/**
 * Block Kit builders — see CLAUDE.md non-negotiable: what the human copies
 * out of Slack must equal what the generator produced. The reply body is
 * always `rich_text` -> `rich_text_preformatted` (literal content), never
 * mrkdwn — mrkdwn round-trips `&` / `<` / `>` through HTML entities, which
 * would silently corrupt a message pasted verbatim into Mercari Shops.
 */

/** Escapes the three characters Slack treats as control chars in `mrkdwn` text (https://api.slack.com/reference/surfaces/formatting#escaping). Only for chrome (headers/buttons/hints) built as mrkdwn `section`/`context` blocks — never applied to the reply body (rich_text_preformatted is literal) and never applied to a URL. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Slack Block Kit ceilings (https://api.slack.com/reference/block-kit/blocks):
// a message carries at most 50 blocks total, and a text object is safest
// kept under the 3,000-char limit Slack documents for mrkdwn `section.text`
// — reused here as the same conservative per-block budget for
// `rich_text_preformatted`, since Slack does not separately document a
// higher ceiling for it. `chat.postMessage`'s top-level `text` tops out
// around 40,000 chars, but that field only ever carries a short
// notification summary here (see buildMessagePayload), never the reply
// body, so it is not an active split boundary.
export const MAX_BLOCKS_PER_MESSAGE = 50;
export const MAX_CHARS_PER_PREFORMATTED_BLOCK = 3_000;
/**
 * Slack's documented ceiling for a `section` block's mrkdwn `text` — the
 * same 3,000 the comment above *borrows* for `rich_text_preformatted`,
 * named separately because here it is the documented limit rather than a
 * conservative reuse of one. An oversized section is rejected outright
 * (`invalid_blocks`), taking the whole message with it.
 */
export const MAX_CHARS_PER_SECTION_TEXT = 3_000;

/**
 * Splits `text` into chunks of at most `maxChars`, breaking only right
 * after a `\n` — never mid-line. `chunks.join("")` always reproduces the
 * original string byte-for-byte, because the split points are chosen from
 * among the string's own newline positions rather than by slicing at a
 * fixed offset. A single line longer than `maxChars` (no newline to break
 * at) is kept whole as its own oversized chunk rather than being cut mid
 * word — silent truncation of a customer message is the failure mode this
 * is designed to avoid, not raw adherence to the budget.
 */
export function splitPreformattedText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  // Split right after every "\n" so each element still carries its own
  // trailing newline; concatenating the array is then exact reassembly.
  const lines = text.split(/(?<=\n)/);
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if (line.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(line);
      continue;
    }
    if (current.length + line.length > maxChars) {
      chunks.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** One `rich_text` block wrapping a single `rich_text_preformatted` element with literal `content`. */
function richTextPreformattedBlock(content: string): unknown {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_preformatted",
        elements: [{ type: "text", text: content }],
      },
    ],
  };
}

/**
 * Wraps `text` as one or more `rich_text` -> `rich_text_preformatted`
 * blocks — literal content, never mrkdwn. Splits at a line boundary
 * (splitPreformattedText) when `text` exceeds the per-block budget rather
 * than truncating. The 50-block message ceiling is a whole-payload
 * concern owned by whoever assembles the final message around this reply
 * (chrome blocks included) — a reply this long is not expected in
 * practice, so it is documented (MAX_BLOCKS_PER_MESSAGE) rather than
 * enforced in isolation here.
 */
export function buildReplyBlocks(text: string): unknown[] {
  return splitPreformattedText(text, MAX_CHARS_PER_PREFORMATTED_BLOCK).map(richTextPreformattedBlock);
}

export interface SlackMessagePayload {
  blocks: unknown[];
  text: string;
  unfurl_links: false;
  unfurl_media: false;
}

/** Wraps an arbitrary block array into a full postable `chat.postMessage`/`chat.update` payload — the shared tail every builder below funnels through. */
export function buildMessagePayload(blocks: unknown[], text: string): SlackMessagePayload {
  return { blocks, text, unfurl_links: false, unfurl_media: false };
}

export interface BuildReplyMessagePayloadInput {
  /** The full, byte-exact reply body — rendered via rich_text_preformatted. */
  replyText: string;
  /** The notification fallback shown in the channel list / push notification — a short summary, NOT the reply body (CLAUDE.md correctness surface: the reply is the thing that gets copied, this is not it). */
  summaryText: string;
}

/** Builds the complete postable payload for a composed reply: the reply body as rich_text_preformatted block(s), plus a short top-level `text` and unfurl suppression. */
export function buildReplyMessagePayload(input: BuildReplyMessagePayloadInput): SlackMessagePayload {
  return buildMessagePayload(buildReplyBlocks(input.replyText), input.summaryText);
}

/** Marker appended to any text this module had to shorten to fit a block's ceiling. */
const TRUNCATION_MARKER = "…";

/** The longest escape `escapeMrkdwn` emits, `&amp;`. An entity split by a cut must therefore start within the last four characters. */
const LONGEST_MRKDWN_ENTITY = 5;

/**
 * Drops a trailing `&…` whose `;` was lost to a cut. Half of an escape
 * renders as the literal text `&am` rather than the character it stood
 * for. Only a `&` near the very end is treated as a casualty of the cut —
 * a bare `&` further back belongs to the text and is left alone.
 */
function trimDanglingEntity(text: string): string {
  const lastAmpersand = text.lastIndexOf("&");
  // No ampersand at all, or one further back than the longest escape
  // could reach: only the cut can dangle an entity, and a dangling one
  // must start within the final few characters.
  if (lastAmpersand === -1 || lastAmpersand < text.length - (LONGEST_MRKDWN_ENTITY - 1)) return text;
  return text.includes(";", lastAmpersand) ? text : text.slice(0, lastAmpersand);
}

/**
 * Bounds an **already-rendered** mrkdwn string to
 * MAX_CHARS_PER_SECTION_TEXT (issue #33).
 *
 * This is the backstop, not the precise tool. Slack rejects an oversized
 * text object with `invalid_blocks` and drops the entire message, so any
 * builder whose text can grow with operator input, a stored reference
 * body or an error string needs *something* here — but a whole-string cut
 * takes the tail off, which for a sentence means losing its ending. Where
 * a builder knows which part of its text is the unbounded one, it should
 * bound that part first (see fitMissingRefSectionText) and let this only
 * ever be a no-op.
 *
 * Unlike fitMissingRefSectionText this takes text that has *already* been
 * through escapeMrkdwn, so it must not re-escape and must not cut an
 * escape in half. Iteration is by code point so no cut lands between the
 * halves of an astral character.
 */
export function fitSectionText(text: string): string {
  if (text.length <= MAX_CHARS_PER_SECTION_TEXT) return text;

  const budget = MAX_CHARS_PER_SECTION_TEXT - TRUNCATION_MARKER.length;
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > budget) break;
    kept += character;
  }
  return trimDanglingEntity(kept) + TRUNCATION_MARKER;
}

/** A `section` block carrying mrkdwn `text`, bounded to what Slack will accept. Every mrkdwn section should be built through this rather than by hand, so no builder can forget the ceiling. */
export function mrkdwnSection(blockId: string, text: string): unknown {
  return { type: "section", block_id: blockId, text: { type: "mrkdwn", text: fitSectionText(text) } };
}

/** A `context` block carrying one mrkdwn element, bounded the same way. */
export function mrkdwnContextBlock(blockId: string, text: string): unknown {
  return { type: "context", block_id: blockId, elements: [{ type: "mrkdwn", text: fitSectionText(text) }] };
}

/** One `plain_text` Block Kit button. */
function plainTextButton(input: {
  actionId: string;
  label: string;
  value: string;
  style?: "primary" | "danger";
}): unknown {
  return {
    type: "button",
    action_id: input.actionId,
    text: { type: "plain_text", text: input.label, emoji: true },
    value: input.value,
    ...(input.style ? { style: input.style } : {}),
  };
}

export interface ConfirmCancelBlocksInput {
  blockId: string;
  confirmActionId: string;
  cancelActionId: string;
  /** Opaque token carried by both buttons — e.g. a D1 draft row id, never the draft content itself (Slack caps a button `value` at 2000 chars; see epic issue #1 decision 8). */
  value: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** Generic approve/cancel button row with stable, caller-chosen action_ids and an explicit block_id. */
export function buildConfirmCancelBlocks(input: ConfirmCancelBlocksInput): unknown[] {
  return [
    {
      type: "actions",
      block_id: input.blockId,
      elements: [
        plainTextButton({
          actionId: input.confirmActionId,
          label: input.confirmLabel ?? "承認",
          value: input.value,
          style: "primary",
        }),
        plainTextButton({
          actionId: input.cancelActionId,
          label: input.cancelLabel ?? "キャンセル",
          value: input.value,
          style: "danger",
        }),
      ],
    },
  ];
}

export interface ApprovalButtonsInput {
  actionId: string;
  /** Opaque token identifying the pending D1 draft row — never the draft content itself (Slack caps `value` at 2000 chars; see epic issue #1 decision 8). */
  value: string;
}

/** Builds an actions block with approve/cancel buttons for a pending gated write (ref new/refresh/restore). */
export function buildApprovalBlocks(input: ApprovalButtonsInput): unknown[] {
  return buildConfirmCancelBlocks({
    blockId: `${input.actionId}_block`,
    confirmActionId: `${input.actionId}_approve`,
    cancelActionId: `${input.actionId}_cancel`,
    value: input.value,
  });
}

/** Interaction-payload action_id for the "create a reference" button built by buildMissingRefBlocks. */
export const CREATE_REFERENCE_ACTION_ID = "create_reference";

/**
 * The miss reply's section text for an already-fitted `query`. Escaping
 * happens here rather than at the call site because the budget below has
 * to measure the *escaped* length: `escapeMrkdwn` turns one `&` into five
 * characters, so a query trimmed to a raw-length budget can still
 * overflow.
 */
function missingRefSectionText(query: string): string {
  return `「${escapeMrkdwn(query)}」に一致する製品リファレンスが見つかりませんでした。`;
}

/**
 * Fits `query` into a miss-reply section that respects
 * MAX_CHARS_PER_SECTION_TEXT (issue #31).
 *
 * A mention is unbounded free text and the failure mode is total rather
 * than degraded: Slack rejects an oversized section with
 * `invalid_blocks`, so the customer gets *no* reply instead of a
 * shortened one.
 *
 * Two things make the obvious `slice` wrong, and both are why this walks
 * the query a character at a time charging each one its *escaped* cost:
 *
 * - Escaping is not one-for-one, so an overflow counted in rendered
 *   characters cannot be subtracted from a source length. A query of
 *   3,000 `&` renders as 15,000 characters; slicing off the 12,000-odd
 *   overflow would leave nothing at all, when ~590 of them fit.
 * - Slicing by code unit can land between the halves of an astral
 *   character (emoji, rarer kanji) and emit a lone surrogate, which is not
 *   valid UTF-8 on the wire. Iterating the string yields whole code
 *   points, so no cut can fall inside one.
 *
 * The per-character cost comes from escapeMrkdwn itself rather than a
 * hand-written table of its expansions, so the two can never drift.
 */
function fitMissingRefSectionText(query: string): string {
  const full = missingRefSectionText(query);
  if (full.length <= MAX_CHARS_PER_SECTION_TEXT) return full;

  // What is left for the query once the fixed chrome and the marker are paid for.
  const budget = MAX_CHARS_PER_SECTION_TEXT - missingRefSectionText(TRUNCATION_MARKER).length;
  let kept = "";
  let spent = 0;
  for (const character of query) {
    const cost = escapeMrkdwn(character).length;
    if (spent + cost > budget) break;
    kept += character;
    spent += cost;
  }
  return missingRefSectionText(kept + TRUNCATION_MARKER);
}

/**
 * Builds the "no reference found" message: a mrkdwn note plus an inline
 * "create a reference" button (epic issue #1 decision 7).
 *
 * The two halves are bounded in opposite places, and deliberately so:
 *
 * - `query` is display text, so it is truncated *here*, against the
 *   section's own ceiling (issue #31). Before that, a mention over ~3,000
 *   characters made the entire message unpostable.
 * - `buttonValue` arrives already encoded and already inside Slack's
 *   2000-char `value` ceiling — src/slack/commands.ts
 *   buildMissingRefPayload owns both, the same way it owns the
 *   arrival/variant/candidate pickers' envelopes. This builder must NOT
 *   truncate it: since issue #25 the value is a JSON envelope carrying
 *   the originating job id, and slicing JSON yields a value that decodes
 *   to `null` rather than a shorter one.
 *
 * So the shown query and the query inside the button can differ in
 * length. That is fine — they answer to different limits, and the button
 * only has to survive the round trip.
 */
export function buildMissingRefBlocks(query: string, buttonValue: string): unknown[] {
  return [
    // The query is fitted *before* the generic bound, not instead of it:
    // fitSectionText would cut the sentence's ending off, where
    // fitMissingRefSectionText cuts the query and leaves the sentence
    // whole. Going through mrkdwnSection anyway keeps every section in
    // this file on one builder.
    mrkdwnSection("missing_ref_message", fitMissingRefSectionText(query)),
    {
      type: "actions",
      block_id: "missing_ref_actions",
      elements: [
        plainTextButton({
          actionId: CREATE_REFERENCE_ACTION_ID,
          label: "リファレンスを作成",
          value: buttonValue,
          style: "primary",
        }),
      ],
    },
  ];
}

export interface ArrivalDateOption {
  /** Button label — the caller computes the JST weekday/date text (e.g. "明日水曜 8/16"); see data/seed/source-skill.md "Ask Shipping Details". */
  label: string;
  /** Opaque value carried back on click — the arrival-schedule sentence fragment, or a sentinel like "other" for the free-text follow-up. */
  value: string;
}

export interface ArrivalDateBlocksInput {
  blockId: string;
  /** Base action_id; each button gets a stable `${actionId}_${index}` suffix matching its position in `options`. */
  actionId: string;
  options: ArrivalDateOption[];
}

/** Builds the arrival-date quick-pick button row (tomorrow / day-after / day-after-day-after / other — data/seed/source-skill.md). */
export function buildArrivalDateBlocks(input: ArrivalDateBlocksInput): unknown[] {
  return [
    {
      type: "actions",
      block_id: input.blockId,
      elements: input.options.map((option, index) =>
        plainTextButton({
          actionId: `${input.actionId}_${index}`,
          label: option.label,
          value: option.value,
        }),
      ),
    },
  ];
}
