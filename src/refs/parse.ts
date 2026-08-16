/**
 * Parses/serializes the product reference markdown format documented at
 * data/seed/README.md and data/seed/source-skill.md. Implementation is
 * issue #4's responsibility (alongside src/refs/model.ts).
 */
import type { ProductRef } from "./model";

export interface ParseProductRefInput {
  /** Filename without extension, used as the slug — see data/seed/README.md. */
  slug: string;
  markdown: string;
}

/** Parses a product reference markdown document into the domain model. Throws on malformed input. */
export function parseProductRefMarkdown(input: ParseProductRefInput): ProductRef {
  throw new Error("not implemented: parseProductRefMarkdown");
}

/**
 * The inverse of parseProductRefMarkdown — used when persisting an
 * LLM-authored or Slack-edited ref back to the stored markdown body
 * (ProductRefRow.body) for versioning.
 */
export function serializeProductRefMarkdown(ref: ProductRef): string {
  throw new Error("not implemented: serializeProductRefMarkdown");
}
