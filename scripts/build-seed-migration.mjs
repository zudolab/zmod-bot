/**
 * Generates migrations/0002_seed_product_refs.sql from data/seed/products/*.md
 * — the one-time bootstrap import of the 34 vendored product references into
 * D1 (issue #9). Run via `pnpm seed:build`; the output is committed, and CI
 * applies it (with 0001) via `wrangler d1 migrations apply` before deploy —
 * there is no manual seed step.
 *
 * Run twice, this must produce a byte-identical file (acceptance criterion:
 * "deterministic ... does not churn"), so nothing here may read the clock,
 * environment, or filesystem iteration order without sorting it first.
 *
 * Uses src/refs/parse.ts (the real parser — a `RefParseError` on any of the
 * 34 files fails this build, matching #4's "loud, never silent" contract)
 * and src/refs/resolve.ts's normalizeAlias (the one true normalizer — see
 * that module's doc comment). Both are TypeScript; scripts/lib/ts-strip-loader.mjs
 * is what lets a plain Node script import them directly — see that file for
 * why a loader is necessary at all.
 *
 * Run via `pnpm seed:build`, never directly — that script passes the
 * `--experimental-transform-types` flag this file's imports depend on
 * (see ts-strip-loader.mjs). Without it, importing src/refs/parse.ts
 * throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
 */
import { register } from "node:module";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./lib/ts-strip-loader.mjs", import.meta.url);

const { parseProductRefMarkdown } = await import("../src/refs/parse.ts");
const { REF_CATEGORY_LABELS } = await import("../src/refs/model.ts");
const { normalizeAlias } = await import("../src/refs/resolve.ts");

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const PRODUCTS_DIR = path.join(ROOT, "data", "seed", "products");
const OUTPUT_FILE = path.join(ROOT, "migrations", "0002_seed_product_refs.sql");

/**
 * Fixed, not wall-clock — `pnpm seed:build` must be byte-identical on every
 * run (acceptance criterion). This is bootstrap data with no real "when it
 * happened" moment of its own; every row gets this same sentinel instant.
 */
const SEED_TIMESTAMP_MS = 0;

/**
 * `tests/helpers/test-env.ts` applies a migration to Miniflare's D1 binding
 * by splitting the file on `;` and collapsing each resulting statement's
 * whitespace to single spaces before `exec()`-ing it (D1's `exec()` splits
 * on newlines, not semicolons — see that file's doc comment and CLAUDE.md).
 * A literal newline byte inside a string literal does not survive that
 * collapse: two paragraphs of body_md separated by a blank line come back
 * as one space-joined line, silently. Encoding every text value as a
 * concatenation of single-line string literals joined by SQLite's char(10)
 * (never an embedded newline byte) sidesteps this entirely — verified
 * against a real Miniflare D1 binding during implementation. The same
 * naive collapse would also merge two consecutive plain spaces into one,
 * so assertCollapseSafe() below additionally checks no line has a run of
 * 2+ spaces/tabs.
 */
function sqlText(value) {
  const escaped = value.split("\n").map((line) => `'${line.replace(/'/g, "''")}'`);
  return escaped.join(" || char(10) || ");
}

function sqlNullableText(value) {
  return value === null || value === undefined ? "NULL" : sqlText(value);
}

/**
 * Guards the assumption sqlText() depends on: no line of `value` contains a
 * run of 2+ spaces or tabs. True today for all 34 files (verified); this
 * makes a future violation a loud build failure instead of test-only data
 * corruption under Miniflare (see sqlText's doc comment).
 */
function assertCollapseSafe(value, where) {
  const offendingLine = value.split("\n").find((line) => /[ \t]{2,}/.test(line));
  if (offendingLine !== undefined) {
    throw new Error(
      `${where}: contains a run of 2+ spaces/tabs, which the Miniflare test harness's whitespace collapse ` +
        `would corrupt (tests/helpers/test-env.ts) — found in line: ${JSON.stringify(offendingLine)}`,
    );
  }
}

/** CLAUDE.md: "Never use `--` line comments in a migration" — a folded `--` silently truncates the rest of the statement. */
function assertNoLineComments(sql) {
  if (/--/.test(sql)) {
    throw new Error("generated SQL contains `--`, which silently truncates a statement after newline-collapse");
  }
}

async function loadCorpus() {
  const files = (await readdir(PRODUCTS_DIR)).filter((name) => name.endsWith(".md")).sort();

  return Promise.all(
    files.map(async (file) => {
      const slug = file.replace(/\.md$/, "");
      const markdown = await readFile(path.join(PRODUCTS_DIR, file), "utf8");
      const ref = parseProductRefMarkdown({ slug, markdown }); // throws RefParseError on malformed input — fails the build, per issue #9
      return { ref, markdown };
    }),
  );
}

