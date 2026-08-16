/**
 * The fixed-clause template set for every reply kind — byte-exact, and
 * never near a model (CLAUDE.md non-negotiable: "the fixed clauses of a
 * reply never go near a model").
 *
 * Every constant below is transcribed character for character from the
 * fenced blocks of data/seed/templates.md, which is the canonical source.
 * tests/reply/templates-drift.test.ts reads that file and fails on any
 * divergence, so the transcription cannot rot: do not "improve" the
 * Japanese here, change data/seed/templates.md and let the test tell you
 * what to update.
 *
 * A template is a *skeleton* — the fixed text with `{slot}` placeholders
 * the renderer fills (src/reply/render.ts). Flag handling
 * (`--direct` / `--discord`) is resolved here, data splicing there.
 */
import type { RefCategory } from "../refs/model";

/** Thrown when a reply cannot be rendered — a bad arrival sentence, a missing slot. */
export class ReplyRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyRenderError";
  }
}

/**
 * Which fixed-clause template a reply uses. This is *not* the product
 * category: a `general-diy` product renders `general` when the built
 * half was bought and `diy` when the kit was — see {@link templateKindFor}.
 */
export type ReplyTemplateKind = "general" | "diy" | "small";

/** Which half of a `general-diy` product the customer bought. */
export type PurchasedVariant = "built" | "kit";

/**
 * The two message flags. Named `ReplyFlags` rather than "variant"
 * because this file already carries two other senses of that word: the
 * built/kit half of a `general-diy` product ({@link PurchasedVariant}),
 * and the product variant a `variant-match` literal block keys on
 * (zudo-rail Lite vs Nuts — see src/refs/model.ts).
 */
export interface ReplyFlags {
  /** `--direct`: not a Mercari Shops order, so there is no shop evaluation to request. */
  direct: boolean;
  /** `--discord`: include the Discord guidance (email orders only — data/seed/source-skill.md). */
  discord: boolean;
}

export interface ReplyTemplateSet {
  kind: ReplyTemplateKind;
  /**
   * The fixed skeleton with both flags already applied, and the data
   * slots (`{arrival_schedule}`, `{product_name}`, `{build_guide}`,
   * `{product_resources}`) still in place for src/reply/render.ts.
   */
  skeleton: string;
}

/* -------------------------------------------------------------------------
 * Fixed clauses — data/seed/templates.md, verbatim.
 * ---------------------------------------------------------------------- */

/** Opening line of every reply. */
export const GREETING_LINE = "ご購入ありがとうございます。";

/** Yamato shipping line; the arrival sentence is spliced directly onto its end. */
export const YAMATO_SHIPPING_LINE = "こちら、本日ヤマトで発送させていただきました。";

/** Nekopos shipping lines — no arrival schedule follows them, by design. */
export const NEKOPOS_SHIPPING_LINES =
  "こちら先ほど配送させて頂きました。\nネコポス配送のため、郵便受けへの投函となるかもしれません。";

/** Dropped whole by `--direct`. */
export const EVALUATION_CLAUSE =
  "お受け取りいただけたら、特にコメント無しでも良いのでショップの評価を頂けると嬉しいです。";

/**
 * Every arrival sentence ends here. Inlining a raw answer instead
 * ("…発送させていただきました。明後日月曜お受け取りいただけたら、…") is broken
 * Japanese — the failure {@link assertValidArrivalSchedule} exists to stop.
 */
export const ARRIVAL_SENTENCE_ENDING = "到着予定になります。";

/** The DIY build-guide paragraph. Carries the `{product_name}` slot. */
export const DIY_BUILD_GUIDE_INTRO =
  "{product_name}について、こちらのDIYキットは、以下に写真入りのステップバイステップビルドガイドが用意されておりまして、こちらを参照しつつお作りいただければと存じます。";

/** Separator line above a section that carries a `Separator intro:` (data/seed/templates.md "Notes"). */
export const RESOURCE_SEPARATOR = "===";

/**
 * Discord guidance, including its own leading `---` separator. Off by
 * default: Mercari Shops customers already get it in the auto-reply.
 */
export const DISCORD_BLOCK = `---

ほか、ご購入くださった方には、Takazudo ModularのDiscordをご案内させていただいております。

Discordサーバーのご案内 | Takazudo Modular
https://takazudomodular.com/s/discord/

こちらでは、Takazudo Modularの新着情報告知／お得なお知らせや、入荷の相談、気軽な雑談、モジュラーやシンセDIYに関する質問等をし合うようなチャットになっております。ご興味あるようでしたら、お気軽に覗いて頂けると幸いです。`;

