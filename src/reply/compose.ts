/**
 * Compose orchestration: LLM-assembled resource section
 * (COMPOSE_PROVIDER, src/llm/provider.ts) -> guards (src/llm/guards.ts)
 * -> deterministic fallback render (src/reply/render.ts) on any guard
 * trip. See CLAUDE.md: "deterministic skeleton, LLM middle,
 * deterministic fallback."
 *
 * **A reply is always produced.** `composeReply` does not reject for a
 * guard trip, a provider outage, a refusal or a malformed completion —
 * every one of those returns the deterministic rendering of the same
 * reference plus a `usage_log` row naming the reason. The only throws
 * left are genuine caller errors (a `general` reply with no arrival
 * sentence), which are not guard trips and must stay loud.
 *
 * **Only the `{product_resources}` middle is composed.** The greeting,
 * shipping line, arrival sentence, evaluation clause, DIY block and
 * closing come from src/reply/templates.ts on BOTH paths — the model is
 * never shown them and never emits them (the output guard's
 * `fixedClauses` check enforces the second half). CLAUDE.md
 * non-negotiable.
 *
 * **Structural equivalence is by construction, not by convention.** The
 * deterministic section is rendered first, and everything the composed
 * section is then held to — its URLs, its literal blocks, the prose it
 * may not emit — is derived from *that string*. There is no second copy
 * of the gating rules for the two paths to drift apart on.
 *
 * **The section-prose split belongs to the renderer.** src/reply/render.ts
 * decides which prose is customer-facing and which is editorial
 * (`Notes` / `Notes (additional)`). This module owns only the other half
 * issue #13 was given: handing the editorial prose to the model as
 * guidance — addac107's note is a direct instruction about what not to
 * include, which is exactly what it is for — while guaranteeing the
 * model never emits a word of it.
 */
import { appendUsageLog, type RepoDeps } from "../db/repos";
import type { Env } from "../env";
import { createClaudeProvider } from "../llm/claude";
import {
  checkBudgetGuard,
  checkOutputGuard,
  classifyCallFailure,
  COMPOSE_DEADLINE_MS,
  DEFAULT_COMPOSE_DAILY_CAP,
  extractUrls,
  withDeadline,
  type GuardTrip,
} from "../llm/guards";
import type { LlmProvider, LlmProviderId, LlmRequest, LlmResult } from "../llm/provider";
import { createWorkersAiProvider } from "../llm/workers-ai";
import { errorSnippet, log } from "../ops/log";
import type { ProductRef, RefSection } from "../refs/model";
import type { FetchLike, NowFn } from "../types";
import { renderReply, renderResourceSectionDeterministic } from "./render";
import {
  DIY_BUILD_GUIDE_INTRO,
  DISCORD_BLOCK,
  EVALUATION_CLAUSE,
  GREETING_LINE,
  NEKOPOS_SHIPPING_LINES,
  RESOURCE_SEPARATOR,
  YAMATO_SHIPPING_LINE,
  getTemplateSet,
  templateKindFor,
  type PurchasedVariant,
  type ReplyFlags,
  type ReplyTemplateSet,
} from "./templates";

/** ~2x headroom over the longest reference (~900 output tokens) — output sizes drift across model and prompt changes. */
export const COMPOSE_MAX_TOKENS = 2048;

export interface ComposeReplyInput {
  ref: ProductRef;
  arrivalSchedule: string | null;
  discord: boolean;
  direct: boolean;
  /**
   * Which half of a `general-diy` product was bought — the resolver's
   * `ResolveResult.variant` (src/refs/resolve.ts). Selects the
   * general-vs-diy template and gates `diy-only` sections. Defaults to
   * `"built"`, matching src/jobs/worker.ts.
   */
  purchased?: PurchasedVariant;
  /**
   * How the operator named the purchased variant, e.g.
   * `"zudo-rail lite 60 set1"` — normally the job's raw text. Gates
   * `variant-match` literal blocks; with none given, none of them ship
   * (zudo-rail's Lite renewal notice among them).
   */
  variantText?: string;
}

