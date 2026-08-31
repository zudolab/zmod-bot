import { describe, expect, it } from "vitest";
import { createMockD1, type MockD1QueryHandler } from "../db/test-support";
import type { Env } from "../env";
import type { FetchLike, WaitUntilFn } from "../types";
import { classifyJobKind, handleSlackEventsWithDeps, isAllowedChannel, type SlackEventsDeps } from "./events";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const ALLOWED_CHANNEL = "C_ALLOWED";
const NOW_SECONDS = 1_760_000_000;
const NOW_MS = NOW_SECONDS * 1_000;

const encoder = new TextEncoder();

/**
 * Computes a valid signature for building otherwise-correct requests in
 * these handler-branching tests. This is NOT the "sign-then-verify round
 * trip" CLAUDE.md warns against — that trap is specifically about
 * proving verify.ts's own signature math is correct, which is already
 * pinned to independently-computed known-answer vectors in
 * src/slack/verify.test.ts. Here the signature math is a trusted given;
 * what's under test is events.ts's branching on top of it.
 */
async function computeSignature(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

async function makeSignedRequest(
  body: string,
  overrides: { timestamp?: string; signature?: string } = {},
): Promise<Request> {
  const timestamp = overrides.timestamp ?? String(NOW_SECONDS);
  const signature = overrides.signature ?? (await computeSignature(body, timestamp));
  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    body,
  });
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_ALLOWED_CHANNEL_IDS: ALLOWED_CHANNEL,
    SLACK_ADMIN_USER_IDS: "",
    ...overrides,
  } as Env;
}

function makeWaitUntil(): { waitUntil: WaitUntilFn; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  const waitUntil: WaitUntilFn = (promise) => {
    scheduled.push(promise);
  };
  return { waitUntil, scheduled };
}

function makeDeps(overrides: Pick<SlackEventsDeps, "db" | "waitUntil"> & Partial<SlackEventsDeps>): SlackEventsDeps {
  return {
    now: () => new Date(NOW_MS),
    fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
    ...overrides,
  };
}

function appMentionEventCallback(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "event_callback",
    event_id: "Ev_1",
    event: {
      type: "app_mention",
      channel: ALLOWED_CHANNEL,
      user: "U_HUMAN",
      text: "<@U_BOT> OXI Coral 明後日",
      ts: "1760000000.000100",
      event_ts: "1760000000.000100",
      ...overrides,
    },
  };
}

