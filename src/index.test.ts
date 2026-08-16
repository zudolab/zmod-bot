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

  // These two prove the routing wiring is correct — reaching the intended
  // stub handler — without implementing any Slack logic here. Each turns
  // into a real assertion once its owning sub-task (#6, #14) fills in the
  // handler.
  it("routes POST /slack/events to the events handler stub", async () => {
    await expect(
      worker.fetch(new Request("https://example.com/slack/events", { method: "POST" }), fakeEnv, fakeCtx),
    ).rejects.toThrow("not implemented: handleSlackEvents");
  });

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