export interface ComposeReplyDeps {
  env: Env;
  fetch: FetchLike;
  /** Defaults to a real clock. Injected so the UTC-day budget window is testable. */
  now?: NowFn;
  /** Overrides {@link DEFAULT_COMPOSE_DAILY_CAP}. */
  dailyCap?: number;
}

/** Why the deterministic path was used. Null on the happy path. */
export interface ComposeFallback {
  guard: GuardTrip["guard"];
  /** The stable token also written to `usage_log.fallback`. Never carries free text — see src/llm/guards.ts. */
  reason: GuardTrip["reason"];
  detail: string;
}

export interface ComposeReplyResult {
  text: string;
  /** True when a guard tripped and src/reply/render.ts's deterministic path was used instead of the LLM output. */
  usedFallback: boolean;
  /** Null when the LLM output was used; else which guard tripped and why. Mirrors the `usage_log` row. */
  fallback?: ComposeFallback | null;
  /** Which adapter was selected, whether or not it was reached. */
  provider?: LlmProviderId;
  /**
   * The model that actually served the call, when one completed. Absent
   * with `fallback: null` means no call was needed — the reference has
   * no resources section to compose (see composeReply).
   */
  model?: string;
}

/** `{arrival_schedule}`, `{product_name}` — see src/reply/templates.ts. */
const TEMPLATE_SLOT = /\{[a-z_]+\}/g;

/**
 * Every fixed clause the model must never restate, as the literal spans
 * that actually appear in a rendered message.
 *
 * A clause carrying a slot is split on it: `DIY_BUILD_GUIDE_INTRO`
 * begins with `{product_name}`, so the raw constant never occurs in
 * finished text and checking for it would catch nothing. Its slot-free
 * remainder is a full distinctive sentence and does.
 */
const FIXED_CLAUSES: readonly string[] = [
  GREETING_LINE,
  YAMATO_SHIPPING_LINE,
  NEKOPOS_SHIPPING_LINES,
  EVALUATION_CLAUSE,
  DIY_BUILD_GUIDE_INTRO,
  DISCORD_BLOCK,
]
  .flatMap((clause) => clause.split(TEMPLATE_SLOT))
  .map((span) => span.trim())
  .filter((span) => span !== "");

