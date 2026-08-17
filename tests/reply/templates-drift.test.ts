/**
 * data/seed/templates.md is the canonical wording of every fixed clause.
 * These tests read it and compare, so src/reply/templates.ts cannot drift
 * from it silently — a re-punctuated particle here reaches a paying
 * customer verbatim.
 *
 * Lives under tests/ rather than beside the module because nothing under
 * src/** may reach into data/seed (tests/seed-corpus-isolation.test.ts,
 * data/seed/README.md).
 */
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_SENTENCE_ENDING,
  DISCORD_BLOCK,
  DIY_BUILD_GUIDE_INTRO,
  EVALUATION_CLAUSE,
  getTemplateSet,
  GREETING_LINE,
  NEKOPOS_SHIPPING_LINES,
  YAMATO_SHIPPING_LINE,
  type ReplyTemplateKind,
} from "../../src/reply/templates";

const templatesMd = Object.values(
  import.meta.glob("../../data/seed/templates.md", { query: "?raw", import: "default", eager: true }),
)[0]!;

/** The fenced blocks of templates.md, in document order, without their trailing newline. */
const blocks = [...templatesMd.matchAll(/^```\n([\s\S]*?)^```$/gm)].map((match) =>
  match[1]!.replace(/\n$/, ""),
);

const [GENERAL_BLOCK, GENERAL_DIRECT_SHIPPING, DIY_BLOCK, SMALL_BLOCK, SMALL_DIRECT_BLOCK, DISCORD] =
  blocks;

/**
 * Removes whole-paragraph `{slot}` lines from either side of a
 * comparison, so the only difference tolerated between our skeleton and
 * the file's block is which slots exist — every character of fixed
 * Japanese still has to match.
 */
const stripSlots = (text: string): string => text.replace(/\n\n\{[a-z_]+\}(?=\n\n)/g, "");

const skeletonOf = (kind: ReplyTemplateKind, direct = false): string =>
  getTemplateSet(kind, { direct, discord: false }).skeleton;

describe("data/seed/templates.md", () => {
  it("still holds the six fenced blocks these tests read", () => {
    expect(blocks).toHaveLength(6);
    expect(GENERAL_BLOCK).toContain("ヤマト");
    expect(SMALL_BLOCK).toContain("ネコポス");
    expect(DISCORD).toContain("Discord");
  });

  it.each([
    ["GREETING_LINE", GREETING_LINE],
    ["YAMATO_SHIPPING_LINE", YAMATO_SHIPPING_LINE],
    ["NEKOPOS_SHIPPING_LINES", NEKOPOS_SHIPPING_LINES],
    ["EVALUATION_CLAUSE", EVALUATION_CLAUSE],
    ["ARRIVAL_SENTENCE_ENDING", ARRIVAL_SENTENCE_ENDING],
    ["DIY_BUILD_GUIDE_INTRO", DIY_BUILD_GUIDE_INTRO],
  ])("spells %s exactly as src/reply/templates.ts does", (_name, clause) => {
    expect(templatesMd).toContain(clause);
  });
});

describe("the skeletons", () => {
  it("reproduce the general block character for character", () => {
    expect(stripSlots(skeletonOf("general"))).toBe(stripSlots(GENERAL_BLOCK!));
  });

  it("reproduce the diy block character for character", () => {
    expect(stripSlots(skeletonOf("diy"))).toBe(stripSlots(DIY_BLOCK!));
  });

  it("reproduce the small block character for character", () => {
    expect(stripSlots(skeletonOf("small"))).toBe(stripSlots(SMALL_BLOCK!));
  });

  it("reproduce the Discord block character for character", () => {
    expect(DISCORD_BLOCK).toBe(DISCORD);
  });
});

describe("--direct", () => {
  /**
   * templates.md states the `--direct` result only for small (a whole
   * block) and for the general shipping line (a fragment); diy is
   * "same as general". Deriving all three by dropping EVALUATION_CLAUSE
   * is therefore only correct if the derivation reproduces the two
   * spellings the file does give — which is what these two assert.
   */
  it("leaves the general shipping line ending at the arrival schedule", () => {
    expect(skeletonOf("general", true)).toContain(`\n${GENERAL_DIRECT_SHIPPING}\n\n`);
  });

  it("reproduces the small block character for character", () => {
    expect(stripSlots(skeletonOf("small", true))).toBe(stripSlots(SMALL_DIRECT_BLOCK!));
  });

  it.each(["general", "diy", "small"] as const)("drops the evaluation clause from %s", (kind) => {
    expect(skeletonOf(kind, true)).not.toContain(EVALUATION_CLAUSE);
    expect(skeletonOf(kind, true)).not.toContain("評価");
    expect(skeletonOf(kind)).toContain(EVALUATION_CLAUSE);
  });

  it("keeps よろしくお願いいたします！ in the small template", () => {
    expect(skeletonOf("small", true)).toContain("よろしくお願いいたします！");
  });
});

describe("--discord", () => {
  it.each(["general", "diy", "small"] as const)("is off by default for %s", (kind) => {
    expect(skeletonOf(kind)).not.toContain("Discord");
  });

  it.each(["general", "diy", "small"] as const)(
    "puts the block after the resources and before the closing for %s",
    (kind) => {
      const skeleton = getTemplateSet(kind, { direct: false, discord: true }).skeleton;
      const closing = "よろしくお願いいたします！";

      expect(skeleton).toContain(DISCORD_BLOCK);
      expect(skeleton.indexOf("{product_resources}")).toBeLessThan(skeleton.indexOf(DISCORD_BLOCK));
      expect(skeleton.indexOf(DISCORD_BLOCK)).toBeLessThan(skeleton.lastIndexOf(closing));
      expect(skeleton).toContain(`\n\n${DISCORD_BLOCK}\n\n`);
    },
  );
});
