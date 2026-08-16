/**
 * Polish mode (issue #16): `@bot polish` + pasted Japanese -> a politer
 * version of the same text, same structure. Reuses the exact three-guard
 * envelope from src/llm/guards.ts (budget -> call deadline -> output
 * shape) that src/reply/compose.ts (#13) already drives — no second
 * envelope is built here. The one addition is a pre-flight input-length
 * check (see MAX_POLISH_INPUT_CHARS), which has no compose equivalent
 * because compose's input is a bounded product reference, never
 * arbitrary pasted customer text.
 *
 * **A result is always produced, never a throw for a guard trip.** Every
 * budget/deadline/output-shape trip, and the length-cap refusal, returns
 * the original text unchanged plus a `fallback` describing why -- never
 * a partial rewrite, per the issue: "a half-polished customer message is
 * worse than none."
 *
 * **Preservation is machine-checked, not trusted to the prompt.** The
 * system prompt asks the model to keep URLs, structure and line breaks
 * intact, but `checkPolishPreservation` below re-verifies every one of
 * those against the actual output and falls back on any violation --
 * the same "prompt asks, guard verifies" split guards.ts's output guard
 * already uses for compose.
 *
 * **Never log the polish input or output** (CLAUDE.md non-negotiable) --
 * every log line below carries only counts, ratios and reason tokens,
 * never the text itself.
 */
import { appendUsageLog, type RepoDeps } from "../db/repos";
import type { Env } from "../env";
import { createClaudeProvider } from "../llm/claude";
import {
  checkBudgetGuard,
  checkOutputGuard,
  classifyCallFailure,
  COMPOSE_DEADLINE_MS,
  extractUrls,
  withDeadline,
  type ComposeGuard,
  type FallbackReason,
  type GuardTrip,
} from "../llm/guards";
import type { LlmProvider, LlmProviderId, LlmRequest, LlmResult } from "../llm/provider";
import { createWorkersAiProvider } from "../llm/workers-ai";
import { errorSnippet, log } from "../ops/log";
import type { FetchLike, NowFn } from "../types";

/**
 * Beyond this, the input is refused outright rather than truncated or
 * sent anyway -- a half-polished customer message is worse than none
 * (issue #16).
 */
export const MAX_POLISH_INPUT_CHARS = 8_000;

/** Polish calls per UTC day, counted the same way as COMPOSE_DAILY_CAP (src/llm/guards.ts) but under task "polish", so the two budgets never share a counter. */
export const DEFAULT_POLISH_DAILY_CAP = 300;

/**
 * guards.ts's ComposeGuard, widened by the one pre-flight stage compose
 * doesn't have: the input character cap, checked before the budget guard
 * even reads usage_log.
 */
export type PolishGuard = ComposeGuard | "input";

/**
 * guards.ts's FallbackReason, widened by the one reason the cap check
 * above can produce. Deliberately never written to usage_log -- see the
 * early-return in {@link polishText}: guards.ts's PRE_CALL_FALLBACK_REASONS
 * doesn't know this token, so logging it would count as a "real" call
 * against the daily budget when no provider was ever reached.
 */
export type PolishFallbackReason = FallbackReason | "input_too_long";

export interface PolishFallback {
  guard: PolishGuard;
  reason: PolishFallbackReason;
  /** Mechanical detail for the log line -- counts and ratios only, never the text. */
  detail: string;
}

export interface PolishInput {
  /** The pasted text, already stripped of the `polish` head line by src/slack/commands.ts parseCommand. */
  text: string;
}

export interface PolishDeps {
  env: Env;
  fetch: FetchLike;
  /** Defaults to a real clock. Injected so the UTC-day budget window is testable. */
  now?: NowFn;
  /** Overrides {@link DEFAULT_POLISH_DAILY_CAP}. */
  dailyCap?: number;
}

