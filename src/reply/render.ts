/**
 * Deterministic message assembly — the fixed skeleton (src/reply/
 * templates.ts) around a resources section, which is either LLM-composed
 * (src/reply/compose.ts, the normal path) or rendered here directly (the
 * fallback whenever a guard trips — CLAUDE.md "deterministic skeleton,
 * LLM middle, deterministic fallback"). Implementation is issue #7's
 * responsibility.
 */
import type { ProductRef } from "../refs/model";
import type { ReplyTemplateSet } from "./templates";

export interface RenderReplyInput {
  ref: ProductRef;
  templates: ReplyTemplateSet;
  /** Pre-formatted arrival-schedule sentence (e.g. "明後日月曜（8/18）到着予定になります。"), or null for categories with no arrival schedule. */
  arrivalSchedule: string | null;
  /** The composed (LLM or deterministic-fallback) product-resources section text. */
  resourceSection: string;
}

/** Assembles the final byte-for-byte message the human copies into Mercari Shops. */
export function renderReply(input: RenderReplyInput): string {
  throw new Error("not implemented: renderReply");
}

/**
 * Deterministic (non-LLM) rendering of a ProductRef's resources section
 * directly from its parsed sections — the fallback path whenever a guard
 * trips (src/llm/guards.ts).
 */
export function renderResourceSectionDeterministic(ref: ProductRef): string {
  throw new Error("not implemented: renderResourceSectionDeterministic");
}
