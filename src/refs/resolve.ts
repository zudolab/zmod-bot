/**
 * Resolves free text (a product name, alias, or takazudomodular.com
 * product URL, as typed in an app_mention) against the known product
 * references — slug, product-url and aliases all participate, per
 * data/seed/README.md's reference format. Implementation, including
 * variant detection (e.g. "OXI ONE" vs "OXI ONE MKII" vs "zudo-rail lite
 * 60 set1"), is issue #8's responsibility.
 */
import type { ProductRef } from "./model";

export type RefResolution =
  | { kind: "exact"; ref: ProductRef }
  | { kind: "ambiguous"; candidates: ProductRef[] }
  | { kind: "not_found"; query: string };

export interface ResolveRefsInput {
  query: string;
  refs: ProductRef[];
}

export function resolveProductRef(input: ResolveRefsInput): RefResolution {
  throw new Error("not implemented: resolveProductRef");
}

/** Extracts a product slug from a takazudomodular.com product URL, or null if the URL doesn't match that shape. */
export function extractSlugFromProductUrl(url: string): string | null {
  throw new Error("not implemented: extractSlugFromProductUrl");
}
