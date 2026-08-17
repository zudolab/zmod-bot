import { describe, expect, it } from "vitest";
import type { FetchLike, SleepFn } from "../types";
import { postEphemeral, postMessage, postToResponseUrl, updateMessage, type SlackApiDeps } from "./api";
import { buildReplyMessagePayload } from "./blocks";

interface FakeResponseSpec {
  status: number;
  /** JSON body. Mutually exclusive with `text`. */
  body?: unknown;
  /** Raw text body (e.g. Slack's response_url "ok"). Mutually exclusive with `body`. */
  text?: string;
  headers?: Record<string, string>;
}

interface FakeFetchCall {
  url: string;
  init?: RequestInit;
}

function createFakeFetch(responses: FakeResponseSpec[]): { fetch: FetchLike; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const spec = responses[Math.min(index, responses.length - 1)];
    index++;
    if (!spec) throw new Error("createFakeFetch: no response spec configured");
    const responseText = spec.text ?? (spec.body !== undefined ? JSON.stringify(spec.body) : "");
    return new Response(responseText, { status: spec.status, headers: spec.headers });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function createFakeSleep(): { sleep: SleepFn; waits: number[] } {
  const waits: number[] = [];
  const sleep: SleepFn = async (ms: number) => {
    waits.push(ms);
  };
  return { sleep, waits };
}

function baseDeps(overrides: Partial<SlackApiDeps> & { fetch: FetchLike }): SlackApiDeps {
  return { botToken: "xoxb-test-token", ...overrides };
}

const payload = buildReplyMessagePayload({ replyText: "reply body", summaryText: "summary" });

describe("postMessage", () => {
  it("happy path: POSTs chat.postMessage with a Bearer token and returns the message identity", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: { ok: true, channel: "C1", ts: "111.222" } }]);

    const result = await postMessage(baseDeps({ fetch }), { channel: "C1", threadTs: "100.000", payload });

    expect(result).toEqual({ channel: "C1", ts: "111.222" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer xoxb-test-token");
    const sentBody = JSON.parse(String(init?.body));
    expect(sentBody.channel).toBe("C1");
    expect(sentBody.thread_ts).toBe("100.000");
    expect(sentBody.unfurl_links).toBe(false);
    expect(sentBody.unfurl_media).toBe(false);
  });

  it("throws a named error and never calls fetch when the bot token is missing", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: { ok: true, channel: "C1", ts: "1" } }]);

    await expect(postMessage(baseDeps({ fetch, botToken: "" }), { channel: "C1", payload })).rejects.toThrow(
      /SLACK_BOT_TOKEN/,
    );
    expect(calls).toHaveLength(0);
  });

  it("honors a 429 retry-after header via the injected sleep, then succeeds on retry", async () => {
    const { fetch, calls } = createFakeFetch([
      { status: 429, headers: { "retry-after": "1" } },
      { status: 200, body: { ok: true, channel: "C1", ts: "222.333" } },
    ]);
    const { sleep, waits } = createFakeSleep();

    const result = await postMessage(baseDeps({ fetch, sleep }), { channel: "C1", payload });

    expect(result).toEqual({ channel: "C1", ts: "222.333" });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it("throws once the 429 retry budget is exhausted", async () => {
    const { fetch, calls } = createFakeFetch([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 429, headers: { "retry-after": "0" } },
      { status: 429, headers: { "retry-after": "0" } },
    ]);
    const { sleep } = createFakeSleep();

    await expect(
      postMessage(baseDeps({ fetch, sleep, maxRetries: 2 }), { channel: "C1", payload }),
    ).rejects.toThrow(/retry exhausted/);
    expect(calls).toHaveLength(3); // initial attempt + 2 retries
  });

  it("rejects with the Slack error code interpolated when it is well-formed", async () => {
    const { fetch } = createFakeFetch([{ status: 200, body: { ok: false, error: "channel_not_found" } }]);

    await expect(postMessage(baseDeps({ fetch }), { channel: "C1", payload })).rejects.toThrow(
      /channel_not_found/,
    );
  });

  it("uses a generic placeholder — never the raw value — when the Slack error code is malformed", async () => {
    const malformed = "<script>alert(1)</script>";
    const { fetch } = createFakeFetch([{ status: 200, body: { ok: false, error: malformed } }]);

    let caught: Error | undefined;
    try {
      await postMessage(baseDeps({ fetch }), { channel: "C1", payload });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).not.toContain(malformed);
    expect(caught?.message).toBe("Slack Web API chat.postMessage was rejected");
  });

  it("retries a 5xx only when retryServerErrors is opted in, then succeeds", async () => {
    const { fetch, calls } = createFakeFetch([
      { status: 503 },
      { status: 200, body: { ok: true, channel: "C1", ts: "333.444" } },
    ]);
    const { sleep, waits } = createFakeSleep();

    const result = await postMessage(baseDeps({ fetch, sleep, retryServerErrors: true }), {
      channel: "C1",
      payload,
    });

    expect(result).toEqual({ channel: "C1", ts: "333.444" });
    expect(calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });

  it("fails fast on a 5xx when retryServerErrors is not set", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 503 }]);

    await expect(postMessage(baseDeps({ fetch }), { channel: "C1", payload })).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(1);
  });
});

describe("updateMessage", () => {
  it("POSTs chat.update with the message identity and resolves with no value on success", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: { ok: true, channel: "C1", ts: "1.1" } }]);

    await expect(
      updateMessage(baseDeps({ fetch }), { channel: "C1", ts: "1.1", payload }),
    ).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.update");
    const sentBody = JSON.parse(String(calls[0]?.init?.body));
    expect(sentBody.ts).toBe("1.1");
  });
});

describe("postEphemeral", () => {
  it("POSTs chat.postEphemeral and returns the ephemeral message ts", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, body: { ok: true, message_ts: "9.9" } }]);

    const result = await postEphemeral(baseDeps({ fetch }), { channel: "C1", user: "U1", payload });

    expect(result).toEqual({ ts: "9.9" });
    const sentBody = JSON.parse(String(calls[0]?.init?.body));
    expect(sentBody.user).toBe("U1");
  });
});

describe("postToResponseUrl", () => {
  it("POSTs the payload with no bot token and succeeds on Slack's plain-text \"ok\" body", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 200, text: "ok" }]);

    await expect(
      postToResponseUrl({ fetch }, { responseUrl: "https://hooks.slack.com/actions/T/1/abc", payload: { text: "done" } }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("honors a 429 retry-after via injected sleep before succeeding", async () => {
    const { fetch, calls } = createFakeFetch([{ status: 429, headers: { "retry-after": "2" } }, { status: 200, text: "ok" }]);
    const { sleep, waits } = createFakeSleep();

    await postToResponseUrl({ fetch, sleep }, { responseUrl: "https://hooks.slack.com/actions/T/1/abc", payload: { text: "done" } });

    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });
});
