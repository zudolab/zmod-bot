/**
 * `GET /health` — a real D1 round-trip plus whatever migration
 * bookkeeping is available, so the deploy smoke test (issue #18) has
 * something to hit beyond a literal 200. Split out from src/index.ts so
 * it's independently testable against both `createMockD1()` (handler
 * branching — see src/db/test-support.ts) and a real Miniflare binding
 * (tests/helpers/test-env.ts), per CLAUDE.md's two-tier testing rule.
 */
import type { RouteContext } from "./router";
import { errorSnippet } from "./ops/log";

export interface HealthReport {
  ok: boolean;
  /**
   * Applied migration names, read from D1's own `d1_migrations`
   * bookkeeping table — populated by `wrangler d1 migrations apply`
   * (.github/workflows/deploy.yml), never hand-maintained here. Empty
   * when that table doesn't exist yet: a test env that applies the SQL
   * in migrations/ directly via `db.exec()` (tests/helpers/test-env.ts)
   * never creates it. Absence is not itself unhealthy — the refCount
   * round-trip below already proves the schema is live.
   */
  migrations: string[];
  /** `SELECT COUNT(*) FROM product_refs` — the actual D1 round-trip this check exists to prove. Null only when even that failed. */
  refCount: number | null;
  error?: string;
}

/** The testable core — takes the D1 binding directly rather than a RouteContext, so it needs no Env/Router fixture to exercise. */
export async function checkHealth(db: D1Database): Promise<HealthReport> {
  let refCount: number;
  try {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM product_refs").first<{ count: number }>();
    refCount = row?.count ?? 0;
  } catch (error) {
    return { ok: false, migrations: [], refCount: null, error: errorSnippet(error) };
  }

  let migrations: string[] = [];
  try {
    const result = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    migrations = result.results.map((row) => row.name);
  } catch {
    // Table doesn't exist in this environment — see HealthReport.migrations.
  }

  return { ok: true, migrations, refCount };
}

export async function handleHealth(context: RouteContext): Promise<Response> {
  const report = await checkHealth(context.env.DB);
  return Response.json(report, { status: report.ok ? 200 : 500 });
}
