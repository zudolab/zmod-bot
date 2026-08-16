/**
 * Parses/serializes the product reference markdown format documented at
 * data/seed/README.md and data/seed/source-skill.md.
 *
 * The corpus is hand-written prose, so the parser is a line classifier
 * with two hard rules:
 *
 * 1. **Nothing is discarded.** Every non-blank line ends up in exactly one
 *    of resources / introText / separatorIntro / literalBlocks / prose.
 *    Free prose is a first-class construct, not a bucket the renderer
 *    ignores — a line the parser cannot classify is still a line the
 *    operator wrote.
 * 2. **Anything that looks like a directive but isn't one throws.** A
 *    mis-capitalised `intro text:`, an unknown `Intro text (built only):`
 *    qualifier, an ambiguous `(diy…)` heading suffix or a fenced block
 *    whose include rule cannot be read all fail loudly with a
 *    RefParseError naming the file, heading and line. These are exactly
 *    the constructs that would otherwise be silently demoted to prose and
 *    vanish from a customer's message.
 */
import {
  assertValidProductRef,
  REF_CATEGORY_LABELS,
  RefParseError,
  type ProductRef,
  type RefCategory,
  type RefGate,
  type RefLiteralBlock,
  type RefLiteralRule,
  type RefResource,
  type RefSection,
} from "./model";

export { RefParseError } from "./model";

export interface ParseProductRefInput {
  /** Filename without extension, used as the slug — see data/seed/README.md. */
  slug: string;
  markdown: string;
  /** Name used in RefParseError messages. Defaults to `${slug}.md`. */
  file?: string;
}

const FENCE = "```";

/** A flushed prose paragraph, and where it sits in the section's paragraph list. */
type ProseParagraph = { text: string; paragraphIndex: number };

/** The only three category spellings in the corpus — see RefCategory. */
const CATEGORY_BY_LABEL = new Map<string, RefCategory>(
  (Object.entries(REF_CATEGORY_LABELS) as [RefCategory, string][]).map(([value, label]) => [
    label,
    value,
  ]),
);

const HEADER_KEYS = ["category", "product-url", "aliases"] as const;
type HeaderKey = (typeof HEADER_KEYS)[number];

/** Canonical spelling of each labelled directive, keyed by its lowercased form. */
const DIRECTIVE_LABELS = new Map<string, string>([
  ["intro text", "Intro text"],
  ["separator intro", "Separator intro"],
]);

const H1_LINE = /^#\s+(.*)$/;
const H2_LINE = /^##\s+(.*)$/;
const HEADER_BULLET = /^-\s+([^:]+):\s*(.*)$/;
/** Any CommonMark list marker, so a `* Title: url` resource is not quietly demoted to prose. */
const BULLET_LINE = /^[-*+]\s+(.*)$/;
const RESOURCE_LINE = /^(.*?):\s*(https?:\/\/\S+)$/;
const HAS_URL = /https?:\/\//;
/** `Label:` or `Label (qualifier):` at the head of a line. Latin-only by design: the label of a real directive is always ASCII. */
const DIRECTIVE_LINE = /^([A-Za-z][A-Za-z ]*?)(?:\s*\(([^)]*)\))?\s*:\s*(.*)$/;
/** A trailing parenthetical on a heading, e.g. `(diy only, reference)` or `(取り付け方法)`. */
const HEADING_SUFFIX = /^(.*?)\s*\(([^)]*)\)$/;

const BOLD_SPAN = /\*\*([^*]+)\*\*/g;
/**
 * "ALWAYS append the following notice for any zudo-rail purchase" — the
 * notice ships with every purchase of the product.
 */
const UNCONDITIONAL_RULE = /\bfor (any|all|every)\b/i;
/**
 * "When the purchased product is a **Lite** variant …" — the notice ships
 * only for the bolded variant(s).
 */
const CONDITIONAL_RULE = /\b(when|if)\b/i;

