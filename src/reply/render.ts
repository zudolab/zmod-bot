/**
 * Deterministic message assembly — the fixed skeleton
 * (src/reply/templates.ts) wrapped around a resources section, which is
 * either LLM-composed (src/reply/compose.ts, the normal path) or rendered
 * here directly (the fallback whenever a guard trips — CLAUDE.md
 * "deterministic skeleton, LLM middle, deterministic fallback").
 *
 * Pure by construction: no clock, no network, no I/O. The arrival date is
 * an argument, so the same ProductRef and the same flags always render
 * the same bytes — which is what lets the golden corpus in
 * tests/reply/golden.test.ts be an oracle rather than a moving target.
 *
 * **Section `prose` is emitted unless the heading is `Notes` or
 * `Notes (additional)`.** Those two headings are editorial — addressed to
 * whoever composes the reply, never to the customer (x0x-heart's "Hand-built
 * by Takazudo Modular. Add a note asking the customer to contact if anything
 * seems wrong." and oxi-pipe-mk2's "do NOT include any intro/explanation").
 * Everything else is customer-facing.
 *
 * The heading split is the deterministic rule, verified against the frozen
 * corpus: of the 22 sections carrying prose, 21 are `Notes` / `Notes
 * (additional)` and exactly one is not — zudo-3u-to-1u's
 * `Usage Guide (取り付け方法)`, which is Japanese installation instructions a
 * buyer of that product needs. Dropping all prose (the previous behaviour)
 * silently shipped that product's reply without them. Feeding `Notes*` prose
 * to the model as guidance is still the LLM path's job (issue #13); this
 * renderer never emits it.
 */
import type { ProductRef, RefLiteralBlock, RefResource, RefSection } from "../refs/model";
import {
  assertNoSlotsRemain,
  assertValidArrivalSchedule,
  DIY_BUILD_GUIDE_INTRO,
  fillBlockSlot,
  fillInlineSlot,
  getTemplateSet,
  RESOURCE_SEPARATOR,
  ReplyRenderError,
  templateKindFor,
  type PurchasedVariant,
  type ReplyFlags,
  type ReplyTemplateSet,
} from "./templates";

export { ReplyRenderError } from "./templates";

export interface RenderReplyInput {
  ref: ProductRef;
  templates: ReplyTemplateSet;
  /**
   * Pre-formatted arrival sentence — build it with
   * `formatArrivalSchedule` (src/reply/templates.ts). Must be null for
   * `small`, which has no arrival sentence, and non-null otherwise.
   */
  arrivalSchedule: string | null;
  /**
   * The composed (LLM or deterministic-fallback) product-resources
   * section. For the diy template this must NOT contain the Build Guide
   * sections: renderReply renders those itself, from the reference, into
   * the `{build_guide}` slot under the fixed build-guide paragraph — a
   * URL is data to copy, not text for a model to restate.
   * {@link renderResourceSectionDeterministic} already withholds them
   * when `diy` is set.
   */
  resourceSection: string;
  /**
   * How the operator named the purchased variant, e.g.
   * `"zudo-rail lite 60 set1"`. A `variant-match` literal block ships
   * only when one of its needles occurs here; with no variant named,
   * none of them do.
   */
  variantText?: string;
}

export interface RenderResourceOptions {
  /**
   * True when the DIY kit was bought: `diy-only` sections are emitted,
   * and Build Guide sections are withheld because the diy template
   * renders them in its own `{build_guide}` slot, under the fixed
   * build-guide paragraph.
   */
  diy?: boolean;
  /** See {@link RenderReplyInput.variantText}. */
  variantText?: string;
}

export interface DeterministicReplyInput {
  ref: ProductRef;
  flags: ReplyFlags;
  /** Must be null for a `small` product, non-null otherwise. */
  arrivalSchedule: string | null;
  /** Which half of a `general-diy` product was bought. Defaults to `"built"`. */
  purchased?: PurchasedVariant;
  /** See {@link RenderReplyInput.variantText}. */
  variantText?: string;
}

/**
 * The whole fallback path: pick the template, render the resources from
 * the reference, assemble. This is what src/reply/compose.ts falls back
 * to when a guard trips, and what the golden corpus pins.
 */
export function renderDeterministicReply(input: DeterministicReplyInput): string {
  const kind = templateKindFor(input.ref.category, input.purchased ?? "built");
  const variantOption = input.variantText === undefined ? {} : { variantText: input.variantText };

  return renderReply({
    ref: input.ref,
    templates: getTemplateSet(kind, input.flags),
    arrivalSchedule: input.arrivalSchedule,
    resourceSection: renderResourceSectionDeterministic(input.ref, {
      diy: kind === "diy",
      ...variantOption,
    }),
    ...variantOption,
  });
}