describe("handleSlackEventsWithDeps", () => {
  describe("signature gate (comes before any JSON.parse or branching)", () => {
    it("401s an unsigned url_verification POST and does not echo the challenge", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "should-not-leak" });
      const request = new Request("https://example.com/slack/events", { method: "POST", body });
      const { waitUntil } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: createMockD1(), waitUntil }));

      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).not.toContain("should-not-leak");
    });

    it("401s a url_verification POST with a wrong signature", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "should-not-leak" });
      const request = await makeSignedRequest(body, { signature: `v0=${"0".repeat(64)}` });
      const { waitUntil } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: createMockD1(), waitUntil }));

      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("should-not-leak");
    });

    it("echoes the challenge back once the signature is valid", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "real-challenge" });
      const request = await makeSignedRequest(body);
      const { waitUntil } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: createMockD1(), waitUntil }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ challenge: "real-challenge" });
    });

    it("500s when SLACK_SIGNING_SECRET is not configured — a deployment error, distinct from a 401", async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "x" });
      const request = new Request("https://example.com/slack/events", { method: "POST", body });
      const { waitUntil } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(
        request,
        baseEnv({ SLACK_SIGNING_SECRET: "" }),
        makeDeps({ db: createMockD1(), waitUntil }),
      );

      expect(response.status).toBe(500);
    });

    it("400s a validly-signed request whose body is not valid JSON", async () => {
      const body = "not json";
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1();
      const { waitUntil } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(400);
      expect(mockDb.calls).toHaveLength(0);
    });

    it("400s a validly-signed request whose JSON body is not an object", async () => {
      const body = JSON.stringify(["not", "an", "object"]);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1();
      const { waitUntil } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(400);
      expect(mockDb.calls).toHaveLength(0);
    });
  });

  describe("rejection paths — every one returns 200 with zero persistence", () => {
    const cases: Array<{ name: string; env?: Partial<Env>; eventOverrides: Record<string, unknown> }> = [
      { name: "bot_id present", eventOverrides: { bot_id: "B_SOME_BOT" } },
      { name: "self user (event.user === SLACK_BOT_USER_ID)", eventOverrides: { user: BOT_USER_ID } },
      { name: "channel not in the allow-list", eventOverrides: { channel: "C_OTHER" } },
      { name: "unhandled subtype", eventOverrides: { subtype: "message_changed" } },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        const payload = appMentionEventCallback(testCase.eventOverrides);
        const body = JSON.stringify(payload);
        const request = await makeSignedRequest(body);
        const mockDb = createMockD1();
        const { waitUntil, scheduled } = makeWaitUntil();

        const response = await handleSlackEventsWithDeps(
          request,
          baseEnv(testCase.env),
          makeDeps({ db: mockDb, waitUntil }),
        );

        expect(response.status).toBe(200);
        expect(mockDb.calls).toHaveLength(0);
        expect(scheduled).toHaveLength(0);
      });
    }

    it("wrong event type (not app_mention)", async () => {
      const payload = {
        type: "event_callback",
        event_id: "Ev_reaction",
        event: { type: "reaction_added", user: "U_HUMAN", reaction: "+1" },
      };
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1();
      const { waitUntil, scheduled } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(200);
      expect(mockDb.calls).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });

    it("missing event_id", async () => {
      const payload = appMentionEventCallback();
      delete (payload as Record<string, unknown>).event_id;
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1();
      const { waitUntil, scheduled } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(200);
      expect(mockDb.calls).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });

    it("a non-event_callback, non-url_verification top-level type (e.g. app_rate_limited)", async () => {
      const body = JSON.stringify({ type: "app_rate_limited" });
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1();
      const { waitUntil, scheduled } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(200);
      expect(mockDb.calls).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });

    it("an app_mention event missing a required field (text)", async () => {
      const payload = appMentionEventCallback();
      delete (payload.event as Record<string, unknown>).text;
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1();
      const { waitUntil, scheduled } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(200);
      expect(mockDb.calls).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });
  });

  describe("durable intent before the ack", () => {
    function newEventOnQuery(): MockD1QueryHandler {
      return (call) => {
        if (call.query.includes("INSERT INTO slack_event_receipts")) {
          return { meta: { changes: 1 } };
        }
        if (call.query.includes("INSERT INTO jobs")) {
          return { meta: { changes: 1, last_row_id: 42 } };
        }
        return null;
      };
    }

    it("records a new event, acks 200, and schedules immediate delivery", async () => {
      const payload = appMentionEventCallback();
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1({ onQuery: newEventOnQuery() });
      const { waitUntil, scheduled } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(200);
      expect(mockDb.calls.length).toBeGreaterThan(0);
      expect(scheduled).toHaveLength(1);
      // The scheduled delivery pass must never reject out of waitUntil —
      // runDeliveryPass (issue #10) is still a stub that always throws,
      // and events.ts is responsible for catching that internally.
      await expect(scheduled[0]).resolves.toBeUndefined();
    });

    it("classifies job kind from the command word and threads it into the jobs INSERT", async () => {
      const payload = appMentionEventCallback({ text: "<@U_BOT> polish this text please" });
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1({ onQuery: newEventOnQuery() });
      const { waitUntil } = makeWaitUntil();

      await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      const jobInsert = mockDb.calls.find((call) => call.query.includes("INSERT INTO jobs"));
      expect(jobInsert?.bindings).toContain("polish");
    });

    it("an admin policy mention atomically records the receipt and policy_update job before the 200 ack", async () => {
      const payload = appMentionEventCallback({ text: "<@U_BOT> policy 語調を簡潔にする", user: "U_ADMIN" });
      const request = await makeSignedRequest(JSON.stringify(payload));
      const mockDb = createMockD1({ onQuery: newEventOnQuery() });
      const originalBatch = mockDb.batch.bind(mockDb);
      let batchCalls = 0;
      mockDb.batch = async (statements) => {
        batchCalls++;
        expect(statements).toHaveLength(2);
        return originalBatch(statements);
      };
      const { waitUntil } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(
        request,
        baseEnv({ SLACK_ADMIN_USER_IDS: "U_ADMIN", SLACK_BOT_TOKEN: "xoxb-test" }),
        makeDeps({ db: mockDb, waitUntil }),
      );

      expect(response.status).toBe(200);
      expect(batchCalls).toBe(1);
      expect(mockDb.calls.find((call) => call.query.includes("INSERT INTO jobs"))?.bindings).toContain("policy_update");
    });

    it("a non-admin policy mention gets a polite refusal and no receipt or job row", async () => {
      const payload = appMentionEventCallback({ text: "<@U_BOT> policy 語調を簡潔にする", user: "U_NOT_ADMIN" });
      const request = await makeSignedRequest(JSON.stringify(payload));
      const mockDb = createMockD1();
      const { waitUntil, scheduled } = makeWaitUntil();
      const slackBodies: Record<string, unknown>[] = [];
      const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        slackBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, channel: ALLOWED_CHANNEL, ts: "1760000000.1" });
      }) as FetchLike;

      const response = await handleSlackEventsWithDeps(
        request,
        baseEnv({ SLACK_ADMIN_USER_IDS: "U_ADMIN", SLACK_BOT_TOKEN: "xoxb-test" }),
        makeDeps({ db: mockDb, waitUntil, fetch }),
      );
      await Promise.all(scheduled);

      expect(response.status).toBe(200);
      expect(mockDb.calls).toHaveLength(0);
      expect(slackBodies).toHaveLength(1);
      expect(JSON.stringify(slackBodies[0])).toContain("管理者権限");
    });

    it.each(["policy history", "policy rollback 2"])("applies the admin gate to stash-only %s", async (command) => {
      const payload = appMentionEventCallback({ text: `<@U_BOT> ${command}`, user: "U_NOT_ADMIN" });
      const request = await makeSignedRequest(JSON.stringify(payload));
      const mockDb = createMockD1();
      const { waitUntil, scheduled } = makeWaitUntil();
      const slackBodies: Record<string, unknown>[] = [];
      const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        slackBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, channel: ALLOWED_CHANNEL, ts: "1760000000.1" });
      }) as FetchLike;

      const response = await handleSlackEventsWithDeps(
        request,
        baseEnv({ SLACK_ADMIN_USER_IDS: "U_ADMIN", SLACK_BOT_TOKEN: "xoxb-test" }),
        makeDeps({ db: mockDb, waitUntil, fetch }),
      );
      await Promise.all(scheduled);

      expect(response.status).toBe(200);
      expect(mockDb.calls).toHaveLength(0);
      expect(JSON.stringify(slackBodies[0])).toContain("管理者権限");
    });

    it("defaults thread_ts to event.ts when thread_ts is absent", async () => {
      const payload = appMentionEventCallback();
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1({ onQuery: newEventOnQuery() });
      const { waitUntil } = makeWaitUntil();

      await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      const jobInsert = mockDb.calls.find((call) => call.query.includes("INSERT INTO jobs"));
      expect(jobInsert?.bindings).toContain("1760000000.000100");
    });

    it("uses event.thread_ts when present", async () => {
      const payload = appMentionEventCallback({ thread_ts: "1759999999.000000" });
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1({ onQuery: newEventOnQuery() });
      const { waitUntil } = makeWaitUntil();

      await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      const jobInsert = mockDb.calls.find((call) => call.query.includes("INSERT INTO jobs"));
      expect(jobInsert?.bindings).toContain("1759999999.000000");
    });

    it("a redelivered event_id inserts nothing further and schedules nothing", async () => {
      const payload = appMentionEventCallback();
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      // Simulate a replay: the receipt insert reports zero changes
      // (ON CONFLICT DO NOTHING already fired for this event_id).
      const mockDb = createMockD1({
        onQuery: (call) => {
          if (call.query.includes("INSERT INTO slack_event_receipts")) return { meta: { changes: 0 } };
          if (call.query.includes("INSERT INTO jobs")) return { meta: { changes: 0 } };
          return null;
        },
      });
      const { waitUntil, scheduled } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(200);
      expect(scheduled).toHaveLength(0);
    });

    it("a forced DB failure returns 500, not 200", async () => {
      const payload = appMentionEventCallback();
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1({
        onQuery: () => {
          throw new Error("simulated D1 outage");
        },
      });
      const { waitUntil, scheduled } = makeWaitUntil();

      const response = await handleSlackEventsWithDeps(request, baseEnv(), makeDeps({ db: mockDb, waitUntil }));

      expect(response.status).toBe(500);
      expect(scheduled).toHaveLength(0);
    });

    it("returns 500 when the db.batch() write loses the race against the 2s budget", async () => {
      const payload = appMentionEventCallback();
      const body = JSON.stringify(payload);
      const request = await makeSignedRequest(body);
      const mockDb = createMockD1({ onQuery: newEventOnQuery() });
      // Never resolves — proves the budget race, not the DB call, decides the outcome.
      mockDb.batch = () => new Promise(() => {});
      const { waitUntil, scheduled } = makeWaitUntil();
      const immediateSleep = async () => {};

      const response = await handleSlackEventsWithDeps(
        request,
        baseEnv(),
        makeDeps({ db: mockDb, waitUntil, sleep: immediateSleep }),
      );

      expect(response.status).toBe(500);
      expect(scheduled).toHaveLength(0);
    });
  });
});

