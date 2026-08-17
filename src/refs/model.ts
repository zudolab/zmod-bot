/**
 * The ProductRef domain model — the parsed shape of a product reference
 * file, per the format documented at data/seed/README.md and
 * data/seed/source-skill.md ("Product Reference File Format"). This is
 * what src/db/repos.ts's ProductRefRow.body deserializes into, and what
 * src/reply/render.ts and src/refs/resolve.ts operate on.
 *
 * The reference files are hand-written Japanese prose with free-form
 * section headings, so the model is deliberately shallow: it captures the
 * constructs a renderer must treat differently (resources, intro text,
 * separator intro, gated sections, verbatim literal blocks) and keeps
 * everything else as prose. Nothing in a source file is discarded — see
 * src/refs/parse.ts for why that matters.
 */

/**
 * `general (built) / diy (kit)` in the source files maps to `general-diy`.
 * There is no bare `diy` category in the corpus and none may be invented:
 * a DIY kit is always the kit half of a product also sold built, and the
 * reply templates branch on that pair, not on a standalone DIY category.
 */
export type RefCategory = "general" | "general-diy" | "small";

/**
 * The category spelling used in the markdown source, keyed by the parsed
 * value — the parse/serialize round trip and the seed importer both need
 * to go back to the on-disk wording.
 *
 * `as const satisfies` rather than a `Record<RefCategory, string>`
 * annotation: these three strings ARE the values of
 * src/db/schema.ts ProductCategory, and widening them to `string` here is
 * what forced every caller writing one into the store to reach for a cast.
 */
export const REF_CATEGORY_LABELS = {
  general: "general",
  "general-diy": "general (built) / diy (kit)",
  small: "small",
} as const satisfies Record<RefCategory, string>;

/**
 * Whether a section applies to every purchase of the product or only to
 * the DIY-kit variant. Set by a `(diy only…)` heading suffix or an
 * `Intro text (diy only):` directive.
 */
export type RefGate = "always" | "diy-only";

/** One `- {title}: {url}` line inside a section. */
export interface RefResource {
  title: string;
  url: string;
}

/**
 * When a {@link RefLiteralBlock} is included in a reply. Stated as prose
 * above the fenced block in the source (see {@link RefLiteralBlock.ruleProse}),
 * classified here so the renderer never has to read Japanese prose to
 * decide whether a notice ships.
 */
export type RefLiteralRule =
  | { kind: "always" }
  | { kind: "variant-match"; needles: string[] };

/**
 * A fenced block of literal message text, included verbatim in the reply
 * — e.g. zudo-rail.md's fragility notice. The bytes matter: this text is
 * pasted into a customer message unchanged.
 */
export interface RefLiteralBlock {
  /** Fenced block content, verbatim (interior blank lines included, no trailing newline). */
  text: string;
  rule: RefLiteralRule;
  /**
   * The prose paragraph immediately above the fence, which is where the
   * include rule is stated. Retained (rather than folded into
   * {@link RefSection.prose}) so serializeProductRefMarkdown can put the
   * rule back where the parser expects to find it — a lossy round trip
   * here would drop an "ALWAYS include" notice on the next `ref refresh`.
   */
  ruleProse: string;
}

export interface RefSection {
  /** Heading text verbatim, with only a `(diy only…)` gate suffix stripped. */
  heading: string;
  gate: RefGate;
  /** `Intro text:` / `Intro text (diy only):` — prose emitted above this section's links. */
  introText?: string;
  /** `Separator intro:` — implies the renderer emits a `===` separator above this section. */
  separatorIntro?: string;
  resources: RefResource[];
  literalBlocks: RefLiteralBlock[];
  /**
   * Free prose that is neither a resource line, a labelled directive, nor
   * a literal block's rule. Paragraphs joined by a blank line. Mostly
   * editorial notes addressed to whoever composes the reply.
   */
  prose?: string;
}