class RefDocumentParser {
  private readonly lines: string[];
  private index = 0;
  /** Heading text of the section being parsed, gate suffix included, for error messages. */
  private heading: string | null = null;

  constructor(
    private readonly file: string,
    private readonly slug: string,
    markdown: string,
  ) {
    this.lines = markdown.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  }

  parse(): ProductRef {
    this.skipBlankLines();
    const displayName = this.parseH1();
    const header = this.parseHeader();
    const sections = this.parseSections();

    const ref: ProductRef = {
      slug: this.slug,
      displayName,
      category: header.category,
      aliases: header.aliases,
      sections,
      ...(header.productUrl === undefined ? {} : { productUrl: header.productUrl }),
    };
    assertValidProductRef(ref);
    return ref;
  }

  private fail(message: string, atIndex = this.index): never {
    const lineText = this.lines[atIndex];
    throw new RefParseError({
      file: this.file,
      heading: this.heading,
      line: atIndex + 1,
      lineText: lineText === undefined ? null : lineText,
      message,
    });
  }

  private peek(): string | null {
    const line = this.lines[this.index];
    return line === undefined ? null : line;
  }

  private skipBlankLines(): void {
    while (this.index < this.lines.length && this.lines[this.index]!.trim() === "") this.index++;
  }

  private parseH1(): string {
    const line = this.peek();
    if (line === null) this.fail("file is empty — expected an H1 with the product display name");
    if (line.startsWith("##") || !H1_LINE.test(line)) {
      this.fail("expected the file to start with an H1 (`# Display Name`)");
    }
    const displayName = H1_LINE.exec(line)![1]!.trim();
    if (displayName === "") this.fail("the H1 has no display name");
    this.index++;
    return displayName;
  }

  private parseHeader(): { category: RefCategory; productUrl?: string; aliases: string[] } {
    const seen = new Map<HeaderKey, { value: string; line: number }>();

    while (this.index < this.lines.length) {
      const line = this.peek()!;
      if (line.trim() === "") {
        this.index++;
        continue;
      }
      // Any heading ends the header block; parseSections validates its depth.
      if (line.startsWith("#")) break;

      const match = HEADER_BULLET.exec(line.trim());
      if (match === null) {
        this.fail("the header block accepts only `- key: value` bullets");
      }
      const key = match[1]!.trim();
      if (!(HEADER_KEYS as readonly string[]).includes(key)) {
        this.fail(
          `unknown header key ${JSON.stringify(key)} — expected one of ${HEADER_KEYS.join(", ")}`,
        );
      }
      if (seen.has(key as HeaderKey)) {
        this.fail(`duplicate header key ${JSON.stringify(key)}`);
      }
      seen.set(key as HeaderKey, { value: match[2]!.trim(), line: this.index });
      this.index++;
    }

    const categoryEntry = seen.get("category");
    if (categoryEntry === undefined) {
      throw new RefParseError({
        file: this.file,
        message: "missing required header key `category`",
      });
    }
    const label = categoryEntry.value.replace(/\s+/g, " ");
    const category = CATEGORY_BY_LABEL.get(label);
    if (category === undefined) {
      const accepted = [...CATEGORY_BY_LABEL.keys()].map((one) => JSON.stringify(one)).join(", ");
      this.fail(
        `unknown category ${JSON.stringify(categoryEntry.value)} — expected one of ${accepted}`,
        categoryEntry.line,
      );
    }

    const productUrl = seen.get("product-url")?.value;
    const aliasesRaw = seen.get("aliases")?.value ?? "";
    const aliases = aliasesRaw
      .split(",")
      .map((alias) => alias.trim())
      .filter((alias) => alias !== "");

    return {
      category,
      aliases,
      ...(productUrl === undefined || productUrl === "" ? {} : { productUrl }),
    };
  }

