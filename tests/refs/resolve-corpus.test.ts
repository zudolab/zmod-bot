/**
 * Exercises the resolver (src/refs/resolve.ts) against the full 34-file
 * seed corpus loaded into a real Miniflare D1 binding — the acceptance
 * criteria in issue #8 are stated over "the seeded corpus", and this is
 * the only tier that can seed product_ref_aliases through the real
 * product_refs/product_ref_aliases join (createMockD1 evaluates no SQL —
 * see src/db/test-support.ts).
 *
 * Lives under tests/ rather than next to the resolver because nothing
 * under src/** may reach into data/seed — see
 * tests/seed-corpus-isolation.test.ts and data/seed/README.md. Mirrors
 * the loading pattern in tests/refs/corpus.test.ts (issue #4), but with
 * its own glob/parse — that file is owned by #4 and not imported here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REF_CATEGORY_LABELS, type ProductRef } from "../../src/refs/model";
import { parseProductRefMarkdown } from "../../src/refs/parse";
import { upsertProductRef, type RepoDeps } from "../../src/db/repos";
import type { ProductCategory } from "../../src/db/schema";
import { literalBlockMatches, normalizeAlias, resolveProductRef, type ResolveResult } from "../../src/refs/resolve";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

const sources = new Map(
  Object.entries(
    import.meta.glob("../../data/seed/products/*.md", { query: "?raw", import: "default", eager: true }),
  ).map(([path, markdown]): [string, string] => [path.replace(/^.*\/(.+)\.md$/, "$1"), markdown]),
);

const refs: ProductRef[] = [...sources.entries()]
  .map(([slug, markdown]) => parseProductRefMarkdown({ slug, markdown }))
  .sort((a, b) => a.slug.localeCompare(b.slug));

function ref(slug: string): ProductRef {
  const found = refs.find((r) => r.slug === slug);
  if (found === undefined) throw new Error(`no such corpus file: ${slug}.md`);
  return found;
}

function expectMatch(result: ResolveResult, slug: string): asserts result is Extract<ResolveResult, { kind: "match" }> {
  if (result.kind !== "match") {
    throw new Error(`expected a match for ${slug}, got ${JSON.stringify(result)}`);
  }
  expect(result.slug).toBe(slug);
}

/**
 * "Resolves" per issue #8's acceptance criteria means the product's
 * identity was found — not that a general-diy match also came with a
 * decided variant. A general-diy product's own slug, display name and
 * product-url carry no built/kit signal (e.g. "ai-lpg" itself doesn't
 * say diy or built), so resolving those correctly lands on
 * variant-ambiguous, not match — and that is still the right slug, not
 * a miss or a cross-product mix-up.
 */
function expectResolvedTo(
  result: ResolveResult,
  slug: string,
): asserts result is Extract<ResolveResult, { kind: "match" | "variant-ambiguous" }> {
  if (result.kind !== "match" && result.kind !== "variant-ambiguous") {
    throw new Error(`expected ${slug} to resolve, got ${JSON.stringify(result)}`);
  }
  expect(result.slug).toBe(slug);
}

