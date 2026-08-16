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
 * Implementation (constructing the Miniflare instance, applying
 * migrations/, wiring its D1 binding) is issue #3's responsibility.
 */

export interface TestEnvHandle {
  db: D1Database;
  /** Disposes the Miniflare instance backing this handle — call in `afterEach`/`afterAll`. */
  dispose(): Promise<void>;
}

/** `new Miniflare({ modules: true, script: "", d1Databases: ["DB"] })` with migrations/ applied — see the gotcha above. */
export function createTestEnv(): Promise<TestEnvHandle> {
  throw new Error("not implemented: createTestEnv");
}
