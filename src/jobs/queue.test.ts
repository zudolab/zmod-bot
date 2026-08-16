import { describe, expect, it } from "vitest";
import {
  CLAIM_BATCH_SIZE,
  CLAIM_TTL_MS,
  DEFAULT_RETRY_POLICY,
  isValidTransition,
  JOB_STATE_TRANSITIONS,
  nextStateAfterFailure,
} from "./queue";
import type { JobState } from "../db/schema";

const ALL_STATES: JobState[] = ["pending", "composing", "delivering", "done", "failed", "dead"];

describe("isValidTransition", () => {
  it("matches JOB_STATE_TRANSITIONS exactly for every (from, to) pair", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        expect(isValidTransition(from, to)).toBe(JOB_STATE_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("allows the full happy path", () => {
    expect(isValidTransition("pending", "composing")).toBe(true);
    expect(isValidTransition("composing", "delivering")).toBe(true);
    expect(isValidTransition("delivering", "done")).toBe(true);
  });

  it("has no direct edge to dead except from failed", () => {
    for (const from of ALL_STATES) {
      if (from === "failed") continue;
      expect(isValidTransition(from, "dead")).toBe(false);
    }
    expect(isValidTransition("failed", "dead")).toBe(true);
  });

  it("rejects a skip from composing straight to done", () => {
    expect(isValidTransition("composing", "done")).toBe(false);
  });

  it("terminal states have no outgoing edges", () => {
    expect(isValidTransition("done", "pending")).toBe(false);
    expect(isValidTransition("dead", "pending")).toBe(false);
  });
});

describe("nextStateAfterFailure", () => {
  it("stays failed (retryable) below the ceiling", () => {
    expect(nextStateAfterFailure(1, DEFAULT_RETRY_POLICY)).toBe("failed");
    expect(nextStateAfterFailure(4, DEFAULT_RETRY_POLICY)).toBe("failed");
  });

  it("lands dead once attempts reaches the ceiling", () => {
    expect(nextStateAfterFailure(5, DEFAULT_RETRY_POLICY)).toBe("dead");
    expect(nextStateAfterFailure(6, DEFAULT_RETRY_POLICY)).toBe("dead");
  });

  it("honors a caller-supplied policy instead of a hardcoded 5", () => {
    const tighter = { maxAttempts: 2, backoffMs: () => 0 };
    expect(nextStateAfterFailure(1, tighter)).toBe("failed");
    expect(nextStateAfterFailure(2, tighter)).toBe("dead");
  });
});

describe("DEFAULT_RETRY_POLICY.backoffMs", () => {
  it("doubles from a 60s floor", () => {
    expect(DEFAULT_RETRY_POLICY.backoffMs(1)).toBe(120_000);
    expect(DEFAULT_RETRY_POLICY.backoffMs(2)).toBe(240_000);
    expect(DEFAULT_RETRY_POLICY.backoffMs(3)).toBe(480_000);
  });

  it("caps at 30 minutes", () => {
    expect(DEFAULT_RETRY_POLICY.backoffMs(10)).toBe(30 * 60_000);
    expect(DEFAULT_RETRY_POLICY.backoffMs(100)).toBe(30 * 60_000);
  });

  it("maxAttempts is 5, per issue #10's retry ceiling", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(5);
  });
});

describe("claim tuning constants", () => {
  it("CLAIM_TTL_MS is a 10-minute lease", () => {
    expect(CLAIM_TTL_MS).toBe(10 * 60_000);
  });

  it("CLAIM_BATCH_SIZE is 10, per issue #10", () => {
    expect(CLAIM_BATCH_SIZE).toBe(10);
  });
});
