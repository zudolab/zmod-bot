/**
 * Slack request signature verification. `crypto.subtle` HMAC only — no
 * `@slack/*` package, per CLAUDE.md non-negotiable. Implementation is
 * issue #6's responsibility.
 *
 * Ported from readycrew-viewer's production
 * `app/src/slack/slack-events.ts` (`decodeV0Signature` /
 * `timingSafeEqual` / `validSlackSignature`) — same hardening, adapted
 * to this repo's `SlackSignatureInput`-shaped DI instead of separate
 * positional args.
 */

export interface SlackSignatureInput {
  signingSecret: string;
  /** The `X-Slack-Request-Timestamp` header, raw string. */
  timestamp: string;
  /** The `X-Slack-Signature` header, raw string (`v0=...`). */
  signature: string;
  /** The exact raw request body — signing is over the unparsed bytes. */
  body: string;
  /** Injected clock, so the replay-window check is testable without real delays. */
  now: () => Date;
}

const SLACK_SIGNATURE_VERSION = "v0";
const MAX_SIGNATURE_AGE_SECONDS = 300;
const SIGNATURE_PATTERN = /^v0=([0-9a-fA-F]{64})$/;
const TIMESTAMP_PATTERN = /^[0-9]+$/;
const encoder = new TextEncoder();

/** Rejects by regex before ever touching the byte layout of a signature — no HMAC is spent on an obviously malformed value. */
function decodeV0Signature(value: string): Uint8Array | null {
  const match = SIGNATURE_PATTERN.exec(value);
  const hex = match?.[1];
  if (!hex) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Constant-work byte comparison; the length difference is folded into the accumulator alongside every byte, so early-exit timing leaks nothing. */
function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

/**
 * Verifies a Slack request's HMAC signature and rejects stale (or
 * future-dated) timestamps (replay protection). The caller must read the
 * raw request body exactly once as text and pass it here *before* any
 * `JSON.parse` — verifying a re-serialized body is the classic way this
 * check silently always fails, or worse, always passes.
 *
 * A missing/empty `signingSecret` is a deployment error, not an
 * unverifiable request: this throws rather than falling through to
 * "assume valid", so the route can answer a distinct 500
 * ("server misconfigured") instead of the 401 a bad signature gets.
 */
export async function verifySlackSignature(input: SlackSignatureInput): Promise<boolean> {
  if (!input.signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET is not configured; cannot verify Slack request signatures.");
  }

  if (!TIMESTAMP_PATTERN.test(input.timestamp)) return false;
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return false;

  const nowSeconds = Math.floor(input.now().getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_SIGNATURE_AGE_SECONDS) return false;

  const supplied = decodeV0Signature(input.signature);
  if (!supplied) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${SLACK_SIGNATURE_VERSION}:${input.timestamp}:${input.body}`),
    ),
  );

  return timingSafeEqual(digest, supplied);
}
