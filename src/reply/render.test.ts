/**
 * Unit tests for the deterministic renderer, on hand-built references.
 * The corpus-wide goldens live under tests/reply/ (the frozen bootstrap
 * fixture may only be read from there); these cover the shapes the
 * corpus does not happen to contain, and the failure modes issue #7
 * exists to prevent.
 */
import { describe, expect, it } from "vitest";
import type { ProductRef, RefSection } from "../refs/model";
import { renderDeterministicReply, renderReply, renderResourceSectionDeterministic } from "./render";
import {
  assertValidArrivalSchedule,
  DISCORD_BLOCK,
  formatArrivalSchedule,
  getTemplateSet,
  ReplyRenderError,
  templateKindFor,
} from "./templates";

const ARRIVAL = "明後日月曜（8/18）到着予定になります。";
const DEFAULT_FLAGS = { direct: false, discord: false };

function section(overrides: Partial<RefSection> & { heading: string }): RefSection {
  return { gate: "always", resources: [], literalBlocks: [], ...overrides };
}

function productRef(overrides: Partial<ProductRef> = {}): ProductRef {
  return {
    slug: "test-module",
    displayName: "Test: Module",
    category: "general",
    aliases: [],
    sections: [],
    ...overrides,
  };
}

describe("formatArrivalSchedule", () => {
  it("wraps the operator's answer as a complete sentence carrying the date", () => {
    expect(formatArrivalSchedule({ dayLabel: "明後日月曜", month: 8, day: 18 })).toBe(ARRIVAL);
    expect(formatArrivalSchedule({ dayLabel: "明日土曜", month: 12, day: 6 })).toBe(
      "明日土曜（12/6）到着予定になります。",
    );
  });

  it("trims the day label but keeps everything else verbatim", () => {
    expect(formatArrivalSchedule({ dayLabel: "  来週火曜  ", month: 1, day: 2 })).toBe(
      "来週火曜（1/2）到着予定になります。",
    );
  });

  it.each([
    ["an empty day label", { dayLabel: "   ", month: 8, day: 18 }],
    ["month 0", { dayLabel: "明日", month: 0, day: 18 }],
    ["month 13", { dayLabel: "明日", month: 13, day: 1 }],
    ["day 32", { dayLabel: "明日", month: 8, day: 32 }],
    ["a fractional day", { dayLabel: "明日", month: 8, day: 1.5 }],
  ])("rejects %s", (_name, parts) => {
    expect(() => formatArrivalSchedule(parts)).toThrow(ReplyRenderError);
  });
});

describe("assertValidArrivalSchedule", () => {
  it("accepts the canonical sentence, in either paren width", () => {
    expect(() => assertValidArrivalSchedule(ARRIVAL)).not.toThrow();
    expect(() => assertValidArrivalSchedule("明後日月曜(8/18)到着予定になります。")).not.toThrow();
  });

  it("rejects a raw answer that would be inlined into broken Japanese", () => {
    // "…発送させていただきました。明後日月曜お受け取りいただけたら、…"
    expect(() => assertValidArrivalSchedule("明後日月曜")).toThrow(/complete sentence/);
    expect(() => assertValidArrivalSchedule("明後日月曜（8/18）")).toThrow(/complete sentence/);
  });

  it("rejects a sentence that dropped the M/D date", () => {
    expect(() => assertValidArrivalSchedule("明後日月曜到着予定になります。")).toThrow(/M\/D date/);
  });
});

describe("templateKindFor", () => {
  it("maps a category and the purchased half to a template", () => {
    expect(templateKindFor("general", "built")).toBe("general");
    expect(templateKindFor("general-diy", "built")).toBe("general");
    expect(templateKindFor("general-diy", "kit")).toBe("diy");
    expect(templateKindFor("small", "built")).toBe("small");
  });

  it("defaults to the built half, and ignores it where there is no kit", () => {
    expect(templateKindFor("general")).toBe("general");
    expect(templateKindFor("general-diy")).toBe("general");
    expect(templateKindFor("general", "kit")).toBe("general");
    expect(templateKindFor("small", "kit")).toBe("small");
  });
});

