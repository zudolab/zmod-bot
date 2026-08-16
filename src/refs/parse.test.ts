import { describe, expect, it } from "vitest";
import { assertValidProductRef, RefParseError, type ProductRef } from "./model";
import { parseProductRefMarkdown, serializeProductRefMarkdown } from "./parse";

const FENCE = "```";

/** Minimal well-formed document; each test perturbs one construct. */
function doc(body: string): string {
  return ["# Test Product", "", "- category: general", "", body, ""].join("\n");
}

function parse(markdown: string, slug = "test-product"): ProductRef {
  return parseProductRefMarkdown({ slug, markdown });
}

function parseError(markdown: string, slug = "test-product"): RefParseError {
  try {
    parse(markdown, slug);
  } catch (error) {
    if (error instanceof RefParseError) return error;
    throw error;
  }
  throw new Error("expected parseProductRefMarkdown to throw a RefParseError");
}

describe("header block", () => {
  it("reads the H1, category, product-url and aliases", () => {
    const ref = parse(
      [
        "# ADDAC System: ADDAC304 Manual Gates",
        "",
        "- category: general (built) / diy (kit)",
        "- product-url: https://takazudomodular.com/products/addac304-manual-gates-intro/",
        "- aliases: ADDAC304, ADDAC 304, Manual Gates",
        "",
        "## Notes",
        "",
        "Body.",
        "",
      ].join("\n"),
      "addac304",
    );

    expect(ref).toEqual({
      slug: "addac304",
      displayName: "ADDAC System: ADDAC304 Manual Gates",
      category: "general-diy",
      productUrl: "https://takazudomodular.com/products/addac304-manual-gates-intro/",
      aliases: ["ADDAC304", "ADDAC 304", "Manual Gates"],
      sections: [
        { heading: "Notes", gate: "always", resources: [], literalBlocks: [], prose: "Body." },
      ],
    });
  });

  it("treats product-url and aliases as optional", () => {
    const ref = parse(doc("## Notes\n\nBody."));

    expect(ref.productUrl).toBeUndefined();
    expect(ref.aliases).toEqual([]);
  });

  it("rejects a file that does not start with an H1", () => {
    const error = parseError("- category: general\n\n## Notes\n\nBody.\n");

    expect(error.message).toContain("expected the file to start with an H1");
    expect(error.line).toBe(1);
  });

  it("rejects an unknown header key", () => {
    const error = parseError("# Test Product\n\n- category: general\n- categry: small\n\n## Notes\n\nBody.\n");

    expect(error.message).toContain('unknown header key "categry"');
    expect(error.heading).toBeNull();
    expect(error.line).toBe(4);
  });

  it("rejects a duplicate header key", () => {
    const error = parseError("# Test Product\n\n- category: general\n- category: small\n\n## Notes\n\nx\n");

    expect(error.message).toContain("duplicate header key");
    expect(error.line).toBe(4);
  });

  it("rejects prose in the header block", () => {
    const error = parseError("# Test Product\n\ncategory: general\n\n## Notes\n\nx\n");

    expect(error.message).toContain("`- key: value` bullets");
  });

  it("rejects a category the corpus does not use, including a bare `diy`", () => {
    for (const value of ["diy", "general (built)", "kit"]) {
      const error = parseError(`# Test Product\n\n- category: ${value}\n\n## Notes\n\nx\n`);
      expect(error.message).toContain("unknown category");
    }
  });

  it("rejects a missing category", () => {
    const error = parseError("# Test Product\n\n- aliases: a, b\n\n## Notes\n\nx\n");

    expect(error.message).toContain("missing required header key `category`");
    expect(error.file).toBe("test-product.md");
  });
});

describe("sections", () => {
  it("names the file, the heading and the line in every parse error", () => {
    const error = parseError(doc(["## Videos (diy only)", "", "- Broken line: not-a-url https://x.test/a", ""].join("\n")));

    expect(error).toBeInstanceOf(RefParseError);
    expect(error.file).toBe("test-product.md");
    expect(error.heading).toBe("Videos (diy only)");
    expect(error.line).toBe(7);
    expect(error.lineText).toBe("- Broken line: not-a-url https://x.test/a");
    expect(error.message).toContain("test-product.md:7");
    expect(error.message).toContain('(section "Videos (diy only)")');
  });

  it("uses the caller-supplied file name when given one", () => {
    // The seed importer passes the real path so its failures point at a
    // file on disk rather than a bare slug.
    try {
      parseProductRefMarkdown({ slug: "x", markdown: "nope", file: "corpus/products/x.md" });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RefParseError).file).toBe("corpus/products/x.md");
    }
  });

  it("strips a `(diy only…)` gate suffix and gates the section", () => {
    const ref = parse(doc(["## Videos (diy only, reference)", "", "- Build video: https://x.test/v", ""].join("\n")));

    expect(ref.sections[0]).toEqual({
      heading: "Videos",
      gate: "diy-only",
      resources: [{ title: "Build video", url: "https://x.test/v" }],
      literalBlocks: [],
    });
  });

  it("keeps a parenthetical that is not a gate", () => {
    const ref = parse(doc("## Usage Guide (取り付け方法)\n\nBody.\n"));

    expect(ref.sections[0]!.heading).toBe("Usage Guide (取り付け方法)");
    expect(ref.sections[0]!.gate).toBe("always");
  });

  it("rejects a suffix that is nearly a gate rather than mis-gating the section", () => {
    for (const suffix of ["(diy)", "(diy kit)", "(built only)"]) {
      const error = parseError(doc(`## Build Guide ${suffix}\n\nBody.\n`));
      expect(error.message).toMatch(/ambiguous DIY heading suffix|unrecognized gate suffix/);
    }
  });

  it("rejects an unsupported heading depth", () => {
    const error = parseError(doc("### Notes\n\nBody.\n"));

    expect(error.message).toContain("unsupported heading depth");
  });
});

