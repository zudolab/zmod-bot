/**
 * Parses the frozen bootstrap corpus (data/seed/products/*.md) end to end.
 *
 * These tests live under tests/ rather than next to the parser because
 * nothing under src/** may reach into data/seed — see
 * tests/seed-corpus-isolation.test.ts and data/seed/README.md.
 */
import { describe, expect, it } from "vitest";
import { REF_CATEGORY_LABELS, type ProductRef, type RefCategory } from "../../src/refs/model";
import { parseProductRefMarkdown, serializeProductRefMarkdown } from "../../src/refs/parse";

const FENCE = "```";

const sources = new Map(
  Object.entries(
    import.meta.glob("../../data/seed/products/*.md", { query: "?raw", import: "default", eager: true }),
  )
    .map(([path, markdown]): [string, string] => [path.replace(/^.*\/(.+)\.md$/, "$1"), markdown])
    .sort(([a], [b]) => a.localeCompare(b)),
);

const slugs = [...sources.keys()];
const refs = new Map<string, ProductRef>(
  slugs.map((slug) => [slug, parseProductRefMarkdown({ slug, markdown: sources.get(slug)! })]),
);

const ref = (slug: string): ProductRef => {
  const found = refs.get(slug);
  if (found === undefined) throw new Error(`no such corpus file: ${slug}.md`);
  return found;
};

const sectionByHeading = (slug: string, heading: string) =>
  ref(slug).sections.filter((section) => section.heading === heading);

describe("the seed corpus", () => {
  it("is the expected 34 files and every one parses", () => {
    expect(slugs).toHaveLength(34);
    expect(refs.size).toBe(34);
  });

  it.each(slugs)("%s parses to a stable ProductRef", (slug) => {
    expect(ref(slug)).toMatchSnapshot();
  });

  it("has the expected category distribution", () => {
    const counts: Record<RefCategory, number> = { general: 0, "general-diy": 0, small: 0 };
    for (const parsed of refs.values()) counts[parsed.category] += 1;

    expect(counts).toEqual({ general: 22, "general-diy": 7, small: 5 });
  });

  it("maps `general (built) / diy (kit)` to general-diy and mints no bare `diy` category", () => {
    expect(ref("addac304").category).toBe("general-diy");
    expect(Object.keys(REF_CATEGORY_LABELS)).toEqual(["general", "general-diy", "small"]);
    expect([...refs.values()].map((parsed) => parsed.category)).not.toContain("diy");
  });

  /**
   * Ground truth for "resource line" is a section bullet of the form
   * `- {title}: {url}`; the count below is that, counted independently
   * from the source files by the assertion itself.
   *
   * Issue #4 states 123. No metric over the frozen corpus produces 123 —
   * the near misses are 125 (resource lines plus the 34 `- product-url:`
   * header bullets) and 131 (every URL anywhere, prose links included).
   * The parser's count is asserted here instead of the issue's number.
   */
  it("yields 91 resource lines, matching the source bullets", () => {
    const parsed = [...refs.values()].reduce(
      (total, one) => total + one.sections.reduce((n, section) => n + section.resources.length, 0),
      0,
    );

    let fromSource = 0;
    for (const markdown of sources.values()) {
      let inHeader = true;
      for (const line of markdown.split("\n")) {
        if (line.startsWith("## ")) inHeader = false;
        if (!inHeader && /^-\s+.*:\s*https?:\/\/\S+$/.test(line.trim())) fromSource += 1;
      }
    }

    expect(parsed).toBe(fromSource);
    expect(parsed).toBe(91);
  });

  it("keeps aliases verbatim, without normalizing slugs, display names or Japanese", () => {
    expect(ref("zudo-rail").aliases).toEqual(["zudo rail", "ズドレール"]);
    expect(ref("oxi-one").aliases).toEqual([
      "OXI ONE",
      "OXI ONE (not MK2)",
      "OXI ONE original",
      "oxi-one",
      "oxi-one-intro",
    ]);
  });

  it("keeps a non-gate heading parenthetical as part of the heading", () => {
    const headings = ref("zudo-3u-to-1u").sections.map((section) => section.heading);
    expect(headings).toContain("Usage Guide (取り付け方法)");
    expect(ref("addac107").sections.map((section) => section.heading)).toContain("Notes (additional)");
  });

  it("round-trips every file through serialize -> parse without losing anything", () => {
    for (const slug of slugs) {
      const original = ref(slug);
      const reparsed = parseProductRefMarkdown({
        slug,
        markdown: serializeProductRefMarkdown(original),
      });
      expect(reparsed, `${slug}.md did not survive a serialize/parse round trip`).toEqual(original);
    }
  });

  /**
   * The load-bearing guarantee: an unrecognized construct must never be
   * dropped. Every non-blank source line has to turn up somewhere in the
   * parsed model — if a future edit adds a construct the parser skips,
   * this fails rather than a customer message quietly losing a notice.
   */
  it("accounts for every non-blank line of every file", () => {
    let checked = 0;

    for (const slug of slugs) {
      const parsed = ref(slug);
      const haystack = [
        parsed.displayName,
        REF_CATEGORY_LABELS[parsed.category],
        parsed.productUrl ?? "",
        parsed.aliases.join(", "),
        ...parsed.sections.flatMap((section) => [
          section.heading,
          section.introText ?? "",
          section.separatorIntro ?? "",
          section.prose ?? "",
          ...section.resources.flatMap((resource) => [resource.title, resource.url]),
          ...section.literalBlocks.flatMap((block) => [block.ruleProse, block.text]),
        ]),
      ].join("\n");

      let inFence = false;
      const lines = sources.get(slug)!.split("\n");
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith(FENCE)) {
          inFence = !inFence;
          continue;
        }
        if (trimmed === "") continue;

        const where = `${slug}.md:${index + 1}`;
        for (const payload of inFence ? [line] : payloadsOf(trimmed)) {
          expect(haystack, `${where} was dropped: ${JSON.stringify(payload)}`).toContain(payload);
        }
        checked += 1;
      }
    }

    // Every non-blank, non-fence line of the frozen corpus. Exact, so a
    // loop that silently stopped checking would fail here too.
    expect(checked).toBe(421);
  });
});

