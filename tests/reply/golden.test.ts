/**
 * The golden corpus: every reference in data/seed/products rendered
 * across every applicable variant and flag combination, snapshotted. This
 * is the oracle later sub-tasks compare against, so the snapshots are
 * committed and a diff in them is the finding, not noise.
 *
 * **These tests read data/seed, never D1.** The seed corpus is frozen;
 * D1 is not — `ref new` / `ref refresh` write LLM-authored bodies at
 * runtime, so a golden suite pointed at the database would start failing
 * on *data* rather than on a regression, long after the change that
 * caused it. tests/reply/renderer-contract.test.ts enforces that
 * structurally, by reading this file's own source.
 */
import { describe, expect, it } from "vitest";
import type { ProductRef } from "../../src/refs/model";
import { parseProductRefMarkdown } from "../../src/refs/parse";
import { renderDeterministicReply } from "../../src/reply/render";
import {
  formatArrivalSchedule,
  type PurchasedVariant,
  type ReplyFlags,
} from "../../src/reply/templates";

const sources = new Map(
  Object.entries(
    import.meta.glob("../../data/seed/products/*.md", { query: "?raw", import: "default", eager: true }),
  )
    .map(([path, markdown]): [string, string] => [path.replace(/^.*\/(.+)\.md$/, "$1"), markdown])
    .sort(([a], [b]) => a.localeCompare(b)),
);

const refs = new Map<string, ProductRef>(
  [...sources].map(([slug, markdown]) => [slug, parseProductRefMarkdown({ slug, markdown })]),
);

const ref = (slug: string): ProductRef => {
  const found = refs.get(slug);
  if (found === undefined) throw new Error(`no such corpus file: ${slug}.md`);
  return found;
};

/**
 * A fixed date, passed in: the renderer takes the arrival schedule as an
 * argument rather than reading a clock, so the goldens are a function of
 * the frozen corpus alone and never of the day the suite runs.
 */
const ARRIVAL = formatArrivalSchedule({ dayLabel: "明後日月曜", month: 8, day: 18 });

const FLAG_COMBOS: [string, ReplyFlags][] = [
  ["default", { direct: false, discord: false }],
  ["--discord", { direct: false, discord: true }],
  ["--direct", { direct: true, discord: false }],
  ["--discord --direct", { direct: true, discord: true }],
];

interface GoldenCase {
  name: string;
  slug: string;
  purchased: PurchasedVariant;
  flags: ReplyFlags;
  variantText?: string;
}

const cases: GoldenCase[] = [...refs.entries()].flatMap(([slug, parsed]) => {
  const purchases: PurchasedVariant[] =
    parsed.category === "general-diy" ? ["built", "kit"] : ["built"];

  return purchases.flatMap((purchased) =>
    FLAG_COMBOS.map(([flagName, flags]): GoldenCase => ({
      name: `${slug} · ${purchased} · ${flagName}`,
      slug,
      purchased,
      flags,
    })),
  );
});

/** zudo-rail's two `variant-match` notices only ship when the variant is named. */
const variantCases: GoldenCase[] = (["zudo-rail lite 60 set1", "zudo-rail nuts 84"] as const).flatMap(
  (variantText) =>
    FLAG_COMBOS.map(([flagName, flags]): GoldenCase => ({
      name: `zudo-rail · ${variantText} · ${flagName}`,
      slug: "zudo-rail",
      purchased: "built",
      flags,
      variantText,
    })),
);

const render = (one: GoldenCase): string => {
  const parsed = ref(one.slug);
  return renderDeterministicReply({
    ref: parsed,
    flags: one.flags,
    arrivalSchedule: parsed.category === "small" ? null : ARRIVAL,
    purchased: one.purchased,
    ...(one.variantText === undefined ? {} : { variantText: one.variantText }),
  });
};

describe("the golden matrix", () => {
  it("covers all 34 references across every applicable variant and flag combination", () => {
    expect(refs.size).toBe(34);
    // 22 general + 5 small, one variant each, plus 7 general-diy at two
    // variants, times the four flag combinations.
    expect(cases).toHaveLength((22 + 5 + 7 * 2) * 4);
    expect(cases).toHaveLength(164);
    expect(new Set(cases.map((one) => one.name)).size).toBe(cases.length);
  });

  it.each(cases.map((one): [string, GoldenCase] => [one.name, one]))("%s", (_name, one) => {
    expect(render(one)).toMatchSnapshot();
  });

  it.each(variantCases.map((one): [string, GoldenCase] => [one.name, one]))("%s", (_name, one) => {
    expect(render(one)).toMatchSnapshot();
  });
});

