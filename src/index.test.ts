import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./env";
import { createMockD1 } from "./db/test-support";

const fakeEnv = {} as Env;
const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("Worker entry routing", () => {
  // Issue #12 wired /health to a real D1 round-trip (src/health.ts) — full
  // behavior coverage (the round-trip itself, the migrations-table
  // degrade path) lives in src/health.test.ts. This is only a
  // routing-wiring smoke test, so it supplies just enough Env (a bare
  // mock D1, no seeded rows) to reach the real handler.
  it("GET /health responds 200 with a D1 round-trip report", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/health"),
      { DB: createMockD1() } as unknown as Env,
      fakeCtx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, migrations: [], refCount: 0 });
  });

  it("404s an unregistered path", async () => {
    const response = await worker.fetch(new Request("https://example.com/nope"), fakeEnv, fakeCtx);

    expect(response.status).toBe(404);
  });

  // Issue #6 implemented the events handler — full behavior coverage
  // (signature verification, filtering, durable intake) lives in
  // src/slack/events.test.ts. This is only a routing-wiring smoke test:
  // reaching the real handler with a bare fakeEnv (no SLACK_SIGNING_SECRET
  // configured) surfaces its deployment-error path, proving this route is
  // no longer the stub.
  it("routes POST /slack/events to the real events handler", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/slack/events", { method: "POST" }),
      fakeEnv,
      fakeCtx,
    );

    expect(response.status).toBe(500);
  });

  // Issue #14 implemented the interactions handler — full behavior
  // coverage (signature verification, idempotency, admin gating) lives
  // in src/slack/interactions.test.ts. This is only a routing-wiring
  // smoke test, mirroring the /slack/events test above it: reaching the
  // real handler with a bare fakeEnv (no SLACK_SIGNING_SECRET configured)
  // surfaces its deployment-error path, proving this route is no longer
  // the stub.
  it("routes POST /slack/interactions to the real interactions handler", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/slack/interactions", { method: "POST" }),
      fakeEnv,
      fakeCtx,
    );

    expect(response.status).toBe(500);
  });
});