export async function composeReply(
  deps: ComposeReplyDeps,
  input: ComposeReplyInput,
): Promise<ComposeReplyResult> {
  const now = deps.now ?? (() => new Date());
  const repoDeps: RepoDeps = { db: deps.env.DB, now };
  const prepared = prepare(input);
  const provider = selectComposeProvider(deps);

  // Rendered before anything can fail, so a guard trip has nothing left
  // to do but return it. If this throws it is a caller error (a
  // `general` reply with no arrival sentence), and it throws before a
  // single token is spent.
  const fallbackText = assemble(prepared, input.arrivalSchedule, prepared.resourceSection);

  // Three references in the corpus (ai-mult, oxi-pipe-mk2, x0x-heart)
  // carry nothing but editorial `Notes`, so their resources section is
  // empty by design — ai-mult's own note says it outright: "no product
  // resources / guide links are needed in the reply — just the base
  // template". There is nothing for a model to assemble, and asking one
  // to assemble nothing can only return something the output guard then
  // rejects. No call, no `usage_log` row: nothing was spent.
  // What is left of the section once every required literal block is
  // removed. Empty means there is nothing a model could contribute: the
  // renderer already emits the literals byte-exact and the output guard
  // would demand them back unchanged, so a call can only spend tokens and
  // risk a paraphrase that trips the guard for no gain.
  const composable = prepared.requiredLiterals.reduce(
    (rest, literal) => rest.split(literal).join(""),
    prepared.resourceSection,
  );
  if (composable.trim() === "") {
    log("info", "compose: nothing to compose, skipping the provider", {
      slug: input.ref.slug,
      // Distinguishes the two shapes in the corpus: an editorial-Notes-only
      // reference (ai-mult, x0x-heart) from one whose whole section is a
      // fixed notice (oxi-pipe-mk2's included-cable line).
      literalOnly: prepared.resourceSection.trim() !== "",
    });
    return { text: fallbackText, usedFallback: false, fallback: null, provider: provider.id };
  }

  const fallback = async (trip: GuardTrip, result: LlmResult | null): Promise<ComposeReplyResult> => {
    log("warn", "compose: falling back to the deterministic renderer", {
      slug: input.ref.slug,
      guard: trip.guard,
      reason: trip.reason,
      detail: trip.detail,
      provider: provider.id,
    });
    await recordUsage(repoDeps, input.ref.slug, provider.id, result, trip.reason);
    return {
      text: fallbackText,
      usedFallback: true,
      fallback: { guard: trip.guard, reason: trip.reason, detail: trip.detail },
      provider: provider.id,
      ...(result === null ? {} : { model: result.model }),
    };
  };

  const budgetTrip = await checkBudget(repoDeps, deps.dailyCap ?? DEFAULT_COMPOSE_DAILY_CAP);
  if (budgetTrip !== null) return fallback(budgetTrip, null);

  let result: LlmResult;
  try {
    result = await callProvider(provider, buildComposeRequest(prepared));
  } catch (error) {
    return fallback(classifyCallFailure(error), null);
  }

  const outputTrip = checkOutputGuard({
    text: result.text,
    stopReason: result.stopReason,
    truncated: result.truncated,
    expectedUrls: prepared.expectedUrls,
    requiredLiterals: prepared.requiredLiterals,
    fixedClauses: [...FIXED_CLAUSES],
    withheldProse: prepared.withheldProse,
  });
  if (outputTrip !== null) return fallback(outputTrip, result);

  let text: string;
  try {
    text = assemble(prepared, input.arrivalSchedule, result.text.trim());
  } catch (error) {
    // The renderer's own validation, applied to model output — a
    // completion containing a literal `{product_resources}` survives
    // slot filling and then trips `assertNoSlotsRemain`. The
    // deterministic assembly above already succeeded on the same
    // reference, so anything rejected here came from the model, and it
    // is a guard trip like any other rather than a rejected promise.
    return fallback(
      {
        guard: "output",
        reason: "schema_invalid",
        detail: `rendering rejected the composed section (${error instanceof Error ? error.name : typeof error})`,
      },
      result,
    );
  }

  await recordUsage(repoDeps, input.ref.slug, provider.id, result, null);
  return {
    text,
    usedFallback: false,
    fallback: null,
    provider: provider.id,
    model: result.model,
  };
}

/* -------------------------------------------------------------------------
 * Preparation — one gating pass, shared by both paths.
 * ---------------------------------------------------------------------- */

interface PreparedReply {
  ref: ProductRef;
  templates: ReplyTemplateSet;
  variantText: string | undefined;
  /** The deterministic `{product_resources}` content. Also the source of the two expectations below. */
  resourceSection: string;
  expectedUrls: string[];
  requiredLiterals: string[];
  /** Prose the renderer withheld: guidance the model may read, never text it may emit. */
  withheldProse: string[];
}

function prepare(input: ComposeReplyInput): PreparedReply {
  const ref = input.ref;
  const kind = templateKindFor(ref.category, input.purchased ?? "built");
  const flags: ReplyFlags = { direct: input.direct, discord: input.discord };
  const diy = kind === "diy";

  const variantOption = input.variantText === undefined ? {} : { variantText: input.variantText };
  const resourceSection = renderResourceSectionDeterministic(ref, { diy, ...variantOption });

  return {
    ref,
    templates: getTemplateSet(kind, flags),
    variantText: input.variantText,
    resourceSection,
    // Derived from the rendered string rather than re-walked from the
    // sections: the gating rules (diy-only, build-guide withholding,
    // variant-match needles) then exist in exactly one place, and the
    // composed section is held to what the fallback would actually have
    // produced.
    expectedUrls: extractUrls(resourceSection),
    requiredLiterals: ref.sections
      .flatMap((section) => section.literalBlocks)
      .map((block) => block.text)
      .filter((text) => resourceSection.includes(text)),
    // Whatever prose the renderer chose not to emit — the `Notes*`
    // editorial paragraphs (src/reply/render.ts `isEditorialHeading`),
    // plus the prose of any section this purchase gates away. Read off
    // the rendered string rather than re-testing the heading, so the
    // renderer stays the single authority on which prose is editorial:
    // a copy of that predicate here could drift into forbidding text
    // the deterministic path emits, which would fall back on every
    // faithful completion.
    withheldProse: ref.sections
      .map((section) => section.prose)
      .filter((prose): prose is string => prose !== undefined && !resourceSection.includes(prose)),
  };
}