  private parseSections(): RefSection[] {
    const sections: RefSection[] = [];
    while (this.index < this.lines.length) {
      const line = this.peek()!;
      if (line.trim() === "") {
        this.index++;
        continue;
      }
      if (!line.startsWith("#")) {
        // Only reachable as trailing content after the header block, since
        // section bodies consume everything up to the next heading.
        this.fail("content outside any section — expected a `## Section` heading");
      }
      if (!H2_LINE.test(line)) {
        if (line.startsWith("###")) {
          this.fail("unsupported heading depth — reference files use `#` for the title and `##` for sections");
        }
        if (!line.startsWith("##")) {
          this.fail("unexpected second level-1 heading — a reference file has exactly one H1");
        }
        this.fail("malformed section heading — expected `## Section Name`");
      }
      sections.push(this.parseSection());
    }
    return sections;
  }

  private parseSection(): RefSection {
    const headingLine = this.peek()!;
    const rawHeading = H2_LINE.exec(headingLine)![1]!.trim();
    this.heading = rawHeading === "" ? headingLine.trim() : rawHeading;
    if (rawHeading === "") this.fail("section heading is empty");
    this.index++;

    const { heading, gate: headingGate } = this.splitHeadingGate(rawHeading);

    const resources: RefResource[] = [];
    const literalBlocks: RefLiteralBlock[] = [];
    const paragraphs: string[] = [];
    let current: string[] = [];
    /**
     * The prose paragraph a fence would attach to — set when a paragraph
     * is flushed, cleared by anything else, so "the prose immediately
     * above the fence" means exactly that.
     */
    let fenceRuleSource: ProseParagraph | null = null;
    let gate = headingGate;
    let introText: string | undefined;
    let separatorIntro: string | undefined;

    /** Ends the open prose paragraph, returning it if there was one. */
    const flushParagraph = (): ProseParagraph | null => {
      if (current.length === 0) return null;
      const text = current.join("\n");
      paragraphs.push(text);
      current = [];
      return { text, paragraphIndex: paragraphs.length - 1 };
    };

    while (this.index < this.lines.length) {
      const line = this.peek()!;
      const trimmed = line.trim();

      if (trimmed === "") {
        fenceRuleSource = flushParagraph() ?? fenceRuleSource;
        this.index++;
        continue;
      }
      if (line.startsWith("#")) break;

      if (trimmed.startsWith(FENCE)) {
        const source = flushParagraph() ?? fenceRuleSource;
        const openedAt = this.index;
        const text = this.consumeFencedBlock();
        if (source === null) {
          this.fail(
            "fenced block has no prose above it stating when to include it — the include rule is read from that prose",
            openedAt,
          );
        }
        literalBlocks.push({
          text,
          rule: this.classifyLiteralRule(source.text, openedAt),
          ruleProse: source.text,
        });
        // The rule prose belongs to the block now, not to the section's
        // free prose — see RefLiteralBlock.ruleProse.
        paragraphs.splice(source.paragraphIndex, 1);
        fenceRuleSource = null;
        continue;
      }

      const bullet = BULLET_LINE.exec(trimmed);
      if (bullet !== null && HAS_URL.test(bullet[1]!)) {
        flushParagraph();
        resources.push(this.parseResourceLine(bullet[1]!.trim()));
        fenceRuleSource = null;
        this.index++;
        continue;
      }

      const directive = this.matchDirective(trimmed);
      if (directive !== null) {
        flushParagraph();
        if (directive.label === "Intro text") {
          if (introText !== undefined) this.fail("duplicate `Intro text` directive in one section");
          introText = directive.value;
          if (directive.gated) gate = "diy-only";
        } else {
          if (separatorIntro !== undefined) {
            this.fail("duplicate `Separator intro` directive in one section");
          }
          separatorIntro = directive.value;
        }
        fenceRuleSource = null;
        this.index++;
        continue;
      }

      // Everything else — including a bullet with no URL, which the corpus
      // uses for plain note lists (oxi-pipe-mk2.md) — is prose.
      current.push(trimmed);
      this.index++;
    }
    flushParagraph();

    const prose = paragraphs.join("\n\n");
    const section: RefSection = {
      heading,
      gate,
      resources,
      literalBlocks,
      ...(introText === undefined ? {} : { introText }),
      ...(separatorIntro === undefined ? {} : { separatorIntro }),
      ...(prose === "" ? {} : { prose }),
    };
    this.heading = null;
    return section;
  }

