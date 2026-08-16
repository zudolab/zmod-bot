/**
 * Sqlite-backed D1 shim for tests — real SQL against a temp database,
 * migrated with the files in `migrations/`, rather than a mocked D1
 * client. See CLAUDE.md "Conventions": there is no Miniflare in this
 * repo, so this is how src/db/repos.ts gets exercised against the real
 * schema. Modeled on readycrew-viewer's
 * `app/src/db/sqlite-d1.test-support.ts` (same D1Result.meta /
 * batch()-interleaving concerns apply once implemented).
 *
 * Node-only (it will invoke a local `sqlite3` binary) and never imported
 * from src/index.ts's production graph, so wrangler's esbuild bundle
 * never pulls it in — no separate exclude config needed.
 *
 * Implementation is issue #3's responsibility, alongside migrations/.
 */

export interface TestDbHandle {
  db: D1Database;
  /** Deletes the temp sqlite file backing this handle. */
  close(): void;
}

/** Applies every migration in migrations/ against a fresh temp sqlite database and returns a D1Database-shaped handle. */
export function createTestDb(): TestDbHandle {
  throw new Error("not implemented: createTestDb");
}
