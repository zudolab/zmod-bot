/**
 * Resolves free text (a product name, alias, or takazudomodular.com
 * product URL, as typed in an app_mention) against the known product
 * references stored in D1 — src/db/repos.ts is the only way this module
 * touches product data; nothing here reads data/seed (CLAUDE.md
 * "Non-negotiables": D1 is the runtime store for product references).
 *
 * Resolution never guesses: an ambiguous match returns every candidate
 * so the caller can render a Slack select instead of picking one, and a
 * general-diy match whose built/kit variant cannot be determined returns
 * `variant-ambiguous` rather than defaulting — shipping a built-product
 * reply for a kit purchase (or vice versa) sends the customer the wrong
 * links.
 */
import { findProductRefByAlias, listProductRefAliases, listProductRefs, type RepoDeps } from "../db/repos";
import type { ProductRefRow } from "../db/schema";
import { REF_CATEGORY_LABELS, type RefLiteralRule } from "./model";

const GENERAL_DIY_CATEGORY = REF_CATEGORY_LABELS["general-diy"];

/** A leading Slack mention token: `<@U0123ABC>` or `<@U0123ABC|label>`. */
const MENTION_PREFIX = /^<@u[a-z0-9]+(?:\|[^>]*)?>\s*/i;

/**
 * Separator characters removed for matching, per issue #8's normalization
 * spec — and, in addition to the four characters the spec names, all
 * whitespace. The spec's own worked example ("oxi-one-mk2", "oxi one
 * mk2" and "oxiOneMk2" all agree after normalization) only holds if
 * whitespace is dropped too, and the corpus depends on it: zudo-rail.md's
 * own slug/display name is "zudo-rail" (dash form) but its only English
 * alias is "zudo rail" (space form) — those two normalize to the same
 * string ("zudorail") only when both the dash and the space disappear.
 * Same story for zudo-block-60-open (heading has a bare space before
 * "Open" where every alias is fully dashed or fully spaced) and
 * oam-vca-expander (slug is dashed, no alias is). Verified against all
 * 34 seed files in tests/refs/resolve-corpus.test.ts.
 */
const SEPARATOR_CHARS = /[-_・/\s]/g;

/**
 * Normalizes text for alias matching: NFKC (folds full-width ASCII like
 * `ＯＸＩ` and full-width spaces to their standard form) -> lowercase ->
 * collapse whitespace runs -> strip a leading Slack mention -> drop
 * separator characters (see SEPARATOR_CHARS). Applied identically at
 * seed/write time (product_ref_aliases.alias_norm) and at lookup time,
 * so an exact match is a plain primary-key hit.
 */
export function normalizeAlias(input: string): string {
  let text = input.normalize("NFKC").toLowerCase();
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(MENTION_PREFIX, "");
  text = text.replace(SEPARATOR_CHARS, "");
  return text;
}

const URL_TOKEN = /https?:\/\/[^\s<>|]+/gi;
/** `takazudomodular.com/products/{article-slug}/` — the article slug is not the catalog slug, see resolveProductRef. */
const PRODUCT_URL_PATTERN = /^https?:\/\/(?:www\.)?takazudomodular\.com\/products\/[^/?#]+\/?$/i;

/**
 * Finds every takazudomodular.com product-page URL in free text,
 * unwrapping Slack's `<url>` / `<url|label>` autolink format (the
 * Events API delivers message text with links already bracketed this
 * way, even for a plain URL the user typed unadorned).
 */
export function extractProductUrls(text: string): string[] {
  const tokens = text.match(URL_TOKEN) ?? [];
  return tokens.filter((token) => PRODUCT_URL_PATTERN.test(token));
}

/** Equal up to scheme/www/trailing-slash/query/fragment noise, so a pasted or Slack-mangled URL still matches the stored product_url. */
function normalizeProductUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?/, "https://")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

/** Decided built vs kit for a general-diy match. There is no third "unknown" value here — see ResolveResult's separate `variant-ambiguous` kind. */
export type VariantResult = "built" | "kit";

/** One candidate slug in an ambiguous result, and the shortest stored alias that matched it (the truncation sort key). */
export interface ResolveCandidate {
  slug: string;
  aliasNorm: string;
}

export type ResolveResult =
  | { kind: "match"; slug: string; ref: ProductRefRow; variant?: VariantResult }
  | { kind: "variant-ambiguous"; slug: string; ref: ProductRefRow }
  | { kind: "ambiguous"; candidates: ResolveCandidate[]; truncated: boolean }
  | { kind: "miss" };

/** Cap on returned ambiguous candidates — issue #8: "return the top 8 by shortest-alias-length". */
const MAX_CANDIDATES = 8;

