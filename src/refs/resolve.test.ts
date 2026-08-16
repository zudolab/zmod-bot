import { describe, expect, it } from "vitest";
import { createMockD1 } from "../db/test-support";
import type { ProductRefRow } from "../db/schema";
import type { RepoDeps } from "../db/repos";
import type { RefLiteralRule } from "./model";
import {
  extractProductUrls,
  literalBlockMatches,
  normalizeAlias,
  resolveProductRef,
  type ResolveResult,
} from "./resolve";

// ---------------------------------------------------------------------
// normalizeAlias
// ---------------------------------------------------------------------

describe("normalizeAlias", () => {
  it("folds full-width ASCII and a full-width space via NFKC, then lowercases", () => {
    expect(normalizeAlias("ＯＸＩ　ＯＮＥ")).toBe("oxione");
  });

  it("collapses internal whitespace runs and trims", () => {
    expect(normalizeAlias("  OXI    ONE  ")).toBe("oxione");
  });

  it("strips a leading Slack mention with no label", () => {
    expect(normalizeAlias("<@U0123ABC> AI017")).toBe("ai017");
  });

  it("strips a leading Slack mention with a label", () => {
    expect(normalizeAlias("<@U0123ABC|zmodbot> AI017")).toBe("ai017");
  });

  it("removes dashes, underscores, nakaguro and slashes", () => {
    expect(normalizeAlias("oxi-one-mk2")).toBe("oxionemk2");
    expect(normalizeAlias("oxi_one_mk2")).toBe("oxionemk2");
    expect(normalizeAlias("オキシ・ワン")).toBe(normalizeAlias("オキシワン"));
    expect(normalizeAlias("oxi/one/mk2")).toBe("oxionemk2");
  });

  it("agrees across dash, space and camelCase spellings of the same name", () => {
    const dash = normalizeAlias("oxi-one-mk2");
    const spaced = normalizeAlias("oxi one mk2");
    const camel = normalizeAlias("oxiOneMk2");
    expect(dash).toBe(spaced);
    expect(spaced).toBe(camel);
  });

  it("is idempotent on already-normalized text", () => {
    const once = normalizeAlias("AI017 Low Pass Gate");
    expect(normalizeAlias(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------
// extractProductUrls
// ---------------------------------------------------------------------

describe("extractProductUrls", () => {
  it("finds a bare product URL", () => {
    expect(extractProductUrls("check out https://takazudomodular.com/products/oxi-one-intro/ please")).toEqual([
      "https://takazudomodular.com/products/oxi-one-intro/",
    ]);
  });

  it("unwraps Slack's <url|label> autolink format", () => {
    expect(
      extractProductUrls("<https://takazudomodular.com/products/oxi-one-intro/|OXI ONE page>"),
    ).toEqual(["https://takazudomodular.com/products/oxi-one-intro/"]);
  });

  it("unwraps Slack's bare <url> autolink format", () => {
    expect(extractProductUrls("<https://takazudomodular.com/products/oxi-one-intro/>")).toEqual([
      "https://takazudomodular.com/products/oxi-one-intro/",
    ]);
  });

  it("ignores a URL that isn't a takazudomodular.com product page", () => {
    expect(extractProductUrls("https://example.com/products/oxi-one-intro/")).toEqual([]);
    expect(extractProductUrls("https://takazudomodular.com/notes/some-post/")).toEqual([]);
  });

  it("returns an empty array when there is no URL", () => {
    expect(extractProductUrls("AI017 please")).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// literalBlockMatches
// ---------------------------------------------------------------------

describe("literalBlockMatches", () => {
  const alwaysRule: RefLiteralRule = { kind: "always" };
  const liteRule: RefLiteralRule = { kind: "variant-match", needles: ["Lite"] };

  it("an always rule applies regardless of input", () => {
    expect(literalBlockMatches(alwaysRule, "anything at all")).toBe(true);
    expect(literalBlockMatches(alwaysRule, "")).toBe(true);
  });

  it("a variant-match rule applies when its needle appears in the purchase description", () => {
    expect(literalBlockMatches(liteRule, "zudo-rail lite 60 set1")).toBe(true);
  });

  it("a variant-match rule does not apply when its needle is absent", () => {
    expect(literalBlockMatches(liteRule, "zudo-rail nuts")).toBe(false);
  });

  it("needle matching is case-insensitive", () => {
    expect(literalBlockMatches(liteRule, "ZUDO-RAIL LITE 60 SET1")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// resolveProductRef
// ---------------------------------------------------------------------

interface RefFixture {
  slug: string;
  category: ProductRefRow["category"];
  productUrl: string | null;
  /** Raw (un-normalized) alias text — normalized the same way a real seed step would. */
  aliases: string[];
}

function refRow(fixture: RefFixture): ProductRefRow {
  return {
    slug: fixture.slug,
    category: fixture.category,
    product_url: fixture.productUrl,
    body_md: `# ${fixture.slug}`,
    version: 1,
    updated_at: 0,
    updated_by: "seed",
  };
}

/**
 * A Map-backed D1 stub that answers exactly the queries src/db/repos.ts
 * issues on behalf of resolve.ts, routed by recognizable substrings of
 * the SQL text rather than exact string equality (so this stays robust
 * to repos.ts's own formatting). No SQL is evaluated — see
 * src/db/test-support.ts's rationale for the Map-stub tier.
 */
function makeDb(fixtures: RefFixture[]): RepoDeps["db"] {
  const aliasRows = fixtures.flatMap((fixture) =>
    [...new Set(fixture.aliases.map(normalizeAlias))].map((aliasNorm) => ({ aliasNorm, slug: fixture.slug })),
  );

  return createMockD1({
    onQuery: (call) => {
      const q = call.query;
      if (q.includes("JOIN")) {
        const aliasNorm = call.bindings[0] as string;
        const hit = aliasRows.find((row) => row.aliasNorm === aliasNorm);
        const fixture = hit ? fixtures.find((f) => f.slug === hit.slug) : undefined;
        return { results: fixture ? [refRow(fixture)] : [] };
      }
      if (q.includes("product_ref_aliases")) {
        const slug = call.bindings[0] as string;
        const results = aliasRows
          .filter((row) => row.slug === slug)
          .map((row) => ({ alias_norm: row.aliasNorm }))
          .sort((a, b) => a.alias_norm.localeCompare(b.alias_norm));
        return { results };
      }
      if (q.includes("ORDER BY slug")) {
        return { results: [...fixtures].sort((a, b) => a.slug.localeCompare(b.slug)).map(refRow) };
      }
      const slug = call.bindings[0] as string;
      const fixture = fixtures.find((f) => f.slug === slug);
      return { results: fixture ? [refRow(fixture)] : [] };
    },
  });
}

function makeDeps(fixtures: RefFixture[]): RepoDeps {
  return { db: makeDb(fixtures), now: () => new Date("2026-08-17T00:00:00Z") };
}

const OXI_ONE: RefFixture = {
  slug: "oxi-one",
  category: "general",
  productUrl: "https://takazudomodular.com/products/oxi-one-intro/",
  aliases: ["OXI ONE", "oxi-one"],
};

const AI_LPG: RefFixture = {
  slug: "ai-lpg",
  category: "general (built) / diy (kit)",
  productUrl: "https://takazudomodular.com/products/ai-lpg-intro/",
  aliases: ["AI017", "ai-lpg", "ai-lpg-built-alumi", "ai-lpg-built-black", "ai-lpg-diy-alumi", "ai-lpg-diy-black"],
};

const ZUDO_RAIL: RefFixture = {
  slug: "zudo-rail",
  category: "small",
  productUrl: "https://takazudomodular.com/products/zudo-rail-intro/",
  aliases: ["zudo rail", "ズドレール"],
};

function expectMatch(result: ResolveResult, slug: string): asserts result is Extract<ResolveResult, { kind: "match" }> {
  expect(result.kind).toBe("match");
  if (result.kind !== "match") throw new Error("unreachable");
  expect(result.slug).toBe(slug);
}

describe("resolveProductRef", () => {
  it("matches a takazudomodular.com product URL against the stored product_url", async () => {
    const deps = makeDeps([OXI_ONE, AI_LPG]);
    const result = await resolveProductRef(deps, "found this: https://takazudomodular.com/products/oxi-one-intro/");
    expectMatch(result, "oxi-one");
  });

  it("matches a URL wrapped in Slack's <url|label> format", async () => {
    const deps = makeDeps([OXI_ONE]);
    const result = await resolveProductRef(
      deps,
      "<https://takazudomodular.com/products/oxi-one-intro/|OXI ONE>",
    );
    expectMatch(result, "oxi-one");
  });

  it("matches a URL regardless of trailing slash and case", async () => {
    const deps = makeDeps([OXI_ONE]);
    const result = await resolveProductRef(deps, "HTTPS://TAKAZUDOMODULAR.COM/products/oxi-one-intro");
    expectMatch(result, "oxi-one");
  });

  it("matches an exact normalized alias", async () => {
    const deps = makeDeps([OXI_ONE, AI_LPG]);
    const result = await resolveProductRef(deps, "OXI ONE");
    expectMatch(result, "oxi-one");
  });

  it("matches via prefix/containment when no exact alias exists", async () => {
    const deps = makeDeps([OXI_ONE, AI_LPG]);
    const result = await resolveProductRef(deps, "please send the OXI ONE manual");
    expectMatch(result, "oxi-one");
  });

  it("strips the bot mention before resolving", async () => {
    const deps = makeDeps([OXI_ONE]);
    const result = await resolveProductRef(deps, "<@U0123ABC> OXI ONE");
    expectMatch(result, "oxi-one");
  });

  it("returns a miss when nothing matches", async () => {
    const deps = makeDeps([OXI_ONE, AI_LPG]);
    const result = await resolveProductRef(deps, "some totally unknown widget xyz123");
    expect(result).toEqual({ kind: "miss" });
  });

  it("returns a miss for empty/whitespace-only text (e.g. a bare mention)", async () => {
    const deps = makeDeps([OXI_ONE]);
    const result = await resolveProductRef(deps, "<@U0123ABC>   ");
    expect(result).toEqual({ kind: "miss" });
  });

  it("returns ambiguous with every distinct candidate slug, never a pick", async () => {
    const a: RefFixture = { slug: "widget-a", category: "general", productUrl: null, aliases: ["Super Widget"] };
    const b: RefFixture = { slug: "widget-b", category: "general", productUrl: null, aliases: ["Super Widget Pro"] };
    const deps = makeDeps([a, b]);

    const result = await resolveProductRef(deps, "widget");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates.map((c) => c.slug).sort()).toEqual(["widget-a", "widget-b"]);
    expect(result.truncated).toBe(false);
  });

  it("truncates an ambiguous result to the top 8 by shortest matching alias, flagging truncated", async () => {
    const fixtures: RefFixture[] = Array.from({ length: 9 }, (_, i) => ({
      slug: `product-${i}`,
      category: "general" as const,
      productUrl: null,
      // Every alias contains "common" but none equals it exactly, so this
      // stays a step-3 containment match (not a step-2 exact hit) for all
      // 9 — and the "x" padding gives each a distinct, increasing length
      // so "shortest wins" ordering is well-defined.
      aliases: [`common-item${"x".repeat(i)}`],
    }));
    const deps = makeDeps(fixtures);

    const result = await resolveProductRef(deps, "common");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(8);
    expect(result.truncated).toBe(true);
    // shortest matching alias ("commonitem", from product-0) sorts first
    expect(result.candidates[0]!.slug).toBe("product-0");
    expect(result.candidates.some((c) => c.slug === "product-8")).toBe(false);
  });

  it("resolves variant kit from the matched alias", async () => {
    const deps = makeDeps([AI_LPG]);
    const result = await resolveProductRef(deps, "ai-lpg-diy-black");
    expectMatch(result, "ai-lpg");
    expect(result.variant).toBe("kit");
  });

  it("resolves variant built from the matched alias", async () => {
    const deps = makeDeps([AI_LPG]);
    const result = await resolveProductRef(deps, "ai-lpg-built-alumi");
    expectMatch(result, "ai-lpg");
    expect(result.variant).toBe("built");
  });

  it("returns variant-ambiguous for a bare general-diy alias with no variant signal anywhere", async () => {
    const deps = makeDeps([AI_LPG]);
    const result = await resolveProductRef(deps, "AI017");
    expect(result).toMatchObject({ kind: "variant-ambiguous", slug: "ai-lpg" });
  });

  it("falls back to free-text keywords (English) for variant detection when the alias carries no signal", async () => {
    const deps = makeDeps([AI_LPG]);
    const kit = await resolveProductRef(deps, "AI017 diy version please");
    expectMatch(kit, "ai-lpg");
    expect(kit.variant).toBe("kit");

    const built = await resolveProductRef(deps, "AI017 built version please");
    expectMatch(built, "ai-lpg");
    expect(built.variant).toBe("built");
  });

  it("falls back to free-text keywords (Japanese) for variant detection", async () => {
    const deps = makeDeps([AI_LPG]);
    const kit = await resolveProductRef(deps, "AI017のキットください");
    expectMatch(kit, "ai-lpg");
    expect(kit.variant).toBe("kit");

    const built = await resolveProductRef(deps, "AI017の完成品ください");
    expectMatch(built, "ai-lpg");
    expect(built.variant).toBe("built");
  });

  it("does not attach a variant to a non-general-diy match", async () => {
    const deps = makeDeps([OXI_ONE]);
    const result = await resolveProductRef(deps, "OXI ONE");
    expectMatch(result, "oxi-one");
    expect(result.variant).toBeUndefined();
  });

  it("resolves the small-category zudo-rail from its Japanese alias", async () => {
    const deps = makeDeps([ZUDO_RAIL]);
    const result = await resolveProductRef(deps, "ズドレール");
    expectMatch(result, "zudo-rail");
  });

  it("resolves full-width text via NFKC folding, distinct from a longer sibling product", async () => {
    const oxiOneMk2: RefFixture = {
      slug: "oxi-one-mk2",
      category: "general",
      productUrl: "https://takazudomodular.com/products/oxi-one-mk2-intro/",
      aliases: ["OXI ONE MKII", "OXI ONE MK2", "oxi-one-mk2"],
    };
    const deps = makeDeps([OXI_ONE, oxiOneMk2]);
    const result = await resolveProductRef(deps, "ＯＸＩ　ＯＮＥ");
    expectMatch(result, "oxi-one");
  });
});