describe("every rendered reply", () => {
  it("is a pure function of its input — rendering twice gives identical bytes", () => {
    for (const one of [...cases, ...variantCases]) {
      expect(render(one)).toBe(render(one));
    }
  });

  it("puts every URL alone on its own line", () => {
    for (const one of [...cases, ...variantCases]) {
      for (const line of render(one).split("\n")) {
        if (!line.includes("http")) continue;
        expect(line, `${one.name}: URL shares a line with other text`).toMatch(/^https?:\/\/\S+$/);
      }
    }
  });

  it("emits every applicable resource URL of the reference", () => {
    for (const one of cases) {
      const parsed = ref(one.slug);
      const lines = render(one).split("\n");

      for (const section of parsed.sections) {
        if (section.gate === "diy-only" && one.purchased !== "kit") continue;
        for (const resource of section.resources) {
          expect(lines, `${one.name}: dropped ${resource.url}`).toContain(resource.url);
          expect(lines, `${one.name}: dropped ${resource.title}`).toContain(`${resource.title}:`);
        }
      }
    }
  });

  it("never leaks a section heading or an editorial prose note", () => {
    for (const one of [...cases, ...variantCases]) {
      const rendered = render(one);
      const parsed = ref(one.slug);

      for (const section of parsed.sections) {
        expect(rendered, `${one.name}: leaked the "${section.heading}" heading`).not.toContain(
          `## ${section.heading}`,
        );
        if (section.prose !== undefined) {
          expect(rendered, `${one.name}: leaked editorial prose`).not.toContain(section.prose);
        }
      }
    }
  });
});

describe("--direct", () => {
  /**
   * 評価 occurs zero times across data/seed/products — verified before
   * this assertion was written (issue #7, "Absence-assertion discipline"),
   * so the only route it can reach a rendered reply by is the evaluation
   * clause `--direct` is supposed to drop. It cannot be tripped by a
   * fixture.
   */
  it("leaves neither 評価 nor the evaluation sentence anywhere in the reply", () => {
    const directCases = [...cases, ...variantCases].filter((one) => one.flags.direct);
    expect(directCases.length).toBeGreaterThan(0);

    for (const one of directCases) {
      const rendered = render(one);
      expect(rendered, one.name).not.toContain("評価");
      expect(rendered, one.name).not.toContain("お受け取りいただけたら");
    }
  });

  it("keeps the evaluation sentence in every default reply", () => {
    for (const one of cases.filter((c) => !c.flags.direct)) {
      expect(render(one), one.name).toContain(
        "お受け取りいただけたら、特にコメント無しでも良いのでショップの評価を頂けると嬉しいです。",
      );
    }
  });
});

describe("small (Nekopos)", () => {
  const smallCases = [...cases, ...variantCases].filter((one) => ref(one.slug).category === "small");

  it("covers the five small references", () => {
    expect(new Set(smallCases.map((one) => one.slug)).size).toBe(5);
  });

  /**
   * 到着予定 likewise occurs zero times across data/seed/products — it
   * lives only in templates.md — so this can only fail on the defect it
   * was written for.
   */
  it("carries no arrival sentence at all", () => {
    for (const one of smallCases) {
      const rendered = render(one);
      expect(rendered, one.name).not.toContain("到着予定");
      expect(rendered, one.name).not.toContain("ヤマト");
      expect(rendered, one.name).toContain("ネコポス配送のため、郵便受けへの投函となるかもしれません。");
    }
  });

  it("gets no DIY-beginner guides, even when the product needs assembling", () => {
    // zb40-intro and zudo-block-60-open are screwdriver kits: their Build
    // Guide renders inline, but soldering guides would be wrong.
    for (const slug of ["zb40-intro", "zudo-block-60-open"]) {
      const rendered = render({
        name: slug,
        slug,
        purchased: "built",
        flags: { direct: false, discord: false },
      });

      expect(rendered).toContain("https://takazudomodular.com/guides/how-to-build-zudo-block");
      expect(rendered).not.toContain("col001-diy-kits");
      expect(rendered).not.toContain("col002-diy-tools");
    }
  });
});

describe("zudo-rail's variant notices", () => {
  const RENEWAL = "この商品を直近でリニューアルしまして";
  const FRAGILITY =
    "なお、こちらのレールは構造上やや折れやすい部分がございまして、組み立てや取り付けの際は無理な力をかけないよう、お気を付け頂けますと幸いです。";

  const renderVariant = (variantText: string | undefined): string =>
    renderDeterministicReply({
      ref: ref("zudo-rail"),
      flags: { direct: false, discord: false },
      arrivalSchedule: null,
      ...(variantText === undefined ? {} : { variantText }),
    });

  it("ships both notices for a Lite variant", () => {
    const rendered = renderVariant("zudo-rail lite 60 set1");

    expect(rendered).toContain(RENEWAL);
    expect(rendered).toContain(FRAGILITY);
  });

  it("ships only the fragility notice for a Nuts variant", () => {
    const rendered = renderVariant("zudo-rail nuts 84");

    expect(rendered).not.toContain(RENEWAL);
    expect(rendered).toContain(FRAGILITY);
  });

  it("ships only the unconditional notice when no variant is named", () => {
    const rendered = renderVariant(undefined);

    expect(rendered).not.toContain(RENEWAL);
    expect(rendered).toContain(FRAGILITY);
  });
});
