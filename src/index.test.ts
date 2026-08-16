import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./env";

const fakeEnv = {} as Env;
const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("Worker entry routing", () => {
  it("GET /health responds 200 with no dependencies", async () => {
    const response = await worker.fetch(new Request("https://example.com/health"), fakeEnv, fakeCtx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
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

  // Interactions (issue #14) is still a stub — this proves the routing
  // wiring is correct without implementing any Slack logic here. Turns
  // into a real assertion once #14 fills in the handler.
  it("routes POST /slack/interactions to the interactions handler stub", async () => {
    await expect(
      worker.fetch(
        new Request("https://example.com/slack/interactions", { method: "POST" }),
        fakeEnv,
        fakeCtx,
      ),
    ).rejects.toThrow("not implemented: handleSlackInteractions");
  });
});