describe("the arrival schedule argument", () => {
  const ref = productRef();

  it("is required by general and diy", () => {
    expect(() =>
      renderReply({
        ref,
        templates: getTemplateSet("general", DEFAULT_FLAGS),
        arrivalSchedule: null,
        resourceSection: "",
      }),
    ).toThrow(/requires an arrival schedule/);
  });

  it("is rejected by small, which has no arrival sentence", () => {
    expect(() =>
      renderReply({
        ref: productRef({ category: "small" }),
        templates: getTemplateSet("small", DEFAULT_FLAGS),
        arrivalSchedule: ARRIVAL,
        resourceSection: "",
      }),
    ).toThrow(/no arrival sentence/);
  });

  it("is validated before it reaches the message", () => {
    expect(() =>
      renderReply({
        ref,
        templates: getTemplateSet("general", DEFAULT_FLAGS),
        arrivalSchedule: "明後日月曜",
        resourceSection: "",
      }),
    ).toThrow(ReplyRenderError);
  });
});

describe("the diy build-guide paragraph", () => {
  const kit = (sections: RefSection[]): string =>
    renderDeterministicReply({
      ref: productRef({ category: "general-diy", displayName: "AI: Kit", sections }),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL,
      purchased: "kit",
    });

  it("names the product and is followed by the build guide's links", () => {
    const rendered = kit([
      section({
        heading: "Build Guide",
        gate: "diy-only",
        resources: [{ title: "Official Build Guide", url: "https://example.com/build" }],
      }),
    ]);

    expect(rendered).toContain(
      "AI: Kitについて、こちらのDIYキットは、以下に写真入りのステップバイステップビルドガイドが用意されておりまして、こちらを参照しつつお作りいただければと存じます。\n\nOfficial Build Guide:\nhttps://example.com/build",
    );
  });

  it("is dropped whole when the reference has no build guide, rather than promising one", () => {
    const rendered = kit([
      section({
        heading: "Manual",
        resources: [{ title: "Manual", url: "https://example.com/manual" }],
      }),
    ]);

    expect(rendered).not.toContain("ステップバイステップビルドガイド");
    expect(rendered).not.toContain("AI: Kit");
    expect(rendered).toContain("https://example.com/manual");
    // The DIY-beginner guides still ship — the customer bought a kit.
    expect(rendered).toContain("https://takazudomodular.com/guides/col001-diy-kits/");
  });

  it("takes the build guide out of the resources section, not just out of order", () => {
    const sections = [
      section({ heading: "Build Guide", gate: "diy-only", resources: [{ title: "BG", url: "https://example.com/bg" }] }),
    ];

    expect(renderResourceSectionDeterministic(productRef({ sections }), { diy: true })).toBe("");
    expect(kit(sections).match(/https:\/\/example\.com\/bg/g)).toHaveLength(1);
  });
});

describe("gated sections", () => {
  const sections = [
    section({ heading: "Manual", resources: [{ title: "M", url: "https://example.com/m" }] }),
    section({
      heading: "Videos",
      gate: "diy-only",
      resources: [{ title: "Assembly", url: "https://example.com/assembly" }],
    }),
  ];
  const ref = productRef({ category: "general-diy", sections });

  it("ship only with the kit", () => {
    const built = renderDeterministicReply({ ref, flags: DEFAULT_FLAGS, arrivalSchedule: ARRIVAL });
    const kit = renderDeterministicReply({
      ref,
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL,
      purchased: "kit",
    });

    expect(built).not.toContain("https://example.com/assembly");
    expect(built).toContain("https://example.com/m");
    expect(kit).toContain("https://example.com/assembly");
  });
});

describe("a rendered section", () => {
  it("puts the intro above the links and breaks every line before the URL", () => {
    const rendered = renderResourceSectionDeterministic(
      productRef({
        sections: [
          section({
            heading: "Manual",
            introText: "マニュアルを用意しております。",
            resources: [
              { title: "Manual A", url: "https://example.com/a" },
              { title: "Manual B", url: "https://example.com/b" },
            ],
          }),
        ],
      }),
    );

    expect(rendered).toBe(
      "マニュアルを用意しております。\n\nManual A:\nhttps://example.com/a\nManual B:\nhttps://example.com/b",
    );
  });

  it("is preceded by a === rule when it carries a separator intro", () => {
    const rendered = renderResourceSectionDeterministic(
      productRef({
        sections: [
          section({
            heading: "Extra Resources",
            separatorIntro: "その他のリソースです。",
            resources: [{ title: "Old guide", url: "https://example.com/old" }],
          }),
        ],
      }),
    );

    expect(rendered).toBe("===\n\nその他のリソースです。\n\nOld guide:\nhttps://example.com/old");
  });

  it("never emits its heading or its editorial prose", () => {
    const rendered = renderResourceSectionDeterministic(
      productRef({
        sections: [
          section({
            heading: "Notes",
            prose: "Hand-built by Takazudo Modular. Add a note asking the customer to contact.",
          }),
          section({ heading: "Manual", resources: [{ title: "M", url: "https://example.com/m" }] }),
        ],
      }),
    );

    expect(rendered).toBe("M:\nhttps://example.com/m");
  });
});