export interface PolishResult {
  /** The polished text on success; the ORIGINAL text, byte-for-byte, on any fallback. */
  text: string;
  /** True when a guard tripped (including the length-cap refusal) and `text` is the unchanged input. */
  usedFallback: boolean;
  /** Null when the LLM output was used; else which guard tripped and why. */
  fallback?: PolishFallback | null;
  /** Which adapter was selected. Absent only when the input was empty (no call was needed). */
  provider?: LlmProviderId;
  /** The model that actually served the call, when one completed. */
  model?: string;
}

export async function polishText(deps: PolishDeps, input: PolishInput): Promise<PolishResult> {
  const now = deps.now ?? (() => new Date());
  const repoDeps: RepoDeps = { db: deps.env.DB, now };
  const provider = selectPolishProvider(deps);
  const originalText = input.text;

  // Nothing to polish -- not a guard trip, just a no-op. Mirrors
  // src/reply/compose.ts's "no resources section" skip: no call, no
  // usage_log row.
  if (originalText.trim() === "") {
    return { text: originalText, usedFallback: false, fallback: null, provider: provider.id };
  }

  // The length cap is checked before anything else -- including the
  // budget guard, which would otherwise spend a usage_log read on an
  // input that was never going anywhere near the provider.
  if (originalText.length > MAX_POLISH_INPUT_CHARS) {
    log("info", "polish: input exceeds the character cap, refusing without calling the provider", {
      inputLength: originalText.length,
      cap: MAX_POLISH_INPUT_CHARS,
    });
    return {
      text: originalText,
      usedFallback: true,
      fallback: {
        guard: "input",
        reason: "input_too_long",
        detail: `input is ${originalText.length} chars, cap is ${MAX_POLISH_INPUT_CHARS}`,
      },
      provider: provider.id,
    };
  }

  const fallback = async (trip: PolishFallback, result: LlmResult | null): Promise<PolishResult> => {
    log("warn", "polish: falling back to the original text unchanged", {
      guard: trip.guard,
      reason: trip.reason,
      detail: trip.detail,
      provider: provider.id,
    });
    await recordUsage(repoDeps, provider.id, result, trip.reason);
    return {
      text: originalText,
      usedFallback: true,
      fallback: trip,
      provider: provider.id,
      ...(result === null ? {} : { model: result.model }),
    };
  };

  const budgetTrip = await checkBudget(repoDeps, deps.dailyCap ?? DEFAULT_POLISH_DAILY_CAP);
  if (budgetTrip !== null) return fallback(budgetTrip, null);

  let result: LlmResult;
  try {
    result = await callProvider(provider, buildPolishRequest(originalText));
  } catch (error) {
    return fallback(classifyCallFailure(error), null);
  }

  // Reuses guards.ts's refusal/truncated/empty/repeated-run checks, plus
  // its URL check as a first, cheaper pass (a completely hallucinated or
  // dropped URL trips here with a simpler message before the stricter
  // multiset check below ever runs). requiredLiterals/fixedClauses/
  // withheldProse are empty -- polish has none of those, so those three
  // checks are no-ops here, not disabled.
  const shapeTrip = checkOutputGuard({
    text: result.text,
    stopReason: result.stopReason,
    truncated: result.truncated,
    expectedUrls: extractUrls(originalText),
    requiredLiterals: [],
    fixedClauses: [],
    withheldProse: [],
  });
  if (shapeTrip !== null) return fallback(shapeTrip, result);

  const outputText = result.text.trim();
  const preservationTrip = checkPolishPreservation(originalText.trim(), outputText);
  if (preservationTrip !== null) return fallback(preservationTrip, result);

  await recordUsage(repoDeps, provider.id, result, null);
  return { text: outputText, usedFallback: false, fallback: null, provider: provider.id, model: result.model };
}

/**
 * POLISH_PROVIDER picks the adapter and nothing else -- mirrors
 * src/reply/compose.ts selectComposeProvider exactly, including the
 * fail-soft default on an unrecognized value (a typo in a `vars` entry
 * must not take polish down).
 */
