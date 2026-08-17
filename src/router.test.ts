import { describe, expect, it } from "vitest";
import { Router } from "./router";
import type { Env } from "./env";

const fakeEnv = {} as Env;
const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("Router", () => {
  it("dispatches to the handler matching method + path", async () => {
    const router = new Router().get("/health", () => Response.json({ ok: true }));

    const response = await router.handle(new Request("https://example.com/health"), fakeEnv, fakeCtx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("passes named path params through", async () => {
    const router = new Router().get("/refs/:slug", ({ params }) =>
      Response.json({ slug: params.slug }),
    );

    const response = await router.handle(new Request("https://example.com/refs/oxi-one"), fakeEnv, fakeCtx);

    expect(await response.json()).toEqual({ slug: "oxi-one" });
  });

  it("does not match a route registered for a different method", async () => {
    const router = new Router().post("/slack/events", () => new Response("ok"));

    const response = await router.handle(new Request("https://example.com/slack/events"), fakeEnv, fakeCtx);

    expect(response.status).toBe(404);
  });

  it("returns a 404 for an unregistered path", async () => {
    const router = new Router();

    const response = await router.handle(new Request("https://example.com/nope"), fakeEnv, fakeCtx);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found", path: "/nope" });
  });
});