describe("literal blocks", () => {
  const notice = (rule: { kind: "always" } | { kind: "variant-match"; needles: string[] }) =>
    productRef({
      sections: [
        section({
          heading: "Notice",
          literalBlocks: [{ text: "注意事項です。", rule, ruleProse: "rule" }],
        }),
      ],
    });

  it("always-blocks ship with no variant named", () => {
    expect(renderResourceSectionDeterministic(notice({ kind: "always" }))).toBe("注意事項です。");
  });

  it("variant-match blocks ship only when the named variant matches, case-insensitively", () => {
    const ref = notice({ kind: "variant-match", needles: ["Lite"] });

    expect(renderResourceSectionDeterministic(ref, { variantText: "zudo-rail lite 60 set1" })).toBe(
      "注意事項です。",
    );
    expect(renderResourceSectionDeterministic(ref, { variantText: "zudo-rail nuts 84" })).toBe("");
    expect(renderResourceSectionDeterministic(ref)).toBe("");
  });

  it("ship on any one of several needles", () => {
    const ref = notice({ kind: "variant-match", needles: ["Lite", "Nuts"] });

    expect(renderResourceSectionDeterministic(ref, { variantText: "NUTS 84" })).toBe("注意事項です。");
  });
});

describe("the assembled message", () => {
  const ref = productRef({
    displayName: "Test: Module",
    sections: [section({ heading: "Manual", resources: [{ title: "M", url: "https://example.com/m" }] })],
  });

  it("collapses the resources slot away when there is nothing to say", () => {
    const rendered = renderDeterministicReply({
      ref: productRef(),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL,
    });

    expect(rendered).toBe(
      `ご購入ありがとうございます。\nこちら、本日ヤマトで発送させていただきました。${ARRIVAL}お受け取りいただけたら、特にコメント無しでも良いのでショップの評価を頂けると嬉しいです。\n\n不明点等ございましたらお気軽にコメント等頂ければと存じます。\nよろしくお願いいたします！`,
    );
  });

  it("puts the Discord block between the resources and the closing", () => {
    const rendered = renderDeterministicReply({
      ref,
      flags: { direct: false, discord: true },
      arrivalSchedule: ARRIVAL,
    });

    expect(rendered).toContain(`https://example.com/m\n\n${DISCORD_BLOCK}\n\n不明点等ございましたら`);
  });

  it("never contains an unfilled slot", () => {
    for (const discord of [false, true]) {
      for (const direct of [false, true]) {
        const rendered = renderDeterministicReply({ ref, flags: { direct, discord }, arrivalSchedule: ARRIVAL });
        expect(rendered).not.toMatch(/\{[a-z_]+\}/);
      }
    }
  });

  /**
   * `$&` and `$'` are replacement patterns to String.replace; a title, a
   * URL or a display name carrying one would be silently rewritten if the
   * slots were filled with a string replacement instead of a function.
   */
  it("treats $-sequences in reference data as literal text", () => {
    const rendered = renderDeterministicReply({
      ref: productRef({
        category: "general-diy",
        displayName: "Kit $& $` $'",
        sections: [
          section({
            heading: "Build Guide",
            gate: "diy-only",
            resources: [{ title: "Guide $&", url: "https://example.com/$'" }],
          }),
        ],
      }),
      flags: DEFAULT_FLAGS,
      arrivalSchedule: ARRIVAL,
      purchased: "kit",
    });

    expect(rendered).toContain("Kit $& $` $'について");
    expect(rendered).toContain("Guide $&:\nhttps://example.com/$'");
  });

  it("is a pure function of its arguments", () => {
    const once = renderDeterministicReply({ ref, flags: DEFAULT_FLAGS, arrivalSchedule: ARRIVAL });
    const twice = renderDeterministicReply({ ref, flags: DEFAULT_FLAGS, arrivalSchedule: ARRIVAL });

    expect(once).toBe(twice);
  });
});