export function selectPolishProvider(deps: PolishDeps): LlmProvider {
  const configured = deps.env.POLISH_PROVIDER;
  if (configured === "claude") {
    return createClaudeProvider({
      apiKey: deps.env.ANTHROPIC_API_KEY,
      fetch: deps.fetch,
      model: deps.env.CLAUDE_MODEL,
    });
  }
  if (configured !== "workers-ai") {
    log("warn", "polish: unrecognized POLISH_PROVIDER, using the workers-ai default", {
      configured: String(configured),
    });
  }
  return createWorkersAiProvider({ ai: deps.env.AI });
}

/** Same deadline budget as compose (src/llm/guards.ts COMPOSE_DEADLINE_MS) -- the issue names no separate tunable for polish, so none is invented here. */
async function callProvider(provider: LlmProvider, request: Omit<LlmRequest, "signal">): Promise<LlmResult> {
  const controller = new AbortController();
  try {
    return await withDeadline(provider.run({ ...request, signal: controller.signal }), COMPOSE_DEADLINE_MS);
  } catch (error) {
    controller.abort();
    throw error;
  }
}

/** Fails open, exactly like src/reply/compose.ts checkBudget: a single unreadable usage_log is not the burst this guard exists to catch. */
async function checkBudget(repoDeps: RepoDeps, cap: number): Promise<GuardTrip | null> {
  try {
    return await checkBudgetGuard(repoDeps, { task: "polish", cap });
  } catch (error) {
    log("error", "polish: budget guard could not read usage_log — proceeding uncapped", {
      error: errorSnippet(error),
    });
    return null;
  }
}

/** Swallows its own failure -- the polished (or unchanged) text has already been produced; losing the accounting row is strictly better than losing it. */
async function recordUsage(
  repoDeps: RepoDeps,
  provider: LlmProviderId,
  result: LlmResult | null,
  fallback: PolishFallbackReason | null,
): Promise<void> {
  try {
    await appendUsageLog(repoDeps, {
      slug: null,
      task: "polish",
      provider,
      model: result?.model ?? null,
      fallback,
      tokensIn: result?.tokensIn ?? null,
      tokensOut: result?.tokensOut ?? null,
    });
  } catch (error) {
    log("error", "polish: usage_log write failed", { error: errorSnippet(error) });
  }
}

/* -------------------------------------------------------------------------
 * The prompt.
 *
 * Never logged, at any level -- the pasted text is customer-facing
 * business text (CLAUDE.md non-negotiable).
 * ---------------------------------------------------------------------- */

const FORBIDDEN_POLITE_FORM = "でございま";

const POLISH_SYSTEM_PROMPT = [
  "You polish the wording of a Japanese message for a modular synthesizer shop's Mercari Shops customer communication.",
  "",
  "Rules, all of them absolute:",
  `- Elevate the wording to business-polite Japanese (丁寧語) appropriate for customer communication, in a warm, approachable shop-owner tone. Do not over-formalize into stiff or robotic prose.`,
  `- Never use ～${FORBIDDEN_POLITE_FORM}す — it is too formal for this shop's voice. Example: 可能でございます → 可能です; 見込みでございまして → 見込みでして.`,
  "- Preserve exactly, character for character: every URL, every product name, every link title.",
  "- Preserve the overall structure and information. Add nothing, remove nothing.",
  "- Keep exactly the same line breaks and paragraph structure as the input — the same number of blank lines, in the same places.",
  "- If the text is already polite enough, make only minimal changes.",
  "- Output ONLY the polished text. No preamble, no explanation, no commentary about what you changed.",
].join("\n");

/**
 * `inputTokens` has no real tokenizer behind it at the edge, so character
 * count is used as a deliberately safe upper bound: for mixed
 * Japanese/URL text a token is essentially never shorter than one
 * character, so this over-, never under-, estimates -- and
 * underestimating is the one failure mode this formula exists to
 * prevent (Llama's silent 256-token default; see CLAUDE.md
 * non-negotiable and src/llm/workers-ai.ts).
 */