describe("resource lines", () => {
  it("splits at the URL, not at the first colon", () => {
    const ref = parse(doc("## Manual\n\n- Vendor: Product Manual 日本語訳付き: https://x.test/m\n"));

    expect(ref.sections[0]!.resources).toEqual([
      { title: "Vendor: Product Manual 日本語訳付き", url: "https://x.test/m" },
    ]);
  });

  it("rejects a URL-bearing bullet that is not `title: url`", () => {
    expect(parseError(doc("## Manual\n\n- : https://x.test/m\n")).message).toContain("no title before its URL");
    for (const bullet of ["- https://x.test/m", "- Title: https://x.test/m extra"]) {
      expect(parseError(doc(`## Manual\n\n${bullet}\n`)).message).toContain("the URL as the last token");
    }
  });

  it("accepts any list marker, so a `*` resource is not demoted to prose", () => {
    const ref = parse(doc("## Manual\n\n* Title: https://x.test/m\n+ Other: https://x.test/o\n"));

    expect(ref.sections[0]!.resources).toEqual([
      { title: "Title", url: "https://x.test/m" },
      { title: "Other", url: "https://x.test/o" },
    ]);
  });

  it("keeps a bullet with no URL as prose", () => {
    const ref = parse(doc("## Notes\n\n- Ships with an HDMI cable.\n- Connect it to the sequencer.\n"));

    expect(ref.sections[0]!.resources).toEqual([]);
    expect(ref.sections[0]!.prose).toBe("- Ships with an HDMI cable.\n- Connect it to the sequencer.");
  });
});

describe("labelled directives", () => {
  it("reads `Intro text:` and `Separator intro:`", () => {
    const ref = parse(
      doc(
        [
          "## Extra Resources",
          "",
          "Separator intro: その他のリソースです。",
          "",
          "- Guide: https://x.test/g",
          "",
          "Intro text: ご参考にしてください。",
        ].join("\n"),
      ),
    );

    expect(ref.sections[0]!.separatorIntro).toBe("その他のリソースです。");
    expect(ref.sections[0]!.introText).toBe("ご参考にしてください。");
    expect(ref.sections[0]!.prose).toBeUndefined();
  });

  it("gates a section on `Intro text (diy only):` alone", () => {
    const ref = parse(doc("## Videos\n\n- Build video: https://x.test/v\n\nIntro text (diy only): 組み立て動画です。\n"));

    expect(ref.sections[0]!.gate).toBe("diy-only");
    expect(ref.sections[0]!.introText).toBe("組み立て動画です。");
  });

  it("rejects a mis-capitalised directive instead of demoting it to prose", () => {
    const error = parseError(doc("## Manual\n\n- M: https://x.test/m\n\nintro text: ご参考に。\n"));

    expect(error.message).toContain("mis-capitalised");
    expect(error.line).toBe(9);
  });

  it("rejects an unknown directive qualifier", () => {
    expect(parseError(doc("## Manual\n\nIntro text (built only): x\n")).message).toContain(
      "unrecognized qualifier",
    );
    expect(parseError(doc("## Manual\n\nSeparator intro (diy only): x\n")).message).toContain(
      "it takes no qualifier",
    );
  });

  it("reads the same `(diy only…)` spelling on a directive as on a heading", () => {
    const ref = parse(doc("## Videos\n\n- V: https://x.test/v\n\nIntro text (diy only, reference): 参考です。\n"));

    expect(ref.sections[0]!.gate).toBe("diy-only");
    expect(ref.sections[0]!.introText).toBe("参考です。");
  });

  it("rejects a duplicate directive rather than letting one overwrite the other", () => {
    const error = parseError(doc("## Manual\n\nIntro text: one\n\nIntro text: two\n"));

    expect(error.message).toContain("duplicate `Intro text` directive");
  });

  it("leaves a label it does not know as prose", () => {
    const ref = parse(doc("## Notes\n\nSuggested Japanese line: こちらでお使いいただけます。\n"));

    expect(ref.sections[0]!.prose).toBe("Suggested Japanese line: こちらでお使いいただけます。");
    expect(ref.sections[0]!.introText).toBeUndefined();
  });
});

