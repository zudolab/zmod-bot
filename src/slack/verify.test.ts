import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./verify";

/**
 * Known-answer vectors, independent of the code under test — both
 * computed with `node:crypto`, never by this codebase's own verifier
 * (a sign-then-verify round trip passes even when the base string is
 * built wrong, since both halves would share the same bug). See issue
 * #6 for the exact regeneration command:
 *
 *   node -e 'const c=require("crypto");
 *     console.log("v0="+c.createHmac("sha256",SECRET).update("v0:"+TS+":"+BODY,"utf8").digest("hex"))'
 */
const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

// Vector 1: Slack's own documented example (ASCII body).
const VECTOR_1_TIMESTAMP = "1531420618";
const VECTOR_1_BODY = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J";
const VECTOR_1_SIGNATURE = "v0=bca5eef5dd737ed259b428b18cd24f679baa18c3fc5f1cb2a6ac9f03e717969a";

// Vector 2: UTF-8 Japanese JSON body — the encoding case this bot
// actually receives on every real payload. Not decorative: an
// ASCII-only vector passes even when the base string is encoded wrong.
const VECTOR_2_TIMESTAMP = "1760000000";
const VECTOR_2_BODY =
  '{"type":"event_callback","event":{"type":"app_mention","text":"<@U0BOT> OXI Coral 明後日"}}';
const VECTOR_2_SIGNATURE = "v0=352cb7c0a2c17c1555f376ea03143139449050338df9e18af864e3e37aad0b37";

function nowAt(timestampSeconds: string): () => Date {
  const seconds = Number(timestampSeconds);
  return () => new Date(seconds * 1000);
}

describe("verifySlackSignature", () => {
  it("accepts Slack's own documented known-answer vector (ASCII body)", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_1_TIMESTAMP,
      signature: VECTOR_1_SIGNATURE,
      body: VECTOR_1_BODY,
      now: nowAt(VECTOR_1_TIMESTAMP),
    });

    expect(result).toBe(true);
  });

  it("accepts a known-answer vector with a UTF-8 Japanese body (the encoding this bot actually receives)", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_2_TIMESTAMP,
      signature: VECTOR_2_SIGNATURE,
      body: VECTOR_2_BODY,
      now: nowAt(VECTOR_2_TIMESTAMP),
    });

    expect(result).toBe(true);
  });

  it("rejects the Japanese-body vector once the body is tampered with", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_2_TIMESTAMP,
      signature: VECTOR_2_SIGNATURE,
      body: VECTOR_2_BODY + " ",
      now: nowAt(VECTOR_2_TIMESTAMP),
    });

    expect(result).toBe(false);
  });

  it("rejects the Japanese-body vector's signature against a shifted timestamp (proves the timestamp is part of the signed base string)", async () => {
    const shiftedTimestamp = String(Number(VECTOR_2_TIMESTAMP) + 1);
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: shiftedTimestamp,
      signature: VECTOR_2_SIGNATURE,
      body: VECTOR_2_BODY,
      now: nowAt(shiftedTimestamp),
    });

    expect(result).toBe(false);
  });

  it("accepts a timestamp exactly at the 300s window boundary", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_2_TIMESTAMP,
      signature: VECTOR_2_SIGNATURE,
      body: VECTOR_2_BODY,
      now: () => new Date((Number(VECTOR_2_TIMESTAMP) + 300) * 1000),
    });

    expect(result).toBe(true);
  });

  it("rejects a stale timestamp one second past the 300s window", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_2_TIMESTAMP,
      signature: VECTOR_2_SIGNATURE,
      body: VECTOR_2_BODY,
      now: () => new Date((Number(VECTOR_2_TIMESTAMP) + 301) * 1000),
    });

    expect(result).toBe(false);
  });

  it("rejects a future-dated timestamp one second past the 300s window (both directions are checked)", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_2_TIMESTAMP,
      signature: VECTOR_2_SIGNATURE,
      body: VECTOR_2_BODY,
      now: () => new Date((Number(VECTOR_2_TIMESTAMP) - 301) * 1000),
    });

    expect(result).toBe(false);
  });

  it("rejects a non-numeric timestamp before ever computing an HMAC", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: "not-a-number",
      signature: VECTOR_2_SIGNATURE,
      body: VECTOR_2_BODY,
      now: nowAt(VECTOR_2_TIMESTAMP),
    });

    expect(result).toBe(false);
  });

  it("rejects a timestamp that overflows Number.isSafeInteger", async () => {
    const hugeTimestamp = "99999999999999999999";
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: hugeTimestamp,
      signature: VECTOR_2_SIGNATURE,
      body: VECTOR_2_BODY,
      now: nowAt(VECTOR_2_TIMESTAMP),
    });

    expect(result).toBe(false);
  });

  it("rejects a malformed signature (missing v0= prefix) by regex, without needing a matching timestamp", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_2_TIMESTAMP,
      signature: "not-a-signature",
      body: VECTOR_2_BODY,
      now: nowAt(VECTOR_2_TIMESTAMP),
    });

    expect(result).toBe(false);
  });

  it("rejects a signature with the right length but non-hex characters", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_2_TIMESTAMP,
      signature: `v0=${"z".repeat(64)}`,
      body: VECTOR_2_BODY,
      now: nowAt(VECTOR_2_TIMESTAMP),
    });

    expect(result).toBe(false);
  });

  it("rejects a signature that is one hex character short", async () => {
    const result = await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: VECTOR_2_TIMESTAMP,
      signature: `v0=${"a".repeat(63)}`,
      body: VECTOR_2_BODY,
      now: nowAt(VECTOR_2_TIMESTAMP),
    });

    expect(result).toBe(false);
  });

  it("throws when signingSecret is empty — a deployment error, not an unverifiable request", async () => {
    await expect(
      verifySlackSignature({
        signingSecret: "",
        timestamp: VECTOR_2_TIMESTAMP,
        signature: VECTOR_2_SIGNATURE,
        body: VECTOR_2_BODY,
        now: nowAt(VECTOR_2_TIMESTAMP),
      }),
    ).rejects.toThrow();
  });
});