/** Assembles the final byte-for-byte message the human copies into Mercari Shops. */
export function renderReply(input: RenderReplyInput): string {
  const { ref, templates, arrivalSchedule, resourceSection } = input;
  let text = templates.skeleton;

  if (templates.kind === "small") {
    if (arrivalSchedule !== null) {
      throw new ReplyRenderError(
        `the small template has no arrival sentence (Nekopos has no delivery date), but one was given: ${JSON.stringify(arrivalSchedule)}`,
      );
    }
  } else {
    if (arrivalSchedule === null) {
      throw new ReplyRenderError(`the ${templates.kind} template requires an arrival schedule`);
    }
    assertValidArrivalSchedule(arrivalSchedule);
    text = fillInlineSlot(text, "arrival_schedule", arrivalSchedule);
  }

  if (templates.kind === "diy") {
    const buildGuide = renderBuildGuide(ref, input.variantText);
    if (buildGuide === "") {
      // No build guide to point at, so the paragraph introducing it goes
      // too — otherwise the reply promises a step-by-step guide and then
      // shows nothing.
      text = dropBuildGuideIntro(text);
    } else {
      text = fillInlineSlot(text, "product_name", ref.displayName);
    }
    text = fillBlockSlot(text, "build_guide", buildGuide);
  }

  text = fillBlockSlot(text, "product_resources", resourceSection);
  assertNoSlotsRemain(text);
  return text;
}

/**
 * Deterministic (non-LLM) rendering of a ProductRef's resources section
 * straight from its parsed sections — the fallback path whenever a guard
 * trips (src/llm/guards.ts).
 */
export function renderResourceSectionDeterministic(
  ref: ProductRef,
  options: RenderResourceOptions = {},
): string {
  const diy = options.diy ?? false;
  const sections: string[] = [];

  for (const section of ref.sections) {
    if (section.gate === "diy-only" && !diy) continue;
    if (diy && isBuildGuideSection(section)) continue;
    const rendered = renderSection(section, options.variantText);
    if (rendered !== null) sections.push(rendered);
  }

  return sections.join("\n\n");
}

/**
 * The `{build_guide}` slot of the diy template. Ungated as well as
 * `diy-only` Build Guide sections count: we are rendering the kit
 * purchase, so every Build Guide section applies.
 *
 * Only the diy template has this slot. `small` products with a Build
 * Guide section (zb40-intro, zudo-block-60-open — screwdriver assembly,
 * no soldering) render theirs inline with the other resources and
 * deliberately get no DIY-beginner guides.
 */
function renderBuildGuide(ref: ProductRef, variantText: string | undefined): string {
  return ref.sections
    .filter(isBuildGuideSection)
    .map((section) => renderSection(section, variantText))
    .filter((rendered): rendered is string => rendered !== null)
    .join("\n\n");
}

function dropBuildGuideIntro(skeleton: string): string {
  const paragraph = `\n\n${DIY_BUILD_GUIDE_INTRO}`;
  if (!skeleton.includes(paragraph)) {
    throw new ReplyRenderError("the diy template has no build-guide paragraph to drop");
  }
  return skeleton.replace(paragraph, () => "");
}

function isBuildGuideSection(section: RefSection): boolean {
  return section.heading.trim().toLowerCase() === "build guide";
}

/**
 * One section as it appears in a reply: no heading (the headings are the
 * reference file's own filing system, not customer-facing), intro above
 * the links, and every link broken across two lines.
 *
 * Returns null for a section with nothing to say — a Notes section is
 * all prose, and `Notes*` prose is not emitted.
 */
function renderSection(section: RefSection, variantText: string | undefined): string | null {
  const paragraphs: string[] = [];

  if (section.separatorIntro !== undefined) paragraphs.push(section.separatorIntro);
  if (section.introText !== undefined) paragraphs.push(section.introText);
  if (section.prose !== undefined && !isEditorialHeading(section.heading)) paragraphs.push(section.prose);
  if (section.resources.length > 0) paragraphs.push(section.resources.map(renderResource).join("\n"));
  for (const block of section.literalBlocks) {
    if (includesLiteralBlock(block, variantText)) paragraphs.push(block.text);
  }

  if (paragraphs.length === 0) return null;
  // `Separator intro:` is what marks a section as the "extra/older
  // resources" one, and data/seed/templates.md puts a `===` rule above it.
  if (section.separatorIntro !== undefined) paragraphs.unshift(RESOURCE_SEPARATOR);
  return paragraphs.join("\n\n");
}

/**
 * `- {title}: {url}` in the reference file becomes two lines in the
 * message. The colon stays on the title line: data/seed/source-skill.md
 * §4 spells this transformation out with a worked example
 * (`OXI Instruments: OXI Split V2:` / newline / the URL), and it is the
 * only rendered example of a derived resource line in either canonical
 * source. (The hand-written link pairs inside templates.md's own fixed
 * blocks carry no colon, but those are literal text, not lines derived
 * from a `- Title: URL` bullet.)
 */
/**
 * `Notes` and `Notes (additional)` are the reference corpus's two editorial
 * headings: their prose instructs whoever composes the reply and must never
 * reach a customer. Every other heading's prose is customer-facing.
 */
function isEditorialHeading(heading: string): boolean {
  return heading === "Notes" || heading === "Notes (additional)";
}

function renderResource(resource: RefResource): string {
  return `${resource.title}:\n${resource.url}`;
}

function includesLiteralBlock(block: RefLiteralBlock, variantText: string | undefined): boolean {
  if (block.rule.kind === "always") return true;
  if (variantText === undefined) return false;
  const haystack = variantText.toLowerCase();
  return block.rule.needles.some((needle) => haystack.includes(needle.toLowerCase()));
}
