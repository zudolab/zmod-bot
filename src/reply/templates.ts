/**
 * The fixed-clause template set for each product category — byte-exact,
 * never go near a model (CLAUDE.md non-negotiable). Content mirrors
 * data/seed/templates.md; getting it byte-exact (including the
 * `--direct` / `--discord` variant wording) is issue #7's
 * responsibility.
 */
import type { RefCategory } from "../refs/model";

export interface ReplyTemplateSet {
  /** Opening line(s) before the shipping line. */
  greeting: string;
  /**
   * Shipping method line, containing the `{arrival_schedule}` splice
   * point src/reply/render.ts fills in. Null for categories with no
   * arrival schedule (small — see data/seed/templates.md).
   */
  shippingLine: string | null;
  /** Dropped entirely when composing with `--direct` — see data/seed/templates.md. */
  evaluationClause: string;
  /** Appended after the product-resources section, before closing, only with `--discord`. */
  discordBlock: string;
  closing: string;
}

export interface ReplyVariant {
  /** `--direct`: not a Mercari Shops order, so no shop evaluation to request. */
  direct: boolean;
  /** `--discord`: include Discord server guidance (email orders only — see data/seed/source-skill.md). */
  discord: boolean;
}

/** Returns the fixed-clause set for a category + flag combination. */
export function getTemplateSet(category: RefCategory, variant: ReplyVariant): ReplyTemplateSet {
  throw new Error("not implemented: getTemplateSet");
}
