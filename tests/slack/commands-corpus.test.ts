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
import { buildCandidatePickerPayload, MAX_BUTTON_VALUE_CHARS } from "../../src/slack/commands";
import { parseProductRefMarkdown } from "../../src/refs/parse";

const sources = Object.entries(
  import.meta.glob("../../data/seed/products/*.md", { query: "?raw", import: "default", eager: true }),
).map(([path, markdown]): { slug: string; markdown: string } => ({
  slug: path.replace(/^.*\/(.+)\.md$/, "$1"),
  markdown: markdown as string,
}));

/** Every button `value` embedded in a Block Kit payload's JSON. */
function extractButtonValues(payload: { blocks: unknown[] }): string[] {
  const json = JSON.stringify(payload.blocks);
  return [...json.matchAll(/"value":"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!);
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

  it("every seed file parses (sanity check that the corpus glob above is reading real files)", () => {
    for (const { slug, markdown } of sources) {
      expect(() => parseProductRefMarkdown({ slug, markdown })).not.toThrow();
    }
  });
});
