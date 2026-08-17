/**
 * The three-guard envelope around the one composed slot of a reply —
 * budget (pre-call), deadline (in-call), output shape (post-call). Any
 * trip returns a {@link GuardTrip} and the caller
 * (src/reply/compose.ts) falls back to the deterministic renderer, per
 * CLAUDE.md "deterministic skeleton, LLM middle, deterministic
 * fallback."
 *
 * **A trip is a logged event, never an error.** Nothing here throws for
 * a guard result: a trip is a value. The one exception is
 * {@link DeadlineExceededError}, which exists only because
 * `Promise.race` needs a rejection to lose to — compose.ts converts it
 * back into a GuardTrip immediately.
 *
 * Guards never see, and never return, customer-facing text: `detail` is
 * a short mechanical description ("2 unexpected, 1 missing"), sized for
 * a log line. The reason token is the stable metric label; `detail` is
 * explicitly not (issue #13: "Do not put free-text detail in the reason
 * token").
 */
import { TABLE_NAMES, type UsageTask } from "../db/schema";
import type { NowFn } from "../types";
import { LlmProviderError, type LlmResult } from "./provider";

/** Which guard tripped. Ordered as they are applied. */
export type ComposeGuard = "budget" | "call" | "output";

/**
 * The stable reason token written to `usage_log.fallback` and used as a
 * metric label. Closed set — a new failure mode gets a new token here,
 * never free text (see the module comment).
 *
 * Which guard can emit which:
 *   budget — `budget_exceeded`; `circuit_open` is reserved for a
 *            breaker this issue does not implement, and nothing emits it
 *            today. It stays in the union because
 *            {@link PRE_CALL_FALLBACK_REASONS} has to be able to name
 *            it: a breaker added later must be excluded from the budget
 *            count on the same day it lands, not one release after.
 *   call   — `timeout`, `provider_error`, `rate_limited` (an upstream
 *            429 — the call was made and did cost the provider's budget,
 *            which is why it is not a pre-call reason).
 *   output — `empty_response`, `truncated`, `url_mismatch`,
 *            `schema_invalid`.
 */
export type FallbackReason =
  | "rate_limited"
  | "budget_exceeded"
  | "circuit_open"
  | "timeout"
  | "provider_error"
  | "schema_invalid"
  | "empty_response"
  | "url_mismatch"
  | "truncated";

export interface GuardTrip {
  guard: ComposeGuard;
  reason: FallbackReason;
  /**
   * Mechanical detail for the log line — counts, status codes, token
   * numbers. Never the model's text, never the reference body, never a
   * metric label.
   */
  detail: string;
}

/* -------------------------------------------------------------------------
 * 1. Budget (pre-call)
 * ---------------------------------------------------------------------- */

/** Composed calls per UTC day. A `var`-shaped default: see COMPOSE_DAILY_CAP wiring in src/reply/compose.ts. */
export const DEFAULT_COMPOSE_DAILY_CAP = 300;

/**
 * Reasons recorded for a fallback that never reached the provider. Rows
 * carrying one of these are excluded from the budget count — they spent
 * nothing, and counting them would let a tripped budget hold itself
 * tripped for the rest of the day off its own logging.
 *
 * The inverse is equally deliberate: `rate_limited`, `timeout`,
 * `provider_error` and every output-guard reason DO count. The call was
 * made and the tokens were spent whether or not the answer was usable.
 */
export const PRE_CALL_FALLBACK_REASONS: readonly FallbackReason[] = ["budget_exceeded", "circuit_open"];

export interface BudgetGuardDeps {
  db: D1Database;
  now: NowFn;
}

