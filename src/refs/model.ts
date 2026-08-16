/**
 * The ProductRef domain model — the parsed shape of a product reference
 * file, per the format documented at data/seed/README.md and
 * data/seed/source-skill.md ("Product Reference File Format"). This is
 * what src/db/repos.ts's ProductRefRow.body deserializes into, and what
 * src/reply/render.ts and src/refs/resolve.ts operate on.
 *
 * Implementation (parsing/validating an actual reference) is issue #4's
 * responsibility.
 */

export type ProductCategory = "general" | "diy" | "small";

export interface ProductResourceLink {
  title: string;
  url: string;
}

export interface ProductRefSection {
  /**
   * Free-form heading text, e.g. "Manual", "Guides", "Build Guide (diy
   * only)", "Lite Version Renewal Notice (ALWAYS include for Lite
   * variants)" — headings are prose, not an enum (epic issue #1: "17
   * distinct observed").
   */
  heading: string;
  /** The "Intro text:" / "Intro text (diy only):" / "Separator intro:" prose shown above the link list, if any. */
  intro: string | null;
  links: ProductResourceLink[];
  /**
   * A fenced block of literal message text to include verbatim instead of
   * (or alongside) links — e.g. zudo-rail.md's fragility notice. Include
   * rules for these are themselves prose in the section body (e.g.
   * "ALWAYS append"), not modeled as structured conditions here.
   */
  literalBlock: string | null;
}

export interface ProductRef {
  /** Filename without extension — see data/seed/README.md. */
  slug: string;
  name: string;
  category: ProductCategory;
  productUrl: string;
  aliases: string[];
  sections: ProductRefSection[];
  version: number;
}

/** Validates a parsed ProductRef against the format rules in data/seed/README.md before it is persisted. */
export function assertValidProductRef(ref: ProductRef): void {
  throw new Error("not implemented: assertValidProductRef");
}