describe("literal blocks", () => {
  const block = (rulePose: string): string =>
    ["## Fragility Notice", "", rulePose, "", FENCE, "注意書きです。", FENCE].join("\n");

  it("reads an unconditional rule from the prose above the fence", () => {
    const ref = parse(doc(block("ALWAYS append the following notice for any zudo-rail purchase.")));

    expect(ref.sections[0]!.literalBlocks).toEqual([
      {
        text: "注意書きです。",
        rule: { kind: "always" },
        ruleProse: "ALWAYS append the following notice for any zudo-rail purchase.",
      },
    ]);
    expect(ref.sections[0]!.prose).toBeUndefined();
  });

  it("reads a variant-conditional rule, taking the bolded words as needles", () => {
    const ref = parse(doc(block('When the purchased product is a **Lite** or **Nuts** variant (e.g. "rail lite 60"), append this.')));

    expect(ref.sections[0]!.literalBlocks[0]!.rule).toEqual({
      kind: "variant-match",
      needles: ["Lite", "Nuts"],
    });
  });

  it("rejects prose that reads as both unconditional and variant-conditional", () => {
    const error = parseError(doc(block("When the product is a **Lite** variant, append this for any purchase.")));

    expect(error.message).toContain("ambiguous literal-block include rule");
  });

  it("rejects a variant-conditional rule that names no variant", () => {
    const error = parseError(doc(block("When the purchased product is a Lite variant, append this.")));

    expect(error.message).toContain("names no variant");
  });

  it("rejects prose that states no rule at all", () => {
    const error = parseError(doc(block("This notice is about the rails.")));

    expect(error.message).toContain("cannot determine when to include this literal block");
  });

  it("rejects a fenced block with no prose above it", () => {
    const error = parseError(doc(["## Fragility Notice", "", FENCE, "注意書きです。", FENCE].join("\n")));

    expect(error.message).toContain("no prose above it");
    expect(error.heading).toBe("Fragility Notice");
    expect(error.line).toBe(7);
  });

  it("rejects an unterminated fenced block", () => {
    const error = parseError(doc(["## Fragility Notice", "", "Append this for any purchase.", "", FENCE, "注意書きです。"].join("\n")));

    expect(error.message).toContain("unterminated fenced block");
  });

  it("keeps the block text verbatim, blank lines and all", () => {
    const ref = parse(
      doc(["## Notice", "", "Append this for any purchase.", "", FENCE, "一行目", "", "三行目", FENCE].join("\n")),
    );

    expect(ref.sections[0]!.literalBlocks[0]!.text).toBe("一行目\n\n三行目");
  });
});

describe("serializeProductRefMarkdown", () => {
  it("round-trips a document carrying every construct at once", () => {
    const markdown = doc(
      [
        "## Notes",
        "",
        "Editorial note.",
        "",
        "- A plain bullet with no link.",
        "",
        "## Manual (diy only)",
        "",
        "- Vendor: Manual: https://x.test/m",
        "",
        "Intro text: ご参考ください。",
        "",
        "## Extra Resources",
        "",
        "Separator intro: その他です。",
        "",
        "- Guide: https://x.test/g",
        "",
        "## Notice",
        "",
        "When the product is a **Lite** variant, append this.",
        "",
        FENCE,
        "注意書き",
        FENCE,
      ].join("\n"),
    );
    const ref = parse(markdown);

    expect(parse(serializeProductRefMarkdown(ref))).toEqual(ref);
  });

  it("re-emits the category in its source spelling", () => {
    const ref = parse("# X\n\n- category: general (built) / diy (kit)\n\n## Notes\n\nx\n", "x");

    expect(serializeProductRefMarkdown(ref)).toContain("- category: general (built) / diy (kit)");
  });
});

describe("assertValidProductRef", () => {
  const valid = (): ProductRef => parse(doc("## Manual\n\n- T: https://x.test/m\n"));

  it("accepts what the parser produces", () => {
    expect(() => assertValidProductRef(valid())).not.toThrow();
  });

  it("rejects a resource URL that is not absolute", () => {
    const ref = valid();
    ref.sections[0]!.resources[0]!.url = "/manuals/x";

    expect(() => assertValidProductRef(ref)).toThrow(RefParseError);
  });

  it("rejects a variant-match block with no needles", () => {
    const ref = valid();
    ref.sections[0]!.literalBlocks.push({
      text: "x",
      rule: { kind: "variant-match", needles: [] },
      ruleProse: "When it is a **Lite** variant.",
    });

    expect(() => assertValidProductRef(ref)).toThrow(/no variant needles/);
  });

  it("names the offending section in its error", () => {
    const ref = valid();
    ref.sections[0]!.resources[0]!.title = "  ";

    const error = (() => {
      try {
        assertValidProductRef(ref);
      } catch (thrown) {
        return thrown as RefParseError;
      }
      throw new Error("expected a throw");
    })();

    expect(error.heading).toBe("Manual");
    expect(error.line).toBeNull();
  });
});