export interface ProductRef {
  /** Filename without extension — see data/seed/README.md. */
  slug: string;
  /** The H1. */
  displayName: string;
  category: RefCategory;
  productUrl?: string;
  /**
   * Verbatim, as written: the corpus mixes catalog slugs, display names
   * and Japanese (`ズドレール`). Normalizing them is src/refs/resolve.ts's
   * job, not the parser's.
   */
  aliases: string[];
  sections: RefSection[];
}

/**
 * Thrown for anything in a reference file the parser cannot account for.
 * Carries the file, the section heading and the 1-based line so a failing
 * seed import or `ref refresh` points at the exact spot — an unrecognized
 * construct must be loud, because the silent alternative is a customer
 * message missing a notice nobody noticed was there.
 */
export class RefParseError extends Error {
  readonly file: string;
  /** Heading text as written, gate suffix included; null when the problem is in the header block. */
  readonly heading: string | null;
  /** 1-based line number, or null for whole-document validation failures. */
  readonly line: number | null;
  readonly lineText: string | null;

  constructor(options: {
    file: string;
    heading?: string | null;
    line?: number | null;
    lineText?: string | null;
    message: string;
  }) {
    const heading = options.heading ?? null;
    const line = options.line ?? null;
    const lineText = options.lineText ?? null;
    const where = `${options.file}${line === null ? "" : `:${line}`}`;
    const section = heading === null ? "(header)" : `(section "${heading}")`;
    super(
      `${where} ${section}: ${options.message}${lineText === null ? "" : `\n  line: ${lineText}`}`,
    );
    this.name = "RefParseError";
    this.file = options.file;
    this.heading = heading;
    this.line = line;
    this.lineText = lineText;
  }
}

const ABSOLUTE_URL = /^https?:\/\/\S+$/;

/**
 * Validates a parsed ProductRef against the format rules in
 * data/seed/README.md before it is persisted. parseProductRefMarkdown
 * runs this on its own output, so it is only worth calling directly on a
 * ref assembled some other way (an LLM-authored or Slack-edited one).
 */
export function assertValidProductRef(ref: ProductRef): void {
  const file = `${ref.slug || "<unknown>"}.md`;
  const fail = (message: string, heading: string | null = null): never => {
    throw new RefParseError({ file, heading, message });
  };

  if (!ref.slug.trim() || /\s/.test(ref.slug)) fail(`invalid slug ${JSON.stringify(ref.slug)}`);
  if (!ref.displayName.trim()) fail("display name (the H1) is empty");
  if (!(ref.category in REF_CATEGORY_LABELS)) {
    fail(`unknown category ${JSON.stringify(ref.category)}`);
  }
  if (ref.productUrl !== undefined && !ABSOLUTE_URL.test(ref.productUrl)) {
    fail(`product-url is not an absolute http(s) URL: ${JSON.stringify(ref.productUrl)}`);
  }
  for (const alias of ref.aliases) {
    if (!alias.trim()) fail("aliases contains an empty entry");
  }

  for (const section of ref.sections) {
    const heading = section.heading;
    if (!heading.trim()) fail("section heading is empty");
    if (section.gate !== "always" && section.gate !== "diy-only") {
      fail(`unknown gate ${JSON.stringify(section.gate)}`, heading);
    }
    for (const resource of section.resources) {
      if (!resource.title.trim()) fail("resource line has an empty title", heading);
      if (!ABSOLUTE_URL.test(resource.url)) {
        fail(`resource URL is not an absolute http(s) URL: ${JSON.stringify(resource.url)}`, heading);
      }
    }
    for (const block of section.literalBlocks) {
      if (!block.text.trim()) fail("literal block is empty", heading);
      if (!block.ruleProse.trim()) fail("literal block has no rule prose", heading);
      if (block.rule.kind === "variant-match") {
        if (block.rule.needles.length === 0) {
          fail("variant-match literal block has no variant needles", heading);
        }
        for (const needle of block.rule.needles) {
          if (!needle.trim()) fail("variant-match literal block has an empty needle", heading);
        }
      }
    }
  }
}
