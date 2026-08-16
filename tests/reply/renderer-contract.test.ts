/**
 * The two structural promises issue #7 makes about the renderer, checked
 * against the source rather than trusted.
 *
 * 1. **The goldens read data/seed, never D1.** The seed corpus is frozen;
 *    D1 is not — `ref new` / `ref refresh` write LLM-authored bodies at
 *    runtime, so a golden suite pointed at the database would start
 *    failing on *data* rather than on a regression, long after the change
 *    that caused it.
 * 2. **The renderer is pure.** Same input, same bytes: no clock, no
 *    network, no randomness. The arrival date is an argument.
 *
 * Globs sibling files only — Vite excludes the globbing module itself.
 */
import { describe, expect, it } from "vitest";

const tests = Object.entries(
  import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }),
).sort(([a], [b]) => a.localeCompare(b));

const modules = Object.entries(
  import.meta.glob("../../src/reply/*.ts", { query: "?raw", import: "default", eager: true }),
).sort(([a], [b]) => a.localeCompare(b));

/** Every quoted module specifier — `from "x"`, `import "x"`, `import("x")`. */
const MODULE_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*(["'`])((?:[^\\]|\\.)*?)\1/g;
const DATABASE = /\/db\/|test-env|miniflare/i;

const specifiersOf = (code: string): string[] =>
  [...code.matchAll(MODULE_SPECIFIER)].map((match) => match[2]!);

describe("the golden suite's provenance", () => {
  it("sees the suite it is checking", () => {
    expect(tests.map(([path]) => path)).toEqual(["./golden.test.ts", "./templates-drift.test.ts"]);
  });

  it.each(tests)("%s builds no ProductRef from the database", (_path, code) => {
    expect(specifiersOf(code).filter((one) => DATABASE.test(one))).toEqual([]);
  });

  it("builds the golden references from data/seed/products", () => {
    const [, code] = tests.find(([path]) => path === "./golden.test.ts")!;

    expect(code).toContain("data/seed/products/*.md");
    expect(code).toContain("parseProductRefMarkdown");
  });

  it("would catch a suite that reached for D1", () => {
    const reached = 'import { productRefsRepo } from "../../src/db/repos";';

    expect(specifiersOf(reached).filter((one) => DATABASE.test(one))).toEqual(["../../src/db/repos"]);
  });
});

describe("the renderer's purity", () => {
  /**
   * compose.ts (issue #13) is the orchestration layer and is expected to
   * reach for the network; the two modules issue #7 owns are not.
   */
  const PURE = ["../../src/reply/render.ts", "../../src/reply/templates.ts"];
  /** Call syntax, not bare words, so a doc comment mentioning a clock does not trip it. */
  const IMPURE_CALLS = ["Date.now(", "new Date(", "Math.random(", "performance.now(", "fetch("];

  it("sees both modules it is checking", () => {
    expect(modules.map(([path]) => path)).toEqual(expect.arrayContaining(PURE));
  });

  it.each(PURE)("%s reads no clock, no randomness and no network", (path) => {
    const [, code] = modules.find(([one]) => one === path)!;

    for (const call of IMPURE_CALLS) {
      expect(code, `${path} calls ${call}`).not.toContain(call);
    }
  });

  it.each(PURE)("%s imports only the domain model and its own templates", (path) => {
    const allowed = new Set(["../refs/model", "./templates"]);
    const [, code] = modules.find(([one]) => one === path)!;

    expect(specifiersOf(code).filter((one) => !allowed.has(one))).toEqual([]);
  });
});
