/**
 * Test harness for the D1 layer — two tiers, chosen by what is under test.
 *
 * The load-bearing principle (see /test-wisdom
 * `project-recipes/backend-testing.mdx`): **test YOUR logic, not the
 * platform's storage engine.**
 *
 *   createMockD1()   (this file) — Map-backed stub implementing only the
 *                    D1Database methods under test. Use it when the
 *                    assertion is about handler branching and threading —
 *                    does this route read the binding it should, does the
 *                    ingress filter reject the right events. Fast, plain
 *                    Node, pre-seedable, and it asserts nothing about SQL.
 *
 *   createTestEnv()  (tests/helpers/test-env.ts) — Miniflare-backed REAL
 *                    D1 binding, with the files in migrations/ applied.
 *                    Use it whenever the assertion is about storage
 *                    semantics: `ON CONFLICT DO NOTHING` reporting
 *                    `meta.changes === 0`, `db.batch()` atomicity, the
 *                    claim-token fenced `UPDATE` matching zero rows.
 *
 * Why Miniflare rather than a hand-rolled sqlite shim: this project's
 * critical assertions ARE those D1 semantics, and a shim that reproduces
 * `meta.changes` by hand can drift from real D1 — in which case the tests
 * agree with themselves while production breaks.
 *
 * Not reachable from src/index.ts's production import graph, so
 * wrangler's esbuild bundle never pulls this in.
 *
 * Implementation is issue #3's responsibility.
 */

/** Map-backed D1 stub for handler-branching tests. Implements only what a test needs. */
export function createMockD1(): D1Database {
  throw new Error("not implemented: createMockD1");
}
