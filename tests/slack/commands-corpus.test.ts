/**
 * No button `value` exceeds Slack's 2000-char cap for any reference in
 * the seed corpus (issue #14 acceptance criteria). candidate_pick is the
 * worst case among src/slack/commands.ts's picker builders, since its
 * `a` argument is a full product slug rather than a short sentinel like
 * "built"/"kit" or an encoded arrival option.
 *
 * Lives under tests/ rather than next to src/slack/commands.test.ts —
 * nothing under src/** may reference data/seed (CLAUDE.md
 * "Non-negotiables": D1 is the runtime store), and
 * tests/seed-corpus-isolation.test.ts enforces exactly that boundary
 * against every file under src/**. See tests/refs/corpus.test.ts for the
 * same pattern.
 */
import { describe, expect, it } from "vitest";
import { buildCandidatePickerPayload, buildMissingRefPayload, decodeButtonValue, MAX_BUTTON_VALUE_CHARS } from "../../src/slack/commands";
import { escapeMrkdwn, MAX_CHARS_PER_SECTION_TEXT } from "../../src/slack/blocks";
import { parseProductRefMarkdown } from "../../src/refs/parse";

const sources = Object.entries(
  import.meta.glob("../../data/seed/products/*.md", { query: "?raw", import: "default", eager: true }),
).map(([path, markdown]): { slug: string; markdown: string } => ({
  slug: path.replace(/^.*\/(.+)\.md$/, "$1"),
  markdown: markdown as string,
}));

/** Every text an operator could plausibly have typed to reach a given reference: its display name and each of its aliases. */
const corpusQueries = [
  ...new Set(
    sources.flatMap(({ slug, markdown }) => {
      const ref = parseProductRefMarkdown({ slug, markdown });
      return [ref.displayName, ...ref.aliases];
    }),
  ),
].sort();

/**
 * Every button `value` embedded in a Block Kit payload's JSON, unescaped
 * back to the literal string Slack receives. The unescaping matters for
 * the create_reference envelope below: its own quotes appear doubled in
 * the enclosing JSON, so the raw match overstates the length by exactly
 * the characters Slack does not count.
 */
function extractButtonValues(payload: { blocks: unknown[] }): string[] {
  const json = JSON.stringify(payload.blocks);
  return [...json.matchAll(/"value":"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]!}"`) as string);
}

/** The miss reply's mrkdwn `section` text, as Slack would receive it. */
function missingRefSectionText(query: string): string {
  const payload = buildMissingRefPayload({ query, originJobId: 999_999 });
  return (payload.blocks[0] as { text: { text: string } }).text.text;
}

describe("button values stay under Slack's 2000-char cap for every seed reference", () => {
  it("has a non-empty corpus to check (guards against this test silently checking nothing)", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("candidate_pick value for $slug", ({ slug }) => {
    const values = extractButtonValues(buildCandidatePickerPayload(999_999, [slug]));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_CHARS);
    }
  });

  it("also holds for every candidate packed into a single ambiguous-result picker at once", () => {
    const allSlugs = sources.map((source) => source.slug);
    const values = extractButtonValues(buildCandidatePickerPayload(999_999, allSlugs));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_CHARS);
    }
  });

  /**
   * The create_reference button (issue #25) is the other envelope whose
   * `a` is unbounded text: it carries the search query the resolver
   * missed on. The realistic worst case is an operator typing a
   * product's full display name or longest alias, so every one of those
   * in the corpus is checked — and the envelope must also still *decode*,
   * since the fitting truncates the query rather than the JSON around it.
   */
  it.each(corpusQueries)("create_reference value for the query %s", (query) => {
    const values = extractButtonValues(buildMissingRefPayload({ query, originJobId: 999_999 }));
    expect(values).toHaveLength(1);
    expect(values[0]!.length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_CHARS);
    expect(decodeButtonValue(values[0]!)?.id).toBe("999999");
  });

  it("has a non-empty query list to check (the corpus queries above must not silently be empty)", () => {
    expect(corpusQueries.length).toBeGreaterThan(0);
  });

  /**
   * Nothing bounds a Slack message's length to a display name, so the
   * button must stay *buildable* for a query far past the cap — the id is
   * what survives, the query is what gets cut (issue #25).
   */
  it("stays buildable when the query is every corpus name concatenated", () => {
    const absurd = corpusQueries.join(" ");
    expect(absurd.length).toBeGreaterThan(MAX_BUTTON_VALUE_CHARS);

    const values = extractButtonValues(buildMissingRefPayload({ query: absurd, originJobId: 999_999 }));
    expect(values[0]!.length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_CHARS);
    expect(decodeButtonValue(values[0]!)?.id).toBe("999999");
  });

  it("every seed file parses (sanity check that the corpus glob above is reading real files)", () => {
    for (const { slug, markdown } of sources) {
      expect(() => parseProductRefMarkdown({ slug, markdown })).not.toThrow();
    }
  });
});

/**
 * The miss reply's other unbounded half (issue #31). The button `value`
 * above fails soft — an overlong one is truncated and the click still
 * works — but the `section` fails hard: Slack rejects an oversized
 * `section.text` with `invalid_blocks` and drops the *entire* message, so
 * the customer gets no reply at all. Nothing upstream bounds the input;
 * the query is whatever the operator's mention contained.
 */
describe("the miss reply's section text stays under Slack's 3000-char cap", () => {
  it.each(corpusQueries)("missing_ref section for the query %s", (query) => {
    const text = missingRefSectionText(query);

    expect(text.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
    // A corpus name is nowhere near the cap, so it must survive verbatim —
    // compared against the escaped form (like the oversized case below) so a
    // name that later gains an `&`/`<`/`>` does not turn this into a false
    // failure. Full equality also covers "no truncation marker was added"
    // without assuming no corpus name ever contains a literal "…".
    expect(text).toBe(`「${escapeMrkdwn(query)}」に一致する製品リファレンスが見つかりませんでした。`);
  });

  /**
   * Every corpus name concatenated comes to ~2,900 characters — just
   * *under* the section cap, which is why this doubles it rather than
   * using the single join the button-value case above can rely on (2,000
   * is the lower bar). Corpus text rather than filler because it carries
   * the real mix of Japanese, ASCII and escapable characters an operator
   * would actually paste.
   */
  it("stays postable when the query is far past the cap", () => {
    const absurd = `${corpusQueries.join(" ")} ${corpusQueries.join(" ")}`;
    expect(absurd.length).toBeGreaterThan(MAX_CHARS_PER_SECTION_TEXT);

    const text = missingRefSectionText(absurd);

    expect(text.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
    expect(text).toContain("…");
    expect(text).toMatch(/に一致する製品リファレンスが見つかりませんでした。$/);
    // What survives is a prefix of the query, not a mangled or reordered
    // one. Compared against the escaped form so a corpus name that later
    // gains an `&` does not turn this into a false failure.
    expect(escapeMrkdwn(absurd).startsWith(text.slice(1, text.indexOf("…")))).toBe(true);
  });
});
