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