/* -------------------------------------------------------------------------
 * Skeletons.
 * ---------------------------------------------------------------------- */

const GENERAL_SKELETON = `${GREETING_LINE}
${YAMATO_SHIPPING_LINE}{arrival_schedule}${EVALUATION_CLAUSE}

{product_resources}

{discord}

不明点等ございましたらお気軽にコメント等頂ければと存じます。
よろしくお願いいたします！`;

const DIY_SKELETON = `${GREETING_LINE}
${YAMATO_SHIPPING_LINE}{arrival_schedule}${EVALUATION_CLAUSE}

${DIY_BUILD_GUIDE_INTRO}

{build_guide}

{product_resources}

ほか、DIY入門者向けのガイドをサイトに用意しました。
もしご興味がございましたら、ご参考にしていただけると幸いです。

ガイド: シンセDIYとDIYキット
https://takazudomodular.com/guides/col001-diy-kits/
ガイド: シンセDIYに必要な道具
https://takazudomodular.com/notes/2024-08-07-col002-diy-tools/

{discord}

使い方についても不明点ありましたら、お気軽に質問等していただければと存じます。

よろしくお願いいたします！`;

/**
 * `small` has **no** arrival sentence — data/seed/templates.md gives the
 * Nekopos wording with none, and there is no slot here to splice one into.
 *
 * The `{product_resources}` slot is the one addition to the file's block:
 * zudo-rail is a `small` product whose reference carries an assembly
 * guide and two mandatory notices, so `small` needs the same resources
 * slot the other two kinds have. It sits where `general` puts it (after
 * the shipping paragraph, before the evaluation), and with no resources
 * the rendered output is byte-identical to data/seed/templates.md again —
 * asserted in tests/reply/templates-drift.test.ts.
 */
const SMALL_SKELETON = `${GREETING_LINE}
${NEKOPOS_SHIPPING_LINES}

{product_resources}

{discord}

${EVALUATION_CLAUSE}よろしくお願いいたします！`;

const SKELETONS: Record<ReplyTemplateKind, string> = {
  general: GENERAL_SKELETON,
  diy: DIY_SKELETON,
  small: SMALL_SKELETON,
};

/* -------------------------------------------------------------------------
 * Slots.
 * ---------------------------------------------------------------------- */

/** Slots that occupy a whole paragraph, and collapse away when empty. */
export const BLOCK_SLOTS = ["build_guide", "product_resources", "discord"] as const;
/** Slots spliced into the middle of a line. */
export const INLINE_SLOTS = ["arrival_schedule", "product_name"] as const;

export type BlockSlot = (typeof BLOCK_SLOTS)[number];
export type InlineSlot = (typeof INLINE_SLOTS)[number];

const blockSlotPattern = (slot: BlockSlot): RegExp => new RegExp(`\\n\\n\\{${slot}\\}\\n\\n`);

/**
 * Replaces a whole-paragraph slot, or removes the paragraph (and one of
 * its two blank lines) when the content is empty — which is how a product
 * with no resources renders back to exactly the block in
 * data/seed/templates.md.
 *
 * A function replacer, here and in {@link fillInlineSlot}, because `$&`
 * and friends in a URL or a title would otherwise be interpreted.
 */
export function fillBlockSlot(skeleton: string, slot: BlockSlot, content: string): string {
  const pattern = blockSlotPattern(slot);
  if (!pattern.test(skeleton)) {
    throw new ReplyRenderError(`template has no {${slot}} slot to fill`);
  }
  return skeleton.replace(pattern, () => (content === "" ? "\n\n" : `\n\n${content}\n\n`));
}

export function fillInlineSlot(skeleton: string, slot: InlineSlot, content: string): string {
  const token = `{${slot}}`;
  if (!skeleton.includes(token)) {
    throw new ReplyRenderError(`template has no ${token} slot to fill`);
  }
  return skeleton.replaceAll(token, () => content);
}

/**
 * Guards the whole class of bug where a slot survives into the message a
 * customer reads. Called on the finished text.
 */
