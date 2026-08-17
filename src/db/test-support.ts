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
 * agree with themselves while production breaks. createMockD1 below is
 * deliberately the opposite of that: it evaluates no SQL at all, so a
 * test using it can never mistake mock behavior for real D1 behavior.
 *
 * Not reachable from src/index.ts's production import graph, so
 * wrangler's esbuild bundle never pulls this in.
 */

/** One recorded prepare().bind() call, in issue order — for asserting a handler issued the query it should. */
export interface MockD1Call {
  query: string;
  bindings: unknown[];
}

/** A caller-supplied result for a given call — both fields optional, unlike `Partial<D1Result>` (whose `meta`, once present, would still require every D1Meta field). */
export interface MockD1QueryResult {
  results?: unknown[];
  meta?: Partial<D1Meta>;
}

/** Return a fixed shape for a given call, or `undefined`/`null` to fall through to createMockD1's default (empty, zero-changes) result. */
export type MockD1QueryHandler = (call: MockD1Call) => MockD1QueryResult | null | undefined;

export interface MockD1 extends D1Database {
  /** Table name -> seeded rows, for tests to set up fixtures or assert what a handler wrote. Not read by prepare()/exec() — see onQuery. */
  tables: Map<string, Record<string, unknown>[]>;
  /** Every prepare().bind() call this stub has seen, in order. */
  calls: MockD1Call[];
}

export interface CreateMockD1Options {
  /** Intercepts every run()/all()/first(). Falls through to an empty, `changes: 0` result when it returns null/undefined. */
  onQuery?: MockD1QueryHandler;
}

const EMPTY_META: D1Meta = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

/**
 * Map-backed D1 stub for handler-branching tests. Implements only what a
 * test needs: `tables` is a plain Map a test can seed/inspect directly,
 * `calls` records every query issued, and `onQuery` lets a test return a
 * specific result for a specific query. No SQL is parsed or evaluated —
 * a query with no matching `onQuery` result gets the empty default
 * below, which is deliberately visible (zero rows, zero changes) rather
 * than throwing, so a handler under test can exercise its "not found" /
 * "nothing changed" branch with no setup at all.
 */
export function createMockD1(options: CreateMockD1Options = {}): MockD1 {
  const tables = new Map<string, Record<string, unknown>[]>();
  const calls: MockD1Call[] = [];

  function runQuery(query: string, bindings: unknown[]): D1Result {
    const call = { query, bindings };
    calls.push(call);
    const custom = options.onQuery?.(call);
    return {
      success: true,
      results: custom?.results ?? [],
      meta: { ...EMPTY_META, ...custom?.meta },
    };
  }

  function makeStatement(query: string, bindings: unknown[] = []): D1PreparedStatement {
    const statement: Pick<D1PreparedStatement, "bind" | "first" | "run" | "all" | "raw"> = {
      bind: (...values: unknown[]) => makeStatement(query, values),
      first: async <T>(colName?: string) => {
        const result = runQuery(query, bindings);
        const row = result.results[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        return (colName === undefined ? row : row[colName]) as T;
      },
      run: async <T>() => runQuery(query, bindings) as D1Result<T>,
      all: async <T>() => runQuery(query, bindings) as D1Result<T>,
      raw: () => {
        throw new Error("createMockD1: raw() is not supported — assert against .calls or .tables instead");
      },
    };
    return statement as D1PreparedStatement;
  }

  const mock: MockD1 = {
    tables,
    calls,
    prepare: (query: string) => makeStatement(query),
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((s) => s.run())),
    exec: async (query: string) => ({
      count: query.split("\n").filter((line) => line.trim().length > 0).length,
      duration: 0,
    }),
    withSession: () => {
      throw new Error("createMockD1: withSession() is not supported");
    },
    dump: async () => {
      throw new Error("createMockD1: dump() is not supported");
    },
  } as unknown as MockD1;

  return mock;
}