export interface BudgetGuardOptions {
  task: UsageTask;
  /** Trips when the day's count has already reached this. */
  cap: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch ms of the UTC midnight opening the day `at` falls in. */
export function utcDayStartMs(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/**
 * Counts provider calls already made today (UTC) for `task`.
 *
 * Counted in D1 rather than KV deliberately (issue #13): KV's
 * read-modify-write is not atomic and its reads are edge-cached for up
 * to 60 s, so it silently loses increments under exactly the burst a
 * budget guard exists to catch.
 */
export async function countComposeCallsToday(
  deps: BudgetGuardDeps,
  task: UsageTask,
): Promise<number> {
  const placeholders = PRE_CALL_FALLBACK_REASONS.map(() => "?").join(", ");
  const dayStart = utcDayStartMs(deps.now());
  // Bounded at both ends, so this is a day and not "everything since
  // midnight". Without the upper bound a row timestamped ahead of the
  // clock — skew, or a backfill — inflates today's count and holds the
  // budget tripped against calls that have not happened yet.
  const row = await deps.db
    .prepare(
      `SELECT COUNT(*) AS calls FROM ${TABLE_NAMES.usageLog}
       WHERE task = ? AND created_at >= ? AND created_at < ?
         AND (fallback IS NULL OR fallback NOT IN (${placeholders}))`,
    )
    .bind(task, dayStart, dayStart + DAY_MS, ...PRE_CALL_FALLBACK_REASONS)
    .first<{ calls: number }>();
  return row?.calls ?? 0;
}

/** Null when there is budget left; a trip when the day's cap is already reached. */
export async function checkBudgetGuard(
  deps: BudgetGuardDeps,
  options: BudgetGuardOptions,
): Promise<GuardTrip | null> {
  const used = await countComposeCallsToday(deps, options.task);
  if (used < options.cap) return null;
  return {
    guard: "budget",
    reason: "budget_exceeded",
    detail: `${used}/${options.cap} ${options.task} calls used today (UTC)`,
  };
}

/* -------------------------------------------------------------------------
 * 2. Call deadline (in-call)
 * ---------------------------------------------------------------------- */

/** The provider deadline for a composed section (issue #13). */
export const COMPOSE_DEADLINE_MS = 8_000;

/** Loses the `Promise.race` in {@link withDeadline}. Converted straight back into a GuardTrip — never surfaces to a caller of composeReply. */
export class DeadlineExceededError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`provider did not answer within ${timeoutMs}ms`);
    this.name = "DeadlineExceededError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Races `work` against `timeoutMs`.
 *
 * Two things this does NOT do, both on purpose:
 *
 *   - **It does not cancel the provider.** Racing stops *you* waiting;
 *     the request is still in flight at the other end and will still be
 *     billed. Cancellation needs an `AbortSignal` handed to the adapter
 *     (`LlmRequest.signal`) — compose.ts passes one, and aborts it when
 *     this rejects. The race and the abort are separate mechanisms and
 *     both are needed: the abort may be a no-op on a provider that
 *     ignores it, and the race is what bounds the reply's latency
 *     either way.
 *   - **It does not leave a timer armed.** `clearTimeout` runs in a
 *     `finally`, whichever side settles. A dangling `setTimeout` firing
 *     after the response has gone out rejects a promise nothing is
 *     attached to, which in a Worker is an unhandled rejection charged
 *     to whatever request happens to be running.
 *
 * The `catch` attached to `work` before the race is the other half of
 * that: when the timeout wins, `work` is still pending, and its later
 * rejection has no handler unless one is parked on it here. That
 * swallows nothing real — the rejection still reaches the race, this
 * only silences the *dropped* branch.
 */
export async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  void work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Classifies whatever the call phase threw. An upstream 429 is
 * `rate_limited` rather than `provider_error` because the two want
 * different operator responses — back off vs. investigate — and the
 * reason token is the only thing a dashboard can group on.
 */
export function classifyCallFailure(error: unknown): GuardTrip {
  if (error instanceof DeadlineExceededError) {
    return { guard: "call", reason: "timeout", detail: `deadline ${error.timeoutMs}ms exceeded` };
  }
  if (error instanceof LlmProviderError && error.status === 429) {
    return { guard: "call", reason: "rate_limited", detail: "provider returned HTTP 429" };
  }
  if (error instanceof LlmProviderError) {
    return {
      guard: "call",
      reason: "provider_error",
      detail: error.status === undefined ? error.name : `${error.name} HTTP ${error.status}`,
    };
  }
  // Deliberately the error's *name* and nothing else. A provider error
  // message can carry an upstream body, and an upstream body on a 200
  // path is the model's completion — customer-facing text (CLAUDE.md).
  return {
    guard: "call",
    reason: "provider_error",
    detail: error instanceof Error ? error.name : typeof error,
  };
}

/* -------------------------------------------------------------------------
 * 3. Output shape (post-call)
 * ---------------------------------------------------------------------- */

/**
 * Absolute http(s) URLs.
 *
 * The character class is RFC 3986's own set, minus parentheses —
 * **allow-list, not deny-list**. A deny-list ("anything but whitespace
 * and quotes") swallows the Japanese punctuation this corpus writes
 * links against: `…/oxi-one/。次に` matched whole and read as an invented
 * address. Every URL in this system is ASCII, so listing what a URL may
 * contain is both narrower and more honest than guessing at everything
 * it may not.
 *
 * Parens are excluded because the corpus's editorial notes wrap links in
 * them (`(https://youtu.be/…)`), and they never appear inside a URL here.
 */
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+/g;
/** Legal mid-URL, junk at the end — a writer's sentence punctuation left against the link. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?']+$/;

/** Every absolute URL in `text`, in order, de-duplicated, with trailing punctuation stripped. */
export function extractUrls(text: string): string[] {
  const found = [...text.matchAll(URL_PATTERN)].map((match) =>
    match[0].replace(URL_TRAILING_PUNCTUATION, ""),
  );
  return [...new Set(found.filter((url) => url.length > 0))];
}

export interface OutputGuardInput {
  /** The model's text, as returned. Trimmed here — leading/trailing whitespace is not a shape violation. */
  text: string;
  /**
   * Read straight off {@link LlmResult} rather than re-derived from the
   * text: the adapters already normalize a refusal and a cap hit across
   * two very different providers, and "does it *look* cut off" is a
   * strictly worse signal — output that hit a cap can stop on a clean
   * sentence boundary (see src/llm/workers-ai.ts `looksTruncated`).
   */
  stopReason: LlmResult["stopReason"];
  truncated: LlmResult["truncated"];
  /**
   * Exactly the URLs the composed section must carry — derived from the
   * deterministic rendering of the same reference under the same
   * gating, so the two paths cannot disagree about what "should be
   * there" means.
   *
   * The check is set *equality*, which is stricter than the issue's
   * "present somewhere in the reference": a `## Notes (additional)`
   * paragraph carries YouTube links that exist in the reference and
   * must never ship (they are the operator's note that the video is
   * already embedded in the intro article). Equality catches that;
   * "in the reference" would wave it through.
   */
  expectedUrls: string[];
  /**
   * Text that must appear byte-exact — the reference's literal blocks
   * (a fragility notice, a renewal notice). These are pasted into a
   * customer message unchanged; a model paraphrase of a legal-ish
   * notice is a shape violation, not a style choice.
   */
  requiredLiterals: string[];
  /**
   * The reply's fixed clauses (src/reply/templates.ts). The skeleton
   * supplies every one of them, so the model restating one duplicates
   * it in the customer's message. Matched by exact containment, no
   * length floor — these are byte-exact constants and any occurrence is
   * a bug.
   */
  fixedClauses: string[];
  /**
   * The `Notes` / `Notes (additional)` prose. It is handed to the model
   * as guidance — that is what it is for; addac107's note is a direct
   * instruction about what NOT to include — but it is editorial, written
   * to whoever composes the reply, and must never reach a customer.
   * Matched per line (see {@link WITHHELD_FRAGMENT_MIN_LENGTH}), since a
   * model that echoes half a paragraph has still leaked it.
   */
  withheldProse: string[];
}

/**
 * Length floor for the per-line leak check on {@link
 * OutputGuardInput.withheldProse}. Without it a short editorial fragment
 * ("完成品。") would veto a legitimate section that happens to reuse the
 * phrase; with it, a leak has to be a distinctive span of the operator's
 * own note.
 */
const WITHHELD_FRAGMENT_MIN_LENGTH = 24;

/** Consecutive identical non-blank lines that mean the model is looping rather than writing. */
const MAX_CONSECUTIVE_REPEATS = 3;

/**
 * The post-call guard. Returns the FIRST violation rather than
 * collecting them: the caller's response to any of them is identical
 * (fall back), and the first one is the one worth naming in the log.
 */
export function checkOutputGuard(input: OutputGuardInput): GuardTrip | null {
  const trip = (reason: FallbackReason, detail: string): GuardTrip => ({ guard: "output", reason, detail });

  // A refusal is checked before emptiness so the log says why the text
  // is empty. Both fall back identically; only the detail differs.
  if (input.stopReason === "refusal") {
    return trip("empty_response", "provider reported a refusal");
  }
  if (input.truncated) {
    return trip("truncated", `provider reported truncation (stopReason ${input.stopReason})`);
  }

  const text = input.text.trim();
  if (text === "") return trip("empty_response", "provider returned no text");

  const emitted = extractUrls(text);
  const expected = [...new Set(input.expectedUrls)];
  const missing = expected.filter((url) => !emitted.includes(url));
  const invented = emitted.filter((url) => !expected.includes(url));
  if (missing.length > 0 || invented.length > 0) {
    // Counts only. A URL is not customer prose, but an invented one is
    // whatever the model hallucinated, and this string reaches a log.
    return trip("url_mismatch", `${invented.length} invented, ${missing.length} missing of ${expected.length}`);
  }

  const missingLiteral = input.requiredLiterals.findIndex((literal) => !text.includes(literal));
  if (missingLiteral !== -1) {
    return trip(
      "schema_invalid",
      `literal block ${missingLiteral + 1}/${input.requiredLiterals.length} is absent or altered`,
    );
  }

  const restated = input.fixedClauses.find((clause) => clause !== "" && text.includes(clause));
  if (restated !== undefined) {
    return trip("schema_invalid", `a fixed clause (${restated.length} chars) was restated in the composed section`);
  }

  const leaked = findLeakedFragment(text, input.withheldProse);
  if (leaked !== null) {
    return trip("schema_invalid", `${leaked.length} chars of withheld editorial prose were emitted`);
  }

  const repeated = findRepeatedRun(text);
  if (repeated > MAX_CONSECUTIVE_REPEATS) {
    return trip("schema_invalid", `a line repeats ${repeated} times consecutively`);
  }

  return null;
}

/** The first line of any withheld text, long enough to be distinctive, that appears verbatim in `text`. */
function findLeakedFragment(text: string, withheldProse: string[]): string | null {
  for (const forbidden of withheldProse) {
    for (const line of forbidden.split("\n")) {
      const fragment = line.trim();
      if (fragment.length < WITHHELD_FRAGMENT_MIN_LENGTH) continue;
      if (text.includes(fragment)) return fragment;
    }
  }
  return null;
}

/** Longest run of identical consecutive non-blank lines. */
function findRepeatedRun(text: string): number {
  let longest = 0;
  let run = 0;
  let previous: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      previous = null;
      run = 0;
      continue;
    }
    run = line === previous ? run + 1 : 1;
    previous = line;
    if (run > longest) longest = run;
  }
  return longest;
}