/** The content a source line contributes to the model, with its markup stripped. */
function payloadsOf(trimmed: string): string[] {
  const heading = /^##\s+(.*)$/.exec(trimmed);
  if (heading !== null) return [heading[1]!.replace(/\s*\(diy only[^)]*\)$/i, "").trim()];

  const title = /^#\s+(.*)$/.exec(trimmed);
  if (title !== null) return [title[1]!.trim()];

  const header = /^-\s+(?:category|product-url|aliases):\s*(.*)$/.exec(trimmed);
  if (header !== null) return [header[1]!.trim()];

  const resource = /^-\s+(.*?):\s*(https?:\/\/\S+)$/.exec(trimmed);
  if (resource !== null) return [resource[1]!.trim(), resource[2]!];

  const directive = /^(?:Intro text(?:\s*\(diy only\))?|Separator intro):\s*(.*)$/.exec(trimmed);
  if (directive !== null) return [directive[1]!.trim()];

  return [trimmed];
}

describe("zudo-rail.md literal blocks", () => {
  it("yields one variant-match block on Lite and one unconditional block", () => {
    const blocks = ref("zudo-rail").sections.flatMap((section) => section.literalBlocks);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.rule).toEqual({ kind: "variant-match", needles: ["Lite"] });
    expect(blocks[1]!.rule).toEqual({ kind: "always" });
  });

  it("keeps each block's text verbatim, including its interior blank lines", () => {
    const [renewal, fragility] = ref("zudo-rail").sections.flatMap((section) => section.literalBlocks);

    expect(renewal!.text).toContain("\n\nzudo-rail\nhttps://takazudomodular.com/products/zudo-rail-intro/\n\n");
    expect(renewal!.text.startsWith("それとこちらの商品の一部である")).toBe(true);
    expect(renewal!.text.endsWith("ご容赦願えればと存じます。")).toBe(true);
    expect(fragility!.text).toBe(
      "なお、こちらのレールは構造上やや折れやすい部分がございまして、組み立てや取り付けの際は無理な力をかけないよう、お気を付け頂けますと幸いです。",
    );
  });

  it("attaches each block to the section whose prose states its rule", () => {
    const sections = ref("zudo-rail").sections;

    expect(sections.map((section) => section.heading)).toEqual([
      "Assembly Guide",
      "Lite Version Renewal Notice (ALWAYS include for Lite variants)",
      "Fragility Notice (ALWAYS include — Lite and Nuts variants)",
    ]);
    expect(sections[1]!.literalBlocks[0]!.ruleProse).toContain("When the purchased product is a **Lite** variant");
    expect(sections[2]!.literalBlocks[0]!.ruleProse).toContain("for any zudo-rail purchase");
  });
});

