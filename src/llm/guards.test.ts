/**
 * Unit tests for the three guards in isolation. The orchestration around
 * them — which trip produces which fallback, and that the fallback is
 * byte-identical to the deterministic render — is
 * tests/compose/compose.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockD1 } from "../db/test-support";
import {
  checkBudgetGuard,
  checkOutputGuard,
  classifyCallFailure,
  countComposeCallsToday,
  DeadlineExceededError,
  extractUrls,
  PRE_CALL_FALLBACK_REASONS,
  utcDayStartMs,
  withDeadline,
  type OutputGuardInput,
} from "./guards";
import { LlmProviderError } from "./provider";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const at = (iso: string) => () => new Date(iso);

describe("the budget guard", () => {
  /** Answers the COUNT query with `calls`, and records the bindings it was asked with. */
  function dbReturning(calls: number) {
    return createMockD1({ onQuery: () => ({ results: [{ calls }] }) });
  }

  it("floors the window to UTC midnight, not the local day", () => {
    // 09:00 JST on the 18th is 00:00 UTC on the 18th; one minute earlier
    // is still the 17th in UTC. A local-day floor would put both in the
    // same bucket.
    expect(utcDayStartMs(new Date("2026-08-18T00:00:00Z"))).toBe(Date.UTC(2026, 7, 18));
    expect(utcDayStartMs(new Date("2026-08-17T23:59:00Z"))).toBe(Date.UTC(2026, 7, 17));
  });

  it("passes below the cap and trips at it", async () => {
    const under = await checkBudgetGuard({ db: dbReturning(299), now: at("2026-08-18T05:00:00Z") }, {
      task: "compose",
      cap: 300,
    });
    expect(under).toBeNull();

    const over = await checkBudgetGuard({ db: dbReturning(300), now: at("2026-08-18T05:00:00Z") }, {
      task: "compose",
      cap: 300,
    });
    expect(over).toEqual({ guard: "budget", reason: "budget_exceeded", detail: expect.stringContaining("300/300") });
  });

  it("counts only today's rows for this task, and excludes the pre-call fallbacks", async () => {
    const db = dbReturning(0);
    await countComposeCallsToday({ db, now: at("2026-08-18T05:00:00Z") }, "compose");

    const call = db.calls[0]!;
    expect(call.query).toContain("FROM usage_log");
    // task, the UTC-day window (both ends), then one binding per excluded reason.
    expect(call.bindings).toEqual([
      "compose",
      Date.UTC(2026, 7, 18),
      Date.UTC(2026, 7, 19),
      ...PRE_CALL_FALLBACK_REASONS,
    ]);
  });

  it("reads zero rather than NaN when the count query returns nothing", async () => {
    const db = createMockD1();
    expect(await countComposeCallsToday({ db, now: at("2026-08-18T05:00:00Z") }, "compose")).toBe(0);
  });
});

describe("the call deadline", () => {
  it("returns the work when it settles first, and disarms the timer", async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearTimeout");

    await expect(withDeadline(Promise.resolve("composed"), 8_000)).resolves.toBe("composed");
    expect(clear).toHaveBeenCalled();
    // Nothing left armed: advancing past the deadline fires no callback.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with DeadlineExceededError when the work does not settle in time", async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise<string>(() => {}), 8_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError);

    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  /**
   * The regression this exists for: when the deadline wins, the work
   * promise is still pending and its later rejection has no handler
   * unless withDeadline parked one on it. In a Worker that is an
   * unhandled rejection charged to whatever request is running.
   */
  it("leaves no unhandled rejection when the losing work rejects afterwards", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (event: { reason?: unknown }) => unhandled.push(event.reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      let failLate: (error: Error) => void = () => {};
      const work = new Promise<string>((_, reject) => {
        failLate = reject;
      });
      const pending = withDeadline(work, 8_000);
      const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineExceededError);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;

      failLate(new Error("provider answered long after we stopped waiting"));
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not disarm a timer it never armed when the work is already settled", async () => {
    // Guards the `finally` branch: clearTimeout(undefined) would be a
    // TypeError under the same `finally` written without the check.
    await expect(withDeadline(Promise.reject(new Error("boom")), 8_000)).rejects.toThrow("boom");
  });
});

describe("classifyCallFailure", () => {
  it("separates a timeout, a rate limit and a plain provider error", () => {
    expect(classifyCallFailure(new DeadlineExceededError(8_000))).toEqual({
      guard: "call",
      reason: "timeout",
      detail: "deadline 8000ms exceeded",
    });
    expect(classifyCallFailure(new LlmProviderError("claude", "HTTP 429: slow down", { status: 429 }))).toEqual({
      guard: "call",
      reason: "rate_limited",
      detail: "provider returned HTTP 429",
    });
    expect(classifyCallFailure(new LlmProviderError("claude", "HTTP 500: upstream", { status: 500 }))).toEqual({
      guard: "call",
      reason: "provider_error",
      detail: "LlmProviderError HTTP 500",
    });
  });

  it("never puts the error's message in the detail", () => {
    // A provider error message can carry an upstream body, and on a 200
    // path that body is the model's completion — customer-facing text.
    const secret = "お客様のお名前とご住所を確認いたしました";
    for (const error of [
      new LlmProviderError("claude", `HTTP 500: ${secret}`, { status: 500 }),
      new Error(secret),
      secret,
    ]) {
      expect(classifyCallFailure(error).detail).not.toContain(secret);
    }
  });
});