  /** Strips a `(diy only…)` gate suffix; every other parenthetical stays part of the heading. */
  private splitHeadingGate(rawHeading: string): { heading: string; gate: RefGate } {
    const match = HEADING_SUFFIX.exec(rawHeading);
    if (match === null) return { heading: rawHeading, gate: "always" };

    const head = match[1]!.trim();
    const suffix = match[2]!.trim();
    if (/^diy only\b/i.test(suffix)) {
      if (head === "") this.fail("heading is only a gate suffix");
      return { heading: head, gate: "diy-only" };
    }
    // `(diy)`, `(diy kit)`, `(built only)` — close enough to a gate that
    // treating them as ordinary heading text would silently mis-gate the
    // section.
    const gateSpelling = "the only recognized gate is `(diy only…)`";
    if (/^diy\b/i.test(suffix)) {
      this.fail(`ambiguous DIY heading suffix ${JSON.stringify(`(${suffix})`)} — ${gateSpelling}`);
    }
    if (/\bonly\b/i.test(suffix)) {
      this.fail(`unrecognized gate suffix ${JSON.stringify(`(${suffix})`)} — ${gateSpelling}`);
    }
    return { heading: rawHeading, gate: "always" };
  }

  private consumeFencedBlock(): string {
    const openedAt = this.index;
    this.index++;
    const content: string[] = [];
    while (this.index < this.lines.length) {
      const line = this.peek()!;
      if (line.trim() === FENCE) {
        this.index++;
        return content.join("\n");
      }
      content.push(line);
      this.index++;
    }
    this.fail("unterminated fenced block", openedAt);
  }

  /**
   * Reads the include rule out of the prose above a fenced block. The two
   * shapes in the corpus (zudo-rail.md) are an unconditional "for any
   * <product> purchase" and a conditional "when the purchased product is
   * a **Lite** variant". Matching both, or neither, is an error rather
   * than a guess: guessing wrong either drops a notice from every reply
   * or attaches a variant-specific one to all of them.
   */
  private classifyLiteralRule(prose: string, atIndex: number): RefLiteralRule {
    const unconditional = UNCONDITIONAL_RULE.test(prose);
    const conditional = CONDITIONAL_RULE.test(prose);
    const needles = [...new Set([...prose.matchAll(BOLD_SPAN)].map((m) => m[1]!.trim()))].filter(
      (needle) => needle !== "",
    );

    if (unconditional && conditional) {
      this.fail(
        "ambiguous literal-block include rule — the prose above the fence reads as both unconditional and variant-conditional",
        atIndex,
      );
    }
    if (unconditional) return { kind: "always" };
    if (conditional && needles.length > 0) return { kind: "variant-match", needles };
    if (conditional) {
      this.fail(
        "variant-conditional literal block names no variant — the variant must be bolded, e.g. `a **Lite** variant`",
        atIndex,
      );
    }
    this.fail(
      "cannot determine when to include this literal block — the prose above the fence must say either that it applies to any purchase or which **variant** it applies to",
      atIndex,
    );
  }

  private parseResourceLine(body: string): RefResource {
    const match = RESOURCE_LINE.exec(body);
    if (match === null) {
      this.fail("resource line must read `- {title}: {url}`, with the URL as the last token");
    }
    const title = match[1]!.replace(/:+$/, "").trim();
    if (title === "") this.fail("resource line has no title before its URL");
    return { title, url: match[2]! };
  }