/**
 * Every reference's alias set, plus its own H1 display name (issue #9):
 * #8's resolver exact-matches before it ever falls back to containment, so
 * registering the H1 makes every product resolve from its own display name
 * by exact match — including ai-smatrix and oam-vca-expander, whose H1
 * otherwise contains a *different* product's alias as a substring and
 * would resolve `ambiguous`. Deduped per product via normalizeAlias (a
 * product whose H1 already appears in its own `aliases:` line — 11 of 34
 * — must not register the same alias_norm twice; product_ref_aliases.alias_norm
 * is a PRIMARY KEY).
 */
function aliasesFor(ref) {
  return [...new Set([...ref.aliases, ref.displayName].map(normalizeAlias))];
}

/**
 * Fails the build if any normalized alias — including an H1-as-alias —
 * would be claimed by more than one product. Verified zero collisions
 * during planning (issue #9); this is what keeps that verification true
 * as the corpus evolves rather than trusting it stays true forever.
 */
function assertNoAliasCollisions(corpus) {
  const owners = new Map(); // alias_norm -> slug that first claimed it

  for (const { ref } of corpus) {
    for (const aliasNorm of aliasesFor(ref)) {
      const owner = owners.get(aliasNorm);
      if (owner !== undefined && owner !== ref.slug) {
        throw new Error(
          `alias collision: ${JSON.stringify(aliasNorm)} is claimed by both ${owner} and ${ref.slug} ` +
            `(one of them via its H1 display name) — the resolver (issue #8) requires every alias to map to exactly one product`,
        );
      }
      owners.set(aliasNorm, ref.slug);
    }
  }
}

function buildInsertStatements({ ref, markdown }) {
  const category = REF_CATEGORY_LABELS[ref.category];
  const productUrl = ref.productUrl ?? null;

  assertCollapseSafe(markdown, `${ref.slug}.md body_md`);
  if (markdown.includes(";")) {
    // The naive `.split(";")` statement splitter (tests/helpers/test-env.ts,
    // CLAUDE.md "exec() splits on NEWLINES, not semicolons") requires every
    // seed body to contain zero semicolons — verified true for all 34 files;
    // this keeps a future one from silently truncating a statement instead
    // of failing the build.
    throw new Error(`${ref.slug}.md body_md contains a semicolon — would truncate a naively-split migration statement`);
  }

  const refsInsert =
    `INSERT INTO product_refs (slug, category, product_url, body_md, version, updated_at, updated_by) ` +
    `VALUES (${sqlText(ref.slug)}, ${sqlText(category)}, ${sqlNullableText(productUrl)}, ${sqlText(markdown)}, 1, ${SEED_TIMESTAMP_MS}, 'seed') ` +
    `ON CONFLICT(slug) DO NOTHING;`;

  const versionsInsert =
    `INSERT INTO product_ref_versions (slug, version, body_md, category, product_url, created_at, created_by, source) ` +
    `VALUES (${sqlText(ref.slug)}, 1, ${sqlText(markdown)}, ${sqlText(category)}, ${sqlNullableText(productUrl)}, ${SEED_TIMESTAMP_MS}, 'seed', 'seed') ` +
    `ON CONFLICT(slug, version) DO NOTHING;`;

  const aliasValues = aliasesFor(ref)
    .map((aliasNorm) => {
      assertCollapseSafe(aliasNorm, `${ref.slug}.md alias ${JSON.stringify(aliasNorm)}`);
      return `(${sqlText(aliasNorm)}, ${sqlText(ref.slug)})`;
    })
    .join(", ");
  const aliasesInsert =
    `INSERT INTO product_ref_aliases (alias_norm, slug) VALUES ${aliasValues} ON CONFLICT(alias_norm) DO NOTHING;`;

  return [refsInsert, versionsInsert, aliasesInsert];
}

async function main() {
  const corpus = await loadCorpus();
  if (corpus.length !== 34) {
    throw new Error(`expected exactly 34 seed reference files, found ${corpus.length}`);
  }

  assertNoAliasCollisions(corpus);

  const statements = corpus.flatMap((entry) => buildInsertStatements(entry));

  const header = [
    "/* Generated by `pnpm seed:build` (scripts/build-seed-migration.mjs) from data/seed/products/*.md.",
    "   Do not hand-edit — regenerate instead. See data/seed/README.md.",
    "",
    "   Every INSERT is ON CONFLICT DO NOTHING, so re-applying this migration is a no-op (issue #9).",
    "   Text values are encoded as char(10)-joined single-line literals rather than embedding raw",
    "   newlines — see sqlText() in the generator for why. */",
  ].join("\n");

  const sql = `${header}\n\n${statements.join("\n\n")}\n`;
  assertNoLineComments(sql);

  await writeFile(OUTPUT_FILE, sql, "utf8");
  console.log(`wrote ${OUTPUT_FILE} (${corpus.length} references, ${statements.length} statements)`);
}

await main();
