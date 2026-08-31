import { afterEach, describe, expect, it } from "vitest";
import { createMockD1 } from "./db/test-support";
import { checkHealth, handleHealth } from "./health";
import type { RouteContext } from "./router";
import type { Env } from "./env";
import { createTestEnv, type TestEnvHandle } from "../tests/helpers/test-env";
import migration0002 from "../migrations/0002_seed_product_refs.sql?raw";

describe("checkHealth", () => {
  it("reports ok, an empty migrations list, and refCount 0 against a bare mock D1", async () => {
    const db = createMockD1();

    const report = await checkHealth(db);

    // createMockD1 evaluates no SQL at all (see src/db/test-support.ts) —
    // every query answers with its empty default, so both the count and
    // the migrations scan come back empty rather than throwing.
    expect(report).toEqual({
      ok: true,
      migrations: [],
      refCount: 0,
      policySource: { source: "compiled", ageMs: 0, configured: false },
    });
  });

  it("reports ok: false with a null refCount when the D1 round-trip itself throws", async () => {
    const db = createMockD1();
    db.prepare = () => {
      throw new Error("simulated D1 outage");
    };

    const report = await checkHealth(db);

    expect(report.ok).toBe(false);
    expect(report.refCount).toBeNull();
    expect(report.migrations).toEqual([]);
    expect(report.policySource).toEqual({ source: "compiled", ageMs: 0, configured: false });
    expect(report.error).toContain("simulated D1 outage");
  });

  describe("against a real Miniflare D1 binding", () => {
    let env: TestEnvHandle | undefined;

    afterEach(async () => {
      await env?.dispose();
      env = undefined;
    });

    it("counts the seeded corpus and degrades the migrations list gracefully (no d1_migrations table)", async () => {
      env = await createTestEnv({ migrations: [migration0002] });

      const report = await checkHealth(env.db);

      // Applied via db.exec() directly (see tests/helpers/test-env.ts),
      // never through `wrangler d1 migrations apply` — so no
      // `d1_migrations` bookkeeping table exists here. That absence must
      // not make the check unhealthy: the refCount round-trip below
      // already proves the schema is live.
      expect(report.ok).toBe(true);
      expect(report.migrations).toEqual([]);
      expect(report.refCount).toBe(34);
    });

    it("reads real migration names once a d1_migrations table exists (simulating `wrangler d1 migrations apply`)", async () => {
      env = await createTestEnv({ migrations: [migration0002] });
      await env.db.exec(
        "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
      );
      await env.db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind("0001_init.sql").run();
      await env.db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind("0002_seed_product_refs.sql").run();

      const report = await checkHealth(env.db);

      expect(report.ok).toBe(true);
      expect(report.migrations).toEqual(["0001_init.sql", "0002_seed_product_refs.sql"]);
      expect(report.refCount).toBe(34);
    });
  });
});

describe("handleHealth", () => {
  it("responds 200 with the report's JSON body when the round-trip succeeds", async () => {
    const context: RouteContext = {
      request: new Request("https://example.com/health"),
      env: { DB: createMockD1() } as unknown as Env,
      ctx: { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
      params: {},
    };

    const response = await handleHealth(context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      migrations: [],
      refCount: 0,
      policySource: { source: "compiled", ageMs: 0, configured: false },
    });
  });

  it("keeps healthy D1 at 200 when configured stash is unreachable", async () => {
    const context: RouteContext = {
      request: new Request("https://example.com/health"),
      env: {
        DB: createMockD1(),
        STASH_BASE_URL: "https://stash.example.test",
        STASH_NAME: "policy-live",
        STASH_READ_TOKEN: `zhs_${"r".repeat(43)}`,
      } as unknown as Env,
      ctx: { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
      params: {},
    };

    const response = await handleHealth(context, {
      fetch: async () => { throw new Error("configured stash unreachable"); },
      now: () => new Date(10_000),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      migrations: [],
      refCount: 0,
      policySource: { source: "compiled", ageMs: 0, configured: true },
    });
  });

  it("responds 500 when the D1 round-trip fails", async () => {
    const db = createMockD1();
    db.prepare = () => {
      throw new Error("simulated D1 outage");
    };
    const context: RouteContext = {
      request: new Request("https://example.com/health"),
      env: { DB: db } as unknown as Env,
      ctx: { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
      params: {},
    };

    const response = await handleHealth(context);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("simulated D1 outage");
  });
});