describe("ai-lpg.md gating", () => {
  it("gates the Build Guide and the reference Videos section to DIY only", () => {
    expect(sectionByHeading("ai-lpg", "Build Guide").map((section) => section.gate)).toEqual(["diy-only"]);

    const videos = sectionByHeading("ai-lpg", "Videos");
    expect(videos.map((section) => section.gate)).toEqual(["always", "diy-only"]);
    // `(diy only, reference)` — the gate suffix is stripped whole, so both
    // Videos sections share one heading.
    expect(videos[1]!.introText).toContain("AI Synthesis公式の組み立て動画に加え");
  });

  it("leaves Manual, Guides and the first Videos section ungated", () => {
    for (const heading of ["Notes", "Manual", "Guides"]) {
      expect(sectionByHeading("ai-lpg", heading).map((section) => section.gate)).toEqual(["always"]);
    }
    expect(sectionByHeading("ai-lpg", "Videos")[0]!.resources).toEqual([
      { title: "AI Synthesis公式 AI017 デモ動画", url: "https://youtu.be/HW1LWf5xoIA" },
    ]);
  });

  it("gates a section on `Intro text (diy only):` even without a heading suffix", () => {
    // addac304's `## Manual (diy only)` gates from the heading; ai-lpg's
    // second Videos section gates from both. The directive alone is only
    // exercised by the unit tests, so assert the corpus shape it mirrors.
    const gated = sectionByHeading("ai-lpg", "Videos")[1]!;
    expect(gated.gate).toBe("diy-only");
    expect(gated.introText).toBeDefined();
  });
});

describe("free-form section bodies", () => {
  it("keeps a bullet list that carries no URL as prose, in document order", () => {
    const notes = sectionByHeading("oxi-pipe-mk2", "Notes")[0]!;

    expect(notes.resources).toEqual([]);
    expect(notes.prose).toBe(
      [
        "The customer already knows exactly what this product is — do NOT include any intro/explanation or the intro-article link. Just include this note:",
        "",
        "- This module comes with an HDMI cable included.",
        "- Connect it to OXI ONE MKII with this cable.",
        "",
        "Suggested Japanese line: OXI Pipe MKIIにはHDMIケーブルが付属しておりますので、こちらでOXI ONE MKIIと接続してお使いいただけます。",
      ].join("\n"),
    );
  });

  it("reads `Separator intro:` that precedes its links", () => {
    const extra = sectionByHeading("oam-vca-expander", "Extra Resources")[0]!;

    expect(extra.separatorIntro).toContain("ファームウェアv1.1.1以上が必要です");
    expect(extra.introText).toBeUndefined();
    expect(extra.resources).toHaveLength(1);
  });

  it("splits a multi-colon resource title at the URL, not the first colon", () => {
    expect(sectionByHeading("oxi-one", "Extra Resources")[0]!.resources[1]).toEqual({
      title: "ZudoTV vol.3: Oxi ONE解説 その1: monoモードでモジュラー鳴らしつつ基本みたいな部分ざっと",
      url: "https://youtu.be/LChzegsDhjs?si=4GHXgve0XpVZaOzU",
    });
  });

  it("keeps a section that is nothing but prose", () => {
    const notes = sectionByHeading("x0x-heart", "Notes")[0]!;

    expect(notes.resources).toEqual([]);
    expect(notes.literalBlocks).toEqual([]);
    expect(notes.prose).toBe(
      "Hand-built by Takazudo Modular. Add a note asking the customer to contact if anything seems wrong.",
    );
  });
});
