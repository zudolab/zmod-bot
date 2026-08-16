/**
 * Guards applied to LLM output before it reaches a customer. Any trip
 * falls back to src/reply/render.ts's deterministic path — see
 * CLAUDE.md "deterministic skeleton, LLM middle, deterministic
 * fallback." Implementation is issue #13's responsibility.
 */

export interface GuardResult {
  passed: boolean;
  reason?: string;
}

/** Rejects empty, truncated, or degenerate (repetition-loop) LLM output. */
export function checkLlmOutputGuards(text: string): GuardResult {
  throw new Error("not implemented: checkLlmOutputGuards");
}

/** Rejects output containing a URL not present in the source ProductRef — the LLM must not invent links. */
export function checkNoInventedLinks(text: string, allowedUrls: string[]): GuardResult {
  throw new Error("not implemented: checkNoInventedLinks");
}
