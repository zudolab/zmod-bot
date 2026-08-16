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

/** Removes line and block comments, leaving string and template literals intact. */
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

  it("would catch a real import", () => {
    expect(stripComments('import x from "../../data/seed/products/oxi-one.md";')).toContain("data/seed");
    expect(stripComments("// see data/seed/README.md\n/* data/seed */\nconst a = 1;")).not.toContain("data/seed");
  });
});