  /**
   * Recognizes `Intro text:` / `Intro text (diy only):` / `Separator intro:`.
   * A line whose label matches one of those only case-insensitively, or
   * carries an unknown qualifier, throws — demoting it to prose would drop
   * the intro from the rendered message with nothing to show for it.
   */
  private matchDirective(line: string): { label: string; value: string; gated: boolean } | null {
    const match = DIRECTIVE_LINE.exec(line);
    if (match === null) return null;

    const rawLabel = match[1]!.trim().replace(/\s+/g, " ");
    const canonical = DIRECTIVE_LABELS.get(rawLabel.toLowerCase());
    if (canonical === undefined) return null;
    if (rawLabel !== canonical) {
      this.fail(
        `directive ${JSON.stringify(`${rawLabel}:`)} is mis-capitalised — expected ${JSON.stringify(`${canonical}:`)}`,
      );
    }

    const qualifier = match[2]?.trim();
    let gated = false;
    if (qualifier !== undefined) {
      // Same `(diy only…)` rule as a heading suffix — one spelling of the
      // gate everywhere it can appear.
      if (canonical === "Intro text" && /^diy only\b/i.test(qualifier)) {
        gated = true;
      } else {
        const expected =
          canonical === "Intro text"
            ? " — the only recognized qualifier is `(diy only…)`"
            : " — it takes no qualifier";
        this.fail(
          `unrecognized qualifier ${JSON.stringify(`(${qualifier})`)} on \`${canonical}:\`${expected}`,
        );
      }
    }

    const value = (match[3] ?? "").trim();
    if (value === "") this.fail(`\`${canonical}:\` has no text`);
    return { label: canonical, value, gated };
  }
}

/** Parses a product reference markdown document into the domain model. Throws on malformed input. */
export function parseProductRefMarkdown(input: ParseProductRefInput): ProductRef {
  const file = input.file ?? `${input.slug}.md`;
  return new RefDocumentParser(file, input.slug, input.markdown).parse();
}

/**
 * The inverse of parseProductRefMarkdown — used when persisting an
 * LLM-authored or Slack-edited ref back to the stored markdown body
 * (ProductRefRow.body) for versioning.
 *
 * Faithful, not byte-exact: it normalizes blank lines, the gate suffix
 * (`(diy only, reference)` becomes `(diy only)`) and the `Intro text`
 * qualifier, all of which the model does not carry. What it does
 * guarantee is a semantic round trip — `parse(serialize(ref))` deep-equals
 * `ref` for every file in data/seed/products (see parse.test.ts), so no
 * resource, notice or intro is lost by a store-and-reload cycle.
 */
export function serializeProductRefMarkdown(ref: ProductRef): string {
  const out: string[] = [`# ${ref.displayName}`, "", `- category: ${REF_CATEGORY_LABELS[ref.category]}`];
  if (ref.productUrl !== undefined) out.push(`- product-url: ${ref.productUrl}`);
  if (ref.aliases.length > 0) out.push(`- aliases: ${ref.aliases.join(", ")}`);

  for (const section of ref.sections) {
    const gated = section.gate === "diy-only";
    out.push("", `## ${section.heading}${gated ? " (diy only)" : ""}`);
    if (section.prose !== undefined) out.push("", section.prose);
    if (section.separatorIntro !== undefined) out.push("", `Separator intro: ${section.separatorIntro}`);
    if (section.resources.length > 0) {
      out.push("");
      for (const resource of section.resources) out.push(`- ${resource.title}: ${resource.url}`);
    }
    if (section.introText !== undefined) {
      out.push("", `Intro text${gated ? " (diy only)" : ""}: ${section.introText}`);
    }
    // Each block re-emits its own rule prose immediately above the fence,
    // which is where the parser reads it back from.
    for (const block of section.literalBlocks) {
      out.push("", block.ruleProse, "", FENCE, ...block.text.split("\n"), FENCE);
    }
  }

  return `${out.join("\n")}\n`;
}