export function assertNoSlotsRemain(text: string): void {
  const remaining = [...BLOCK_SLOTS, ...INLINE_SLOTS].filter((slot) => text.includes(`{${slot}}`));
  if (remaining.length > 0) {
    throw new ReplyRenderError(
      `unfilled template slot(s) in the rendered reply: ${remaining.map((slot) => `{${slot}}`).join(", ")}`,
    );
  }
}

/* -------------------------------------------------------------------------
 * Arrival schedule.
 * ---------------------------------------------------------------------- */

export interface ArrivalScheduleParts {
  /** The day as the operator picked it, without the date — e.g. `明後日月曜`. */
  dayLabel: string;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
}

/** Full-width `（8/18）`, as data/seed/templates.md writes it; a half-width pair is accepted too. */
const ARRIVAL_DATE = /（\d{1,2}\/\d{1,2}）|\(\d{1,2}\/\d{1,2}\)/;

/**
 * Builds the one legal shape of arrival sentence:
 * `明後日月曜（8/18）到着予定になります。`
 *
 * Pure — the date is an argument, never a clock reading, so the same
 * input always renders the same bytes.
 */
export function formatArrivalSchedule(parts: ArrivalScheduleParts): string {
  const dayLabel = parts.dayLabel.trim();
  if (dayLabel === "") throw new ReplyRenderError("arrival schedule has no day label");
  if (!Number.isInteger(parts.month) || parts.month < 1 || parts.month > 12) {
    throw new ReplyRenderError(`arrival schedule month is out of range: ${parts.month}`);
  }
  if (!Number.isInteger(parts.day) || parts.day < 1 || parts.day > 31) {
    throw new ReplyRenderError(`arrival schedule day is out of range: ${parts.day}`);
  }

  const sentence = `${dayLabel}（${parts.month}/${parts.day}）${ARRIVAL_SENTENCE_ENDING}`;
  assertValidArrivalSchedule(sentence);
  return sentence;
}

/**
 * The two rules from data/seed/templates.md that a hand-typed arrival
 * answer breaks: it must terminate as a sentence, and it must carry the
 * `M/D` date the operator selected. Both failures are silent otherwise —
 * the message still sends, it just reads wrong to a paying customer.
 */
export function assertValidArrivalSchedule(text: string): void {
  if (!text.endsWith(ARRIVAL_SENTENCE_ENDING)) {
    throw new ReplyRenderError(
      `arrival schedule must be a complete sentence ending in ${JSON.stringify(ARRIVAL_SENTENCE_ENDING)}, got ${JSON.stringify(text)} — inlining a raw answer produces broken Japanese`,
    );
  }
  if (!ARRIVAL_DATE.test(text)) {
    throw new ReplyRenderError(
      `arrival schedule must carry the explicit M/D date in parentheses, e.g. 明後日月曜（8/18）到着予定になります。 — got ${JSON.stringify(text)}`,
    );
  }
}

/* -------------------------------------------------------------------------
 * Template selection.
 * ---------------------------------------------------------------------- */

/**
 * The category → template map (issue #7): `general` → general,
 * `general-diy` → general for the built half and diy for the kit,
 * `small` → small.
 *
 * `purchased` is meaningless for the categories with no kit half, and is
 * ignored there rather than rejected — a caller that defaults it to
 * `"kit"` for every DIY-ish query still gets the right template.
 */
export function templateKindFor(
  category: RefCategory,
  purchased: PurchasedVariant = "built",
): ReplyTemplateKind {
  if (category === "small") return "small";
  if (category === "general-diy" && purchased === "kit") return "diy";
  return "general";
}

/** The fixed-clause skeleton for a template kind, with both flags applied. */
export function getTemplateSet(kind: ReplyTemplateKind, flags: ReplyFlags): ReplyTemplateSet {
  let skeleton = SKELETONS[kind];

  if (flags.direct) {
    // Exactly one, so a template that grew a second copy of the clause
    // cannot half-drop it and ship the evaluation request anyway.
    const occurrences = skeleton.split(EVALUATION_CLAUSE).length - 1;
    if (occurrences !== 1) {
      throw new ReplyRenderError(
        `the ${kind} template holds ${occurrences} evaluation clauses for --direct to drop, expected exactly 1`,
      );
    }
    skeleton = skeleton.replace(EVALUATION_CLAUSE, () => "");
  }
  skeleton = fillBlockSlot(skeleton, "discord", flags.discord ? DISCORD_BLOCK : "");

  return { kind, skeleton };
}