/** Floor on the value {@link computePolishMaxTokens} returns — see issue #16: "floored at 1024". */
export const POLISH_MIN_MAX_TOKENS = 1024;

export function computePolishMaxTokens(text: string): number {
  const inputTokens = text.length;
  return Math.max(POLISH_MIN_MAX_TOKENS, Math.ceil(inputTokens * 2) + 256);
}

function buildPolishRequest(text: string): Omit<LlmRequest, "signal"> {
  return {
    system: POLISH_SYSTEM_PROMPT,
    user: text,
    maxTokens: computePolishMaxTokens(text),
  };
}

/* -------------------------------------------------------------------------
 * Preservation guard -- the machine-testable assertions from issue #16.
 * ---------------------------------------------------------------------- */

const MIN_LENGTH_RATIO = 0.5;
const MAX_LENGTH_RATIO = 2.0;

/**
 * Mirrors src/llm/guards.ts's (unexported) URL_PATTERN / URL_TRAILING_PUNCTUATION
 * exactly -- same allow-list, same trailing-punctuation strip. Needed
 * here specifically because guards.ts's own extractUrls() de-duplicates,
 * and the preservation contract below is multiset equality: a URL
 * repeated twice in the input must be repeated exactly twice in the
 * output, which a de-duplicated set can't express.
 */
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+/g;
const URL_TRAILING_PUNCTUATION = /[.,;:!?']+$/;

/** Every absolute URL in `text`, in order, WITH duplicates -- the multiset counterpart of guards.ts's extractUrls. */
function extractUrlMultiset(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((match) => match[0].replace(URL_TRAILING_PUNCTUATION, ""));
}

/** True when `a` and `b` contain the same items the same number of times, order irrelevant. */
function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const remaining = new Map<string, number>();
  for (const item of a) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  for (const item of b) {
    const count = remaining.get(item) ?? 0;
    if (count === 0) return false;
    remaining.set(item, count - 1);
  }
  return true;
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

/** Blank-line-separated paragraphs -- a run of one or more blank (or whitespace-only) lines is one separator, however many newlines it spans. */
function countParagraphs(text: string): number {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0).length;
}

/**
 * The machine-testable preservation assertions from issue #16, applied
 * in the same "return the first violation" style as
 * src/llm/guards.ts checkOutputGuard. Every trip maps to guard "output",
 * reason "schema_invalid" -- both already in guards.ts's closed set, so
 * no new reason token is needed for these (unlike the length-cap
 * refusal, which happens before any of this runs).
 */
function checkPolishPreservation(inputText: string, outputText: string): GuardTrip | null {
  const trip = (detail: string): GuardTrip => ({ guard: "output", reason: "schema_invalid", detail });

  const inputUrls = extractUrlMultiset(inputText);
  const outputUrls = extractUrlMultiset(outputText);
  if (!sameMultiset(inputUrls, outputUrls)) {
    return trip(`URL multiset changed (${inputUrls.length} in, ${outputUrls.length} out)`);
  }

  const inputNewlines = countNewlines(inputText);
  const outputNewlines = countNewlines(outputText);
  if (inputNewlines !== outputNewlines) {
    return trip(`newline count changed (${inputNewlines} in, ${outputNewlines} out)`);
  }

  const inputParagraphs = countParagraphs(inputText);
  const outputParagraphs = countParagraphs(outputText);
  if (inputParagraphs !== outputParagraphs) {
    return trip(`paragraph count changed (${inputParagraphs} in, ${outputParagraphs} out)`);
  }

  if (outputText.includes(FORBIDDEN_POLITE_FORM)) {
    return trip(`output contains the forbidden form (${FORBIDDEN_POLITE_FORM})`);
  }

  const ratio = outputText.length / Math.max(1, inputText.length);
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) {
    return trip(`output length ratio ${ratio.toFixed(2)}x is outside ${MIN_LENGTH_RATIO}x-${MAX_LENGTH_RATIO}x`);
  }

  return null;
}
