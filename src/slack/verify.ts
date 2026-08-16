/**
 * Slack request signature verification. `crypto.subtle` HMAC only — no
 * `@slack/*` package, per CLAUDE.md non-negotiable. Implementation is
 * issue #6's responsibility.
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

/** Verifies a Slack request's HMAC signature and rejects stale timestamps (replay protection). */
export async function verifySlackSignature(input: SlackSignatureInput): Promise<boolean> {
  throw new Error("not implemented: verifySlackSignature");
}