describe("resolveProductRef over the seeded corpus", () => {
  let env: TestEnvHandle;
  let deps: RepoDeps;

  beforeAll(async () => {
    expect(refs).toHaveLength(34);

    env = await createTestEnv();
    deps = { db: env.db, now: () => new Date("2026-08-17T00:00:00Z") };

    for (const productRef of refs) {
      await upsertProductRef(deps, {
        slug: productRef.slug,
        category: REF_CATEGORY_LABELS[productRef.category] as ProductCategory,
        productUrl: productRef.productUrl ?? null,
        bodyMd: sources.get(productRef.slug)!,
        // Same aliases: string as the corpus header — normalized the same
        // way seed/write time would (issue #8). Deduped because several
        // corpus entries list both a dash-form and a space-form of the
        // same name (e.g. "zudo-block-40" / "zudo block 40"), which
        // normalize to the same alias_norm — product_ref_aliases.alias_norm
        // is a PRIMARY KEY and upsertProductRef's alias insert carries no
        // ON CONFLICT clause, so an un-deduped list would throw here.
        aliases: [...new Set(productRef.aliases.map(normalizeAlias))],
        changedByUserId: "seed",
        source: "seed",
      });
    }
  });

  afterAll(async () => {
    await env.dispose();
  });

  /**
   * ai-smatrix and oam-vca-expander are excluded here and covered by the
   * two dedicated tests below instead: their own H1 display names
   * genuinely, unavoidably embed a *different* product's registered
   * alias as a real, word-boundary-respecting substring —
   * "AI018 Stereo Matrix Mixer" contains ai-matrix's alias "Matrix
   * Mixer"; "Olivia Artz Modular: VCA Expander for Time Machine"
   * contains oam-time-machine's alias "Time Machine". Given issue #8's
   * containment rule is plain bidirectional substring containment (no
   * word-boundary or length-ratio weighting), resolving the full H1 for
   * these two correctly lands on `ambiguous` — a real corpus-level
   * naming coincidence, not a resolver bug. Every *other* way of
   * referring to them (catalog slug, product-url, their own shorter
   * aliases) is unambiguous — see the dedicated tests.
   */
  const displayNameCollisions = new Set(["ai-smatrix", "oam-vca-expander"]);

  it.each(refs.map((r) => r.slug).filter((slug) => !displayNameCollisions.has(slug)))(
    "resolves %s from its own display name",
    async (slug) => {
      const result = await resolveProductRef(deps, ref(slug).displayName);
      expectResolvedTo(result, slug);
    },
  );

  it("ai-smatrix's own display name collides with ai-matrix's 'Matrix Mixer' alias — ambiguous, both candidates present", async () => {
    const result = await resolveProductRef(deps, ref("ai-smatrix").displayName);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates.map((c) => c.slug).sort()).toEqual(["ai-matrix", "ai-smatrix"]);
  });

  it("oam-vca-expander's own display name collides with oam-time-machine's 'Time Machine' alias — ambiguous, both candidates present", async () => {
    const result = await resolveProductRef(deps, ref("oam-vca-expander").displayName);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates.map((c) => c.slug).sort()).toEqual(["oam-time-machine", "oam-vca-expander"]);
  });

  it.each(refs.map((r) => r.slug))("resolves %s from its own catalog slug", async (slug) => {
    const result = await resolveProductRef(deps, slug);
    expectResolvedTo(result, slug);
  });

  it.each(refs.map((r) => r.slug))("resolves %s from its own product-url", async (slug) => {
    const productUrl = ref(slug).productUrl;
    if (productUrl === undefined) throw new Error(`${slug}.md has no product-url`);
    const result = await resolveProductRef(deps, productUrl);
    expectResolvedTo(result, slug);
  });

  it("resolves the Japanese alias ズドレール to zudo-rail", async () => {
    const result = await resolveProductRef(deps, "ズドレール");
    expectMatch(result, "zudo-rail");
  });

  it("resolves full-width ＯＸＩ　ＯＮＥ to oxi-one, not oxi-one-mk2", async () => {
    const result = await resolveProductRef(deps, "ＯＸＩ　ＯＮＥ");
    expectMatch(result, "oxi-one");
  });

  it("resolves ai-lpg-diy-black to the kit variant", async () => {
    const result = await resolveProductRef(deps, "ai-lpg-diy-black");
    expectMatch(result, "ai-lpg");
    expect(result.variant).toBe("kit");
  });

  it("resolves ai-lpg-built-alumi to the built variant", async () => {
    const result = await resolveProductRef(deps, "ai-lpg-built-alumi");
    expectMatch(result, "ai-lpg");
    expect(result.variant).toBe("built");
  });

  it("returns variant-ambiguous for a bare AI017", async () => {
    const result = await resolveProductRef(deps, "AI017");
    expect(result).toMatchObject({ kind: "variant-ambiguous", slug: "ai-lpg" });
  });

  it("a deliberately ambiguous input ('meta') returns ambiguous with candidates, never a pick", async () => {
    const result = await resolveProductRef(deps, "meta");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.candidates.map((c) => c.slug).sort()).toEqual(["metamodule", "oxi-meta"]);
  });

  it("returns a miss for a no-match input", async () => {
    const result = await resolveProductRef(deps, "totally unknown eurorack module 9999");
    expect(result).toEqual({ kind: "miss" });
  });

  describe("zudo-rail's Lite literal-block needle", () => {
    const liteBlock = ref("zudo-rail")
      .sections.flatMap((section) => section.literalBlocks)
      .find((block) => block.rule.kind === "variant-match");

    it("has a variant-match rule to test against", () => {
      expect(liteBlock).toBeDefined();
      expect(liteBlock?.rule).toMatchObject({ kind: "variant-match", needles: ["Lite"] });
    });

    it("matches 'zudo-rail lite 60 set1'", () => {
      expect(literalBlockMatches(liteBlock!.rule, "zudo-rail lite 60 set1")).toBe(true);
    });

    it("does not match 'zudo-rail nuts'", () => {
      expect(literalBlockMatches(liteBlock!.rule, "zudo-rail nuts")).toBe(false);
    });
  });
});
