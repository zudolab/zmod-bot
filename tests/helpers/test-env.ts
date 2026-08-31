/**
 * Miniflare-backed real D1 binding, for storage-semantics tests — the
 * counterpart to `createMockD1` (src/db/test-support.ts). See that file's
 * doc comment for the two-tier rationale: this helper exists specifically
 * because `ON CONFLICT DO NOTHING` -> `meta.changes === 0`, `db.batch()`
 * atomicity, and the claim-token fenced `UPDATE` matching zero rows are
 * real D1 engine behavior that a hand-rolled shim could get subtly wrong
 * while still agreeing with itself.
 *
 * ⚠️ D1's `exec()` splits its input on NEWLINES, not semicolons. A
 * pretty-printed multi-statement migration file passed straight through
 * throws `D1_EXEC_ERROR: incomplete input`. Split each migration on `;`,
 * collapse each statement to one line, and `exec()` one at a time. The
 * naive split is safe for this repo specifically — all 34 seed reference
 * bodies were verified to contain zero semicolons — so keep it that way;
 * if a migration ever embeds `;` inside a string literal, comment, or
 * trigger body, switch to a real SQL statement splitter rather than
 * debugging a truncated migration.
 *
 * The same collapse-to-one-line step is also why migrations/*.sql must
 * never use a `--` line comment: once newlines are folded to spaces, a
 * `--` comment consumes everything after it to the end of the (now much
 * longer) line, silently truncating the rest of the statement. Use a
 * block comment instead — see migrations/0001_init.sql.
 *
 * Migration files are imported with Vite's `?raw` suffix (vitest's
 * transform is Vite-powered — see raw-sql.d.ts) rather than read via
 * Node's `fs`: this project's tsconfig types only
 * `@cloudflare/workers-types` (no `node`), so `fs` isn't typed here, and
 * this keeps that Workers-only boundary intact instead of adding a Node
 * types dependency just for this test helper.
 */
import { Miniflare } from "miniflare";
import migration0001 from "../../migrations/0001_init.sql?raw";
import migration0003 from "../../migrations/0003_ref_drafts_source.sql?raw";
import migration0004 from "../../migrations/0004_ref_drafts_origin_job.sql?raw";
import migration0005 from "../../migrations/0005_jobs_thread_lookup.sql?raw";
import migration0006 from "../../migrations/0006_jobs_resolved_context.sql?raw";
import migration0007 from "../../migrations/0007_policy_last_known_good.sql?raw";
import migration0008 from "../../migrations/0008_policy_stash_coordination.sql?raw";

/**
 * Every always-applied migration file's SQL text, in order. Add to this
 * array once a migration is meant for every test (see the `migrations`
 * option below for one that isn't).
 *
 * 0002 (the seed corpus) is deliberately absent — it is the opt-in one.
 * 0003, 0004, 0005, 0006, 0007, 0008 only ALTER/CREATE against tables 0001
 * creates or independent storage, so applying them before an opt-in 0002 is
 * equivalent to production's strict filename order.
 */
const MIGRATIONS: string[] = [
  migration0001,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
];

export interface CreateTestEnvOptions {
  /**
   * Extra migration SQL text, applied in order after {@link MIGRATIONS}.
   * Opt-in rather than appended to the base array so existing tests that
   * assume a bare 0001 schema (e.g. tests/db/repos.test.ts inserting its
   * own `oxi-one` / `wingie2` fixture rows, which would collide with the
   * seed migration's rows of the same slug) are unaffected. Pass the seed
   * migration here (`migrations/0002_seed_product_refs.sql?raw`) from a
   * test that specifically wants the seeded corpus loaded.
   */
  migrations?: string[];
}

export interface TestEnvHandle {
  db: D1Database;
  /** Disposes the Miniflare instance backing this handle — call in `afterEach`/`afterAll`. */
  dispose(): Promise<void>;
}

/**
 * `new Miniflare({ modules: true, script: "", d1Databases: ["DB"] })`
 * with migrations/*.sql applied — see the gotcha above.
 */
export async function createTestEnv(options: CreateTestEnvOptions = {}): Promise<TestEnvHandle> {
  const mf = new Miniflare({ modules: true, script: "", d1Databases: ["DB"] });
  const bindings = await mf.getBindings();
  const db = bindings.DB as D1Database;

  for (const sql of [...MIGRATIONS, ...(options.migrations ?? [])]) {
    for (const statement of sql
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)) {
      await db.exec(statement);
    }
  }

  return {
    db,
    dispose: () => mf.dispose(),
  };
}