describe("extractUrls", () => {
  it("stops at the Japanese punctuation and brackets a link is written against", () => {
    expect(extractUrls("紹介記事:\nhttps://takazudomodular.com/products/oxi-one/。次に")).toEqual([
      "https://takazudomodular.com/products/oxi-one/",
    ]);
    expect(extractUrls("（https://youtu.be/abc123）を参照")).toEqual(["https://youtu.be/abc123"]);
  });

  it("keeps a trailing slash, which is part of the path", () => {
    expect(extractUrls("https://takazudomodular.com/s/discord/")).toEqual([
      "https://takazudomodular.com/s/discord/",
    ]);
  });

  it("de-duplicates while preserving order", () => {
    expect(extractUrls("https://a.example/x\nhttps://b.example/y\nhttps://a.example/x")).toEqual([
      "https://a.example/x",
      "https://b.example/y",
    ]);
  });
});

describe("the output guard", () => {
  const GUIDE = "https://takazudomodular.com/products/oxi-one-intro/";
  const NOTICE = "なお、こちらのレールは構造上やや折れやすい部分がございます。";

  const base = (over: Partial<OutputGuardInput> = {}): OutputGuardInput => ({
    text: `紹介記事はこちらです。\n\nTakazudo Modular: 紹介記事:\n${GUIDE}\n\n${NOTICE}`,
    stopReason: "end",
    truncated: false,
    expectedUrls: [GUIDE],
    requiredLiterals: [NOTICE],
    fixedClauses: ["ご購入ありがとうございます。"],
    withheldProse: [],
    ...over,
  });

  it("passes well-formed output", () => {
    expect(checkOutputGuard(base())).toBeNull();
  });

  it("trips on a refusal before it looks at the text", () => {
    expect(checkOutputGuard(base({ stopReason: "refusal", text: "" }))).toEqual({
      guard: "output",
      reason: "empty_response",
      detail: "provider reported a refusal",
    });
  });

  it("trips on the provider's own truncation flag, not on how the text reads", () => {
    // The text below is a complete, well-formed section. Truncation is
    // read off LlmResult (a cap hit can stop on a clean boundary), which
    // is why this must still trip.
    const trip = checkOutputGuard(base({ truncated: true, stopReason: "max_tokens" }));
    expect(trip).toMatchObject({ guard: "output", reason: "truncated" });
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   \n\n  "],
  ])("trips on %s output", (_name, text) => {
    expect(checkOutputGuard(base({ text }))).toMatchObject({ reason: "empty_response" });
  });

  it("trips on an invented URL", () => {
    const text = `${base().text}\n\n公式デモ:\nhttps://youtu.be/haLLucinated`;
    expect(checkOutputGuard(base({ text }))).toMatchObject({ guard: "output", reason: "url_mismatch" });
  });

  it("trips on a dropped URL", () => {
    const text = `紹介記事をご参照ください。\n\n${NOTICE}`;
    expect(checkOutputGuard(base({ text }))).toMatchObject({ guard: "output", reason: "url_mismatch" });
  });

  it("trips on a URL that is subtly altered rather than invented outright", () => {
    const text = base().text.replace("oxi-one-intro", "oxi-one-intro-v2");
    expect(checkOutputGuard(base({ text }))).toMatchObject({ reason: "url_mismatch" });
  });

  it("trips when a literal block is paraphrased", () => {
    const text = base().text.replace(NOTICE, "レールは折れやすいのでご注意ください。");
    expect(checkOutputGuard(base({ text }))).toMatchObject({ guard: "output", reason: "schema_invalid" });
  });

  it("trips when the model restates a fixed clause the skeleton already supplies", () => {
    const text = `ご購入ありがとうございます。\n${base().text}`;
    expect(checkOutputGuard(base({ text }))).toMatchObject({ reason: "schema_invalid" });
  });

  it("trips when editorial guidance leaks into the customer's message", () => {
    const note = "so do NOT add an Extra Resources section to the message — it makes the message verbose";
    expect(checkOutputGuard(base({ text: `${base().text}\n\n${note}`, withheldProse: [note] }))).toMatchObject({
      reason: "schema_invalid",
    });
  });

  it("does not trip on a short guidance fragment that legitimate text could reuse", () => {
    // "完成品。" is 4 chars — vetoing on it would fall back for half the
    // corpus. Only a distinctive span counts as a leak.
    expect(checkOutputGuard(base({ withheldProse: ["完成品。"] }))).toBeNull();
  });

  it("trips on a repetition loop", () => {
    const text = `${base().text}\n${Array(5).fill("ご確認ください。").join("\n")}`;
    expect(checkOutputGuard(base({ text }))).toMatchObject({ reason: "schema_invalid" });
  });

  it("never puts the model's text in the detail", () => {
    const trip = checkOutputGuard(base({ text: `${base().text}\n\nhttps://evil.example/お客様の住所` }));
    expect(trip?.detail).not.toContain("evil.example");
    expect(trip?.detail).toBe("1 invented, 0 missing of 1");
  });
});