/** Wraps a resource section in the fixed skeleton. The only place either path builds the final message. */
function assemble(prepared: PreparedReply, arrivalSchedule: string | null, resourceSection: string): string {
  return renderReply({
    ref: prepared.ref,
    templates: prepared.templates,
    arrivalSchedule,
    resourceSection,
    ...(prepared.variantText === undefined ? {} : { variantText: prepared.variantText }),
  });
}

/* -------------------------------------------------------------------------
 * Provider selection and the guarded call.
 * ---------------------------------------------------------------------- */

/**
 * COMPOSE_PROVIDER picks the adapter and nothing else — switching
 * providers is a config change with no code change (issue #13).
 *
 * An unrecognized value falls back to the documented default rather
 * than throwing: a typo in a `vars` entry must not take replies down,
 * and the log line says which value was ignored.
 */
export function selectComposeProvider(deps: ComposeReplyDeps): LlmProvider {
  const configured = deps.env.COMPOSE_PROVIDER;
  if (configured === "claude") {
    return createClaudeProvider({
      apiKey: deps.env.ANTHROPIC_API_KEY,
      fetch: deps.fetch,
      model: deps.env.CLAUDE_MODEL,
    });
  }
  if (configured !== "workers-ai") {
    log("warn", "compose: unrecognized COMPOSE_PROVIDER, using the workers-ai default", {
      configured: String(configured),
    });
  }
  return createWorkersAiProvider({ ai: deps.env.AI });
}

/**
 * The call guard. The deadline race bounds how long *we* wait; the
 * AbortController is what actually cancels the request upstream, where
 * the provider honours it. Both are needed — see
 * src/llm/guards.ts `withDeadline`.
 */
async function callProvider(provider: LlmProvider, request: Omit<LlmRequest, "signal">): Promise<LlmResult> {
  const controller = new AbortController();
  try {
    return await withDeadline(provider.run({ ...request, signal: controller.signal }), COMPOSE_DEADLINE_MS);
  } catch (error) {
    controller.abort();
    throw error;
  }
}

/**
 * Fails **open**: an unreadable budget count is logged and the call
 * proceeds. The guard exists to cap a burst, and one failed read is not
 * a burst — while a D1 outage bounds itself elsewhere, since jobs are
 * claimed from the same database (src/db/repos.ts claimJobs) and none
 * would be claimed to compose in the first place.
 */
async function checkBudget(repoDeps: RepoDeps, cap: number): Promise<GuardTrip | null> {
  try {
    return await checkBudgetGuard(repoDeps, { task: "compose", cap });
  } catch (error) {
    log("error", "compose: budget guard could not read usage_log — proceeding uncapped", {
      error: errorSnippet(error),
    });
    return null;
  }
}

/**
 * The `usage_log` row. Swallows its own failure: the reply has already
 * been produced, and losing the accounting row is strictly better than
 * losing the customer's message over it. A budget guard that then
 * undercounts is the same trade, made once.
 */
async function recordUsage(
  repoDeps: RepoDeps,
  slug: string,
  provider: LlmProviderId,
  result: LlmResult | null,
  fallback: GuardTrip["reason"] | null,
): Promise<void> {
  try {
    await appendUsageLog(repoDeps, {
      slug,
      task: "compose",
      provider,
      model: result?.model ?? null,
      fallback,
      tokensIn: result?.tokensIn ?? null,
      tokensOut: result?.tokensOut ?? null,
    });
  } catch (error) {
    log("error", "compose: usage_log write failed", { slug, error: errorSnippet(error) });
  }
}

/* -------------------------------------------------------------------------
 * The prompt.
 *
 * Never logged, at any level — it embeds the reference body, which is
 * customer-facing business text (CLAUDE.md non-negotiable).
 * ---------------------------------------------------------------------- */