/**
 * Resolves raw app_mention text (the leading bot mention may still be
 * present — normalizeAlias strips it) to a product reference.
 *
 * Order: takazudomodular.com product URL match, exact normalized alias,
 * prefix/containment across every stored alias, miss. Never picks among
 * more than one distinct slug — see ResolveResult.
 */
export async function resolveProductRef(deps: RepoDeps, rawText: string): Promise<ResolveResult> {
  const urls = extractProductUrls(rawText);
  if (urls.length > 0) {
    const refs = await listProductRefs(deps);
    for (const url of urls) {
      const normalizedUrl = normalizeProductUrl(url);
      const hit = refs.find(
        (ref) => ref.product_url !== null && normalizeProductUrl(ref.product_url) === normalizedUrl,
      );
      if (hit) return matchResult(hit, { matchedAliasNorm: null, rawText });
    }
  }

  const candidate = normalizeAlias(rawText);
  if (candidate === "") return { kind: "miss" };

  const exact = await findProductRefByAlias(deps, candidate);
  if (exact) return matchResult(exact, { matchedAliasNorm: candidate, rawText });

  // No PK hit — scan every stored alias for a containment match. There is
  // no repo query for "all aliases across every product", so this walks
  // listProductRefs() + one listProductRefAliases() per slug; fine at the
  // corpus's scale (34 products) and it keeps repos.ts's existing surface
  // untouched.
  const refs = await listProductRefs(deps);
  const aliasLists = await Promise.all(refs.map((ref) => listProductRefAliases(deps, ref.slug)));

  const bestAliasBySlug = new Map<string, string>();
  refs.forEach((ref, index) => {
    for (const aliasNorm of aliasLists[index]!) {
      if (!candidate.includes(aliasNorm) && !aliasNorm.includes(candidate)) continue;
      const current = bestAliasBySlug.get(ref.slug);
      if (current === undefined || aliasNorm.length < current.length) {
        bestAliasBySlug.set(ref.slug, aliasNorm);
      }
    }
  });

  if (bestAliasBySlug.size === 1) {
    const [slug, aliasNorm] = [...bestAliasBySlug.entries()][0]!;
    const ref = refs.find((r) => r.slug === slug)!;
    return matchResult(ref, { matchedAliasNorm: aliasNorm, rawText });
  }
  if (bestAliasBySlug.size > 1) {
    const sorted = [...bestAliasBySlug.entries()]
      .map(([slug, aliasNorm]) => ({ slug, aliasNorm }))
      .sort((a, b) => a.aliasNorm.length - b.aliasNorm.length || a.slug.localeCompare(b.slug));
    return {
      kind: "ambiguous",
      candidates: sorted.slice(0, MAX_CANDIDATES),
      truncated: sorted.length > MAX_CANDIDATES,
    };
  }

  return { kind: "miss" };
}

function matchResult(ref: ProductRefRow, ctx: { matchedAliasNorm: string | null; rawText: string }): ResolveResult {
  if (ref.category !== GENERAL_DIY_CATEGORY) {
    return { kind: "match", slug: ref.slug, ref };
  }
  const variant = detectVariant(ctx);
  if (variant === undefined) return { kind: "variant-ambiguous", slug: ref.slug, ref };
  return { kind: "match", slug: ref.slug, ref, variant };
}

/**
 * Built vs kit for a general-diy match: the matched alias is the
 * strongest signal (corpus aliases include catalog slugs such as
 * `ai-lpg-diy-black` / `ai-lpg-built-alumi`), then a keyword in the free
 * text, else undefined — the caller must ask, never default (issue #8).
 */
function detectVariant(ctx: { matchedAliasNorm: string | null; rawText: string }): VariantResult | undefined {
  const alias = ctx.matchedAliasNorm;
  if (alias !== null) {
    if (alias.includes("diy") || alias.includes("kit")) return "kit";
    if (alias.includes("built")) return "built";
  }

  const text = ctx.rawText.normalize("NFKC").toLowerCase();
  if (text.includes("diy") || text.includes("kit") || text.includes("キット")) return "kit";
  if (text.includes("built") || text.includes("完成品")) return "built";
  return undefined;
}

/**
 * Whether a literal block ships for a given purchase: an `always` rule
 * always applies; a `variant-match` rule applies when any needle (e.g.
 * "Lite") appears in the purchase description text, matched
 * case-insensitively through the same normalizeAlias used for alias
 * matching (so "zudo-rail lite 60 set1" matches needle "Lite").
 */
export function literalBlockMatches(rule: RefLiteralRule, purchaseDescriptionText: string): boolean {
  if (rule.kind === "always") return true;
  const normalizedInput = normalizeAlias(purchaseDescriptionText);
  return rule.needles.some((needle) => normalizedInput.includes(normalizeAlias(needle)));
}
