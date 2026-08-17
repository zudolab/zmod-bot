/**
 * data/seed is an immutable bootstrap fixture applied once by the seed
 * migration; D1 is authoritative at runtime (data/seed/README.md, CLAUDE.md
 * "Non-negotiables"). If the Worker ever read those files directly,
 * "reference data is online, read and written from Slack" would quietly
 * stop being true — and a `ref refresh` would appear to work while every
 * reply still came from the frozen copy.
 *
 * Doc comments may point at data/seed; code may not. The check therefore
 * strips comments before looking, rather than banning the substring.
 */
import { describe, expect, it } from "vitest";

const sources = Object.entries(
  import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
)
  .map(([path, code]): [string, string] => [path.replace("../src/", ""), code])
  .sort(([a], [b]) => a.localeCompare(b));

/** Every quoted module specifier: `from "x"`, `import "x"`, `import("x")`, `require("x")`. */
const MODULE_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*(["'`])((?:[^\\]|\\.)*?)\1/g;

/**
 * Removes line and block comments, leaving string and template literals
 * intact. Regex literals are not tracked, so one containing `//` (e.g.
 * `/https?:\/\//`) eats the rest of its line — which is why the import
 * check below runs on the raw source rather than on this output.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }

  return out;
}

describe("seed corpus isolation", () => {
  it("finds source files to check", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each(sources)("src/%s does not reference data/seed in code", (_path, code) => {
    expect(stripComments(code)).not.toContain("data/seed");
  });

  it.each(sources)("src/%s does not import from data/seed", (_path, code) => {
    const specifiers = [...code.matchAll(MODULE_SPECIFIER)].map((match) => match[2]!);

    expect(specifiers.filter((one) => one.includes("data/seed"))).toEqual([]);
  });

  it("would catch a real import, and tolerates one named in a comment", () => {
    const real = 'import corpus from "../../data/seed/products/oxi-one.md";';
    const mention = "// nothing here may import from data/seed\n/* data/seed */\nconst a = 1;";

    expect(stripComments(real)).toContain("data/seed");
    expect([...real.matchAll(MODULE_SPECIFIER)].map((match) => match[2])).toEqual([
      "../../data/seed/products/oxi-one.md",
    ]);
    expect(stripComments(mention)).not.toContain("data/seed");
    expect([...mention.matchAll(MODULE_SPECIFIER)]).toEqual([]);
  });
});