const COMPOSE_SYSTEM_PROMPT = [
  "You assemble the product-resources section of a Japanese purchase-reply message for a modular synthesizer shop.",
  "",
  "You are given the applicable sections of a product reference. Emit ONLY that resources section — the surrounding message (greeting, shipping line, delivery date, review request, closing) is fixed text added afterwards, and restating any of it is an error.",
  "",
  "Rules, all of them absolute:",
  "- Output plain text. No markdown headings, no bullet markers, no code fences, no commentary about what you did.",
  "- Never invent, alter, shorten or drop a URL. Every URL given to you must appear exactly as given; no URL that was not given may appear.",
  "- Write each link as two lines: the title followed by a colon, then the URL alone on the next line.",
  "- Emit sections in the order given. Separate paragraphs with one blank line.",
  `- Where a section has a separator intro, put a line containing only ${RESOURCE_SEPARATOR} above it, then the separator intro text, then that section's links.`,
  "- Reproduce every LITERAL BLOCK character for character, in place. These are pre-written notices; do not translate, summarize, reflow or punctuate them differently.",
  "- Reproduce intro text as given. You may not add explanation, opinion, or sales language of your own.",
  "- Section headings are the shop's own filing system. Never emit them.",
  "- GUIDANCE is written to you, not to the customer. Use it to decide what to include; never reproduce any part of it.",
  "- Reply in Japanese, in the polite register the given text already uses.",
].join("\n");

function buildComposeRequest(prepared: PreparedReply): Omit<LlmRequest, "signal"> {
  return {
    system: COMPOSE_SYSTEM_PROMPT,
    user: buildComposeUserPrompt(prepared),
    maxTokens: COMPOSE_MAX_TOKENS,
  };
}

function buildComposeUserPrompt(prepared: PreparedReply): string {
  const { ref, variantText } = prepared;
  const parts: string[] = [`PRODUCT: ${ref.displayName}`];
  if (variantText !== undefined) parts.push(`PURCHASED VARIANT (as the operator wrote it): ${variantText}`);
  if (prepared.withheldProse.length > 0) {
    parts.push(`GUIDANCE (never reproduce any of this):\n${prepared.withheldProse.join("\n\n")}`);
  }

  for (const section of ref.sections) {
    const body = describeSection(section, prepared);
    if (body !== null) parts.push(body);
  }

  parts.push(
    "Emit the resources section now, following every rule. Nothing before it, nothing after it.",
    // Restated at the end because it is the failure that cannot be
    // walked back: a hallucinated link in a customer message.
    `The output must contain exactly these ${prepared.expectedUrls.length} URL(s), each exactly once, and no others:\n${prepared.expectedUrls.join("\n")}`,
  );
  return `${parts.join("\n\n")}\n`;
}

/**
 * One section as the model sees it — restricted, part by part, to what
 * the deterministic rendering actually emitted.
 *
 * That restriction is the gating: a `diy-only` section on a built
 * purchase, and the Build Guide on a DIY kit (renderReply renders that
 * into its own `{build_guide}` slot — a URL is data to copy, not text
 * for a model to restate), are both absent from `resourceSection` and
 * so are never described. Re-deriving the gate conditions here would be
 * a second copy of rules that already live in src/reply/render.ts, free
 * to drift; reading the rendered string cannot drift from it.
 *
 * Returns null when nothing of the section survives.
 */
function describeSection(section: RefSection, prepared: PreparedReply): string | null {
  const emitted = (text: string): boolean => prepared.resourceSection.includes(text);

  const lines: string[] = [`SECTION: ${section.heading}`];
  if (section.separatorIntro !== undefined && emitted(section.separatorIntro)) {
    lines.push(`SEPARATOR INTRO: ${section.separatorIntro}`);
  }
  if (section.introText !== undefined && emitted(section.introText)) {
    lines.push(`INTRO TEXT: ${section.introText}`);
  }
  for (const resource of section.resources) {
    if (prepared.expectedUrls.includes(resource.url)) lines.push(`LINK: ${resource.title} => ${resource.url}`);
  }
  for (const block of section.literalBlocks) {
    if (prepared.requiredLiterals.includes(block.text)) lines.push(`LITERAL BLOCK (verbatim):\n${block.text}`);
  }

  return lines.length === 1 ? null : lines.join("\n");
}