describe("isAllowedChannel", () => {
  it("allows every channel when SLACK_ALLOWED_CHANNEL_IDS is empty", () => {
    expect(isAllowedChannel(baseEnv({ SLACK_ALLOWED_CHANNEL_IDS: "" }), "C_ANYTHING")).toBe(true);
  });

  it("allows a channel present in the comma-separated list", () => {
    const env = baseEnv({ SLACK_ALLOWED_CHANNEL_IDS: "C1, C2 ,C3" });
    expect(isAllowedChannel(env, "C2")).toBe(true);
  });

  it("rejects a channel absent from a non-empty list", () => {
    const env = baseEnv({ SLACK_ALLOWED_CHANNEL_IDS: "C1,C2" });
    expect(isAllowedChannel(env, "C_OTHER")).toBe(false);
  });
});

describe("classifyJobKind", () => {
  it("classifies 'polish' as the command word", () => {
    expect(classifyJobKind("<@U_BOT> polish this text")).toBe("polish");
  });

  it("classifies 'ref' as the command word", () => {
    expect(classifyJobKind("<@U_BOT> ref show oxi-one")).toBe("ref");
  });

  it("classifies 'policy' as policy_update", () => {
    expect(classifyJobKind("<@U_BOT> policy 語調を変更")).toBe("policy_update");
    expect(classifyJobKind("<@U_BOT> policy history")).toBe("policy_update");
    expect(classifyJobKind("<@U_BOT> policy rollback 12")).toBe("policy_update");
    expect(classifyJobKind("<@U_BOT> policy\t語調を変更")).toBe("reply");
  });

  it("classifies everything else as 'reply'", () => {
    expect(classifyJobKind("<@U_BOT> OXI Coral 明後日")).toBe("reply");
  });

  it("is case-insensitive on the command word", () => {
    expect(classifyJobKind("<@U_BOT> POLISH this")).toBe("polish");
  });

  it("defaults to 'reply' when there is no text after the mention", () => {
    expect(classifyJobKind("<@U_BOT>")).toBe("reply");
  });
});
