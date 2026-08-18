/**
 * Drift guard for issue #18's acceptance criterion: "Every secret and var
 * the code reads appears in the [docs/operations.md] table — verify by
 * grepping env. across src/ and cross-checking; a test asserts
 * wrangler.jsonc's secrets.required matches the documented set."
 *
 * src/env.ts's own module comment says it plainly: "Keep this interface
 * in sync with wrangler.jsonc's d1_databases, ai, secrets.required and
 * vars — nothing enforces that automatically." This test is that
 * enforcement, in two parts:
 *
 *   1. The non-binding fields of the `Env` interface (everything except
 *      `DB`/`AI`) must be exactly the union of wrangler.jsonc's
 *      `secrets.required` and `Object.keys(vars)` — neither file may
 *      declare a name the other doesn't know about.
 *   2. Every `env.NAME` reference actually read anywhere under src/**
 *      (excluding env.ts's own interface declaration) must be one of
 *      those declared fields — the literal "grep env. across src/" the
 *      acceptance criterion asks for.
 *
 * Reads both files as raw text via Vite's `?raw` glob (see
 * tests/vite-env.d.ts — this repo has no @types/node, so no `node:fs`)
 * rather than `JSON.parse`ing wrangler.jsonc directly, since it is JSONC
 * (comments) and — critically — contains a `//` inside a string value
 * (`"SITE_API_BASE": "https://takazudomodular.com"`), so a naive
 * "strip everything after //" would corrupt it. stripJsonComments below
 * is a small string-aware state machine instead of a regex for exactly
 * that reason.
 */
import { describe, expect, it } from "vitest";

const wranglerJsoncRaw = Object.values(
  import.meta.glob("../wrangler.jsonc", { query: "?raw", import: "default", eager: true }),
)[0]!;

const envTsRaw = Object.values(
  import.meta.glob("../src/env.ts", { query: "?raw", import: "default", eager: true }),
)[0]!;

/** Every .ts file under src/, keyed by path — the grep corpus for part 2. */
const srcFiles = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

/**
 * Strips `//` and `/* *\/` JSONC comments while respecting string
 * literals (and their escape sequences), so a `//` inside a quoted value
 * is left alone. See the module comment for why a regex isn't safe here.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inBlockComment = false;
  let inLineComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

interface WranglerConfig {
  secrets: { required: string[] };
  vars: Record<string, unknown>;
}

const wranglerConfig = JSON.parse(stripJsonComments(wranglerJsoncRaw)) as WranglerConfig;
const wranglerDeclaredNames = new Set([
  ...wranglerConfig.secrets.required,
  ...Object.keys(wranglerConfig.vars),
]);

/** Structural bindings, declared via wrangler.jsonc's `d1_databases`/`ai` — not a secret or a var, so excluded from the parity check above. */
const BINDING_FIELDS = new Set(["DB", "AI"]);

/**
 * Every top-level property name declared on the `Env` interface —
 * matched as `  NAME:` / `  NAME?:` at exactly two-space indent, which a doc-comment
 * line (`  /**`, `  //`, `  * ...`) never satisfies since none of them
 * start with an uppercase letter.
 */
function extractEnvInterfaceFields(): string[] {
  const start = envTsRaw.indexOf("export interface Env {");
  if (start === -1) throw new Error("could not find `export interface Env {` in src/env.ts");
  const bodyStart = start + "export interface Env {".length;
  const end = envTsRaw.indexOf("\n}", bodyStart);
  if (end === -1) throw new Error("could not find the closing `}` of the Env interface in src/env.ts");
  const body = envTsRaw.slice(bodyStart, end);
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\??:/gm)].map((match) => match[1]!);
}

/** Every `env.NAME` / `deps.env.NAME` / `context.env.NAME` reference across non-test src files. */
function collectEnvReferences(): Set<string> {
  const names = new Set<string>();
  const pattern = /\benv\.([A-Z][A-Z0-9_]*)\b/g;
  for (const [path, contents] of Object.entries(srcFiles)) {
    if (path.endsWith(".test.ts")) continue;
    if (path.endsWith("/env.ts")) continue; // the interface's own declarations, not a read
    for (const match of contents.matchAll(pattern)) names.add(match[1]!);
  }
  return names;
}

describe("Env interface / wrangler.jsonc parity (issue #18)", () => {
  it("wrangler.jsonc's secrets.required + vars exactly match env.ts's non-binding Env fields", () => {
    const envFields = extractEnvInterfaceFields();
    const nonBindingEnvFields = new Set(envFields.filter((name) => !BINDING_FIELDS.has(name)));

    const declaredOnlyInWrangler = [...wranglerDeclaredNames].filter((name) => !nonBindingEnvFields.has(name));
    const declaredOnlyInEnvTs = [...nonBindingEnvFields].filter((name) => !wranglerDeclaredNames.has(name));

    expect(declaredOnlyInWrangler, "wrangler.jsonc declares a secret/var missing from Env").toEqual([]);
    expect(declaredOnlyInEnvTs, "Env declares a field missing from wrangler.jsonc's secrets.required/vars").toEqual(
      [],
    );
  });

  it("every env.NAME read anywhere under src/ is declared on the Env interface", () => {
    const envFields = new Set(extractEnvInterfaceFields());
    const referenced = collectEnvReferences();

    const undeclared = [...referenced].filter((name) => !envFields.has(name));
    expect(undeclared, "src/** reads env.<NAME> for a name the Env interface never declares").toEqual([]);
  });

  it("sanity: both files declare a non-empty set, so the checks above cannot pass vacuously", () => {
    expect(wranglerDeclaredNames.size).toBeGreaterThan(0);
    expect(extractEnvInterfaceFields().length).toBeGreaterThan(0);
    expect(collectEnvReferences().size).toBeGreaterThan(0);
  });

  it("keeps the policy editor's quality-first provider and model fallback defaults explicit", () => {
    expect(wranglerConfig.vars.POLICY_PROVIDER).toBe("claude");
    expect(wranglerConfig.vars.POLICY_MODEL).toBe("");
    expect(extractEnvInterfaceFields()).toEqual(expect.arrayContaining(["POLICY_PROVIDER", "POLICY_MODEL"]));
  });
});
