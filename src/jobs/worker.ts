/**
 * The delivery worker — one pass claims jobs (src/db/repos.ts
 * claimJobs), composes and posts each to Slack, and updates job state
 * (src/jobs/queue.ts). Invoked both from `ctx.waitUntil` right after ack
 * (src/index.ts fetch — an optimization) and from the cron sweep
 * (src/index.ts scheduled — the contract). See CLAUDE.md "durable intent
 * before the ack".
 *
 * **At-least-once, deliberately.** Slack's `chat.postMessage` and the D1
 * `state = 'done'` write are two systems with no transaction spanning
 * them: this design always posts to Slack *before* recording completion
 * (see deliverClaimedJob below). If the completion write then loses its
 * claim-token fence — because the lease expired mid-post and another
 * worker already reclaimed the row — the message has already gone out
 * and is not retracted. That is a visible duplicate, chosen deliberately
 * over the alternative (ack first, post second: a crash between the two
 * would be a customer reply that silently never sends). Do not "fix"
 * this into ack-then-post.
 *
 * **Composing seam.** `buildReplyJobPayload` below routes every `match`
 * through src/reply/compose.ts `composeReply` (issue #13's guarded LLM
 * path) rather than calling the deterministic renderer directly, and
 * always forwards the injected clock (`now`) plus `purchased`/
 * `variantText` — see composeMatchPayload. `composeReply` is injected
 * (see `ComposeReplyFn` / `RunJobDeps.composeReply`) the same way
 * `fetch`/`now`/`sleep` already are — every test here supplies a
 * deterministic fake rather than exercising the real LLM/Workers AI
 * call, per CLAUDE.md "Dependency injection at every I/O boundary".
 * composeReply itself never throws for a guard trip, a provider outage,
 * or a refusal (it falls back and reports `usedFallback: true` instead)
 * — a throw reaching this module is a genuine caller error (e.g. a
 * `general` reply with `arrivalSchedule: null`) and is left to fail
 * loudly through the normal recordFailure path below, never caught or
 * retried here.
 *
 * **Interactive follow-ups (issue #14).** A `general`/`general-diy`
 * match with no arrival date in the mention text, a `variant-ambiguous`
 * resolver result, and an `ambiguous` resolver result each post a
 * quick-pick message instead of the final reply (src/slack/commands.ts
 * buildArrivalPickerPayload / buildVariantPickerPayload /
 * buildCandidatePickerPayload) — the job still completes (`done`): its
 * job was to respond, and asking a question is a response. The click
 * that follows is handled entirely by src/slack/interactions.ts, using
 * the posted message's own `jobId` (carried in the button's value
 * envelope) to look this job back up and finish composing.
 */
import type { Env } from "../env";
import {
  claimJobs,
  completePolicyDecisionJob,
  getProductRefBySlug,
  recordResolvedContext,
  updateJobState,
  type RepoDeps,
} from "../db/repos";
import { errorSnippet, log } from "../ops/log";
import type { JobRow, JobState } from "../db/schema";
import { findInheritableThreadContext, type InheritedThreadContext } from "./thread-context";
import { resolveProductRef } from "../refs/resolve";
import { parseProductRefMarkdown } from "../refs/parse";
import type { ProductRef } from "../refs/model";
import {
  buildMessagePayload,
  buildReplyBlocks,
  buildReplyMessagePayload,
  escapeMrkdwn,
  type SlackMessagePayload,
} from "../slack/blocks";
import { postMessage, type SlackApiDeps } from "../slack/api";
import {
  buildArrivalPickerPayload,
  buildCandidatePickerPayload,
  buildMissingRefPayload,
  buildVariantPickerPayload,
  computeArrivalPresetOptions,
  NO_PRODUCT_QUERY_REASON,
  parseCommand,
  USAGE_TEXT,
  isAdminUser,
  type ArrivalPresetKey,
  type ReplyModifiers,
} from "../slack/commands";
import { composeReply as defaultComposeReply, type ComposeReplyDeps, type ComposeReplyInput, type ComposeReplyResult } from "../reply/compose";
import { buildRefCommandPayload } from "../refs/commands";
import { polishText as defaultPolishText, type PolishDeps, type PolishInput, type PolishResult } from "../reply/polish";
import { formatArrivalSchedule } from "../reply/templates";
import type { FetchLike, NowFn, SleepFn } from "../types";
import {
  CLAIM_BATCH_SIZE,
  CLAIM_TTL_MS,
  DEFAULT_RETRY_POLICY,
  isValidTransition,
  nextStateAfterFailure,
} from "./queue";
import { runRetentionSweep } from "./retention";
import {
  ensurePolicyPr as defaultEnsurePolicyPr,
  getPolicyFile as defaultGetPolicyFile,
  type EnsurePolicyPrInput,
  type EnsurePolicyPrOutcome,
  type GithubApiDeps,
  type PolicyFile,
} from "../github/api";
import {
  updatePolicy as defaultUpdatePolicy,
  type PolicyUpdateDeps,
  type PolicyUpdateInput,
  type PolicyUpdateResult,
} from "../policy/update";
import { runStashPolicyProposal } from "../policy/proposal";
import { runPolicyHistoryRollback } from "../policy/history-rollback";
import type { StashApi } from "../stash/api";
import { runPolicyDecisionJob } from "../policy/decision";

/** The shape of src/reply/compose.ts's composeReply — injected so tests can fake issue #13's (currently throwing) real implementation. See the module comment. */
export type ComposeReplyFn = (deps: ComposeReplyDeps, input: ComposeReplyInput) => Promise<ComposeReplyResult>;

export interface RunDeliveryPassDeps {
  env: Env;
  fetch: FetchLike;
  now: NowFn;
  /** Injected so Slack retry backoff (see src/slack/api.ts) runs instantly in tests; defaults to a real timer. */
  sleep?: SleepFn;
  /** Injected compose step — defaults to the real src/reply/compose.ts composeReply. See ComposeReplyFn. */
  composeReply?: ComposeReplyFn;
  /** Injected polish step — defaults to the real src/reply/polish.ts polishText. See PolishFn. */
  polishText?: PolishFn;
  getPolicyFile?: GetPolicyFileFn;
  updatePolicy?: UpdatePolicyFn;
  ensurePolicyPr?: EnsurePolicyPrFn;
  stashApi?: StashApi;
  invalidatePolicyCache?: () => void;
}

export interface RunDeliveryPassResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

/**
 * The I/O deps a single job's compose+post needs — the subset of
 * RunDeliveryPassDeps that doesn't include `env` (passed separately,
 * since it also carries bindings like `DB`).
 */
/** Injected the same way as ComposeReplyFn, so tests never reach a provider. */
export type PolishFn = (deps: PolishDeps, input: PolishInput) => Promise<PolishResult>;
export type GetPolicyFileFn = (deps: GithubApiDeps) => Promise<PolicyFile>;
export type UpdatePolicyFn = (deps: PolicyUpdateDeps, input: PolicyUpdateInput) => Promise<PolicyUpdateResult>;
export type EnsurePolicyPrFn = (deps: GithubApiDeps, input: EnsurePolicyPrInput) => Promise<EnsurePolicyPrOutcome>;

export type RunJobDeps = {
  fetch: FetchLike;
  now: NowFn;
  sleep?: SleepFn;
  composeReply?: ComposeReplyFn;
  polishText?: PolishFn;
  getPolicyFile?: GetPolicyFileFn;
  updatePolicy?: UpdatePolicyFn;
  ensurePolicyPr?: EnsurePolicyPrFn;
  stashApi?: StashApi;
  invalidatePolicyCache?: () => void;
};

const POLICY_TITLE_PREFIX = "[policy] ";
const POLICY_TITLE_MAX_CHARS = 60;
const GITHUB_NEUTRALIZER = "\u200d";

/** Single-line, control-free PR title with a 60-code-point ceiling including the prefix. */
export function buildPolicyPrTitle(request: string): string {
  const normalized = request.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  const budget = POLICY_TITLE_MAX_CHARS - Array.from(POLICY_TITLE_PREFIX).length;
  return POLICY_TITLE_PREFIX + Array.from(normalized).slice(0, budget).join("");
}

function neutralizeGithubReferences(text: string): string {
  return text.replace(/[@#]/g, (character) => `${character}${GITHUB_NEUTRALIZER}`);
}

/** Quotes the request while preventing GitHub user mentions and issue references from firing. */
export function buildPolicyPrBody(request: string, slackUserId: string): string {
  const safeRequest = neutralizeGithubReferences(request.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " "));
  const quotedRequest = safeRequest.split("\n").map((line) => `> ${line}`).join("\n");
  const safeUserId = neutralizeGithubReferences(slackUserId.replace(/[^A-Za-z0-9._-]/g, ""));
  return [
    "## Slack request",
    "",
    quotedRequest,
    "",
    `Requested by Slack user \`${safeUserId}\`.`,
    "",
    "Review note: this text is injected into the compose system prompt — review as production copy.",
  ].join("\n");
}

function oneLineRequestEcho(request: string): string {
  return escapeMrkdwn(request.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim());
}

/**
 * Strips a leading `<@BOT_ID>` mention, matching src/slack/events.ts
 * classifyJobKind's pattern — for display text only, never for alias
 * matching (see src/refs/resolve.ts normalizeAlias for that).
 */
const MENTION_PREFIX = /^<@[^>]*>\s*/;
function stripMention(text: string): string {
  return text.replace(MENTION_PREFIX, "").trim();
}

/** A plain mrkdwn `section` message — used for operational replies (help/usage/unknown-command) that are never the customer-facing reply body, so the rich_text_preformatted rule (CLAUDE.md) does not apply. */
function buildTextMessagePayload(text: string, summaryText: string): SlackMessagePayload {
  return buildMessagePayload(
    [{ type: "section", block_id: "bot_text", text: { type: "mrkdwn", text } }],
    summaryText,
  );
}

/**
 * The formatted arrival sentence for an arrival preset typed in a
 * mention, or null when the mention named none (or named one that is no
 * longer a known preset).
 *
 * Split out of composeMatchPayload so a caller can compute the value
 * exactly **once** per job: the reply path both records it into
 * `jobs.resolved_context` and hands it to compose, and deriving it twice
 * from `now()` could disagree across a JST day boundary — the same
 * hazard src/slack/commands.ts encodeArrivalOptionArg exists to avoid.
 */
export function arrivalScheduleFromPreset(arrival: ArrivalPresetKey | null, now: NowFn): string | null {
  if (arrival === null) return null;
  const option = computeArrivalPresetOptions(now).find((candidate) => candidate.preset === arrival);
  if (!option) return null;
  return formatArrivalSchedule({ dayLabel: option.dayLabel, month: option.month, day: option.day });
}

/**
 * Resolves a `match`'d product ref + the mention's modifiers into either
 * a final composed reply, or — when the category needs an arrival date
 * and none is known — the arrival-picker payload instead. Shared by
 * buildReplyJobPayload (the initial post) and
 * src/slack/interactions.ts (finishing after a variant/candidate click),
 * so both paths honor an arrival preset typed in the original mention
 * text the same way.
 *
 * `purchased` (built vs kit) and `rawText` (forwarded as
 * ComposeReplyInput.variantText, which gates `variant-match` literal
 * blocks — e.g. zudo-rail's Lite renewal notice) both go straight
 * through to composeReply; see src/reply/compose.ts ComposeReplyInput.
 *
 * `arrivalSchedule` is the already-decided arrival sentence (a preset
 * typed in *this* mention, or one inherited from the thread — issue
 * #27). It takes precedence; passing null keeps the pre-#27 behaviour of
 * deriving it from `parsed.arrival` here, so an external caller that
 * doesn't know about inheritance is unaffected.
 */
export async function composeMatchPayload(
  env: Env,
  jobId: number,
  ref: ProductRef,
  purchased: "built" | "kit",
  rawText: string,
  parsed: ReplyModifiers,
  deps: RunJobDeps,
  arrivalSchedule: string | null = null,
): Promise<SlackMessagePayload> {
  let effectiveArrival: string | null = null;
  if (ref.category !== "small") {
    effectiveArrival = arrivalSchedule ?? arrivalScheduleFromPreset(parsed.arrival, deps.now);
    if (effectiveArrival === null) {
      return buildArrivalPickerPayload(jobId, deps.now);
    }
  }

  const compose = deps.composeReply ?? defaultComposeReply;
  const composed = await compose(
    // `now` forwarded so composeReply's UTC-day budget window agrees
    // with the rest of this job's clock (src/reply/compose.ts
    // ComposeReplyDeps.now) — never left to default to a real clock here.
    { env, fetch: deps.fetch, now: deps.now },
    { ref, arrivalSchedule: effectiveArrival, discord: parsed.discord, direct: parsed.direct, purchased, variantText: rawText },
  );
  return buildReplyMessagePayload({ replyText: composed.text, summaryText: `${ref.displayName} の返信` });
}

/** The unknown-command reply: the parser's Japanese explanation above the usage text. */
function buildUnknownCommandPayload(reason: string): SlackMessagePayload {
  return buildTextMessagePayload(`${escapeMrkdwn(reason)}\n\n${USAGE_TEXT}`, "コマンドを解釈できませんでした。");
}

/**
 * Finishes a `reply` job whose product is decided — whether the mention
 * named it or the thread supplied it — and records what it resolved to
 * so a later mention in the thread can inherit it (issue #27).
 *
 * The record happens **before** the arrival-picker short-circuit inside
 * composeMatchPayload can fire, because by this point the *product* is
 * resolved even when the arrival date is not: a follow-up mention must
 * be able to inherit the product from a turn that only got as far as
 * asking a question. It is a plain UPDATE keyed on this job's own id, so
 * an at-least-once replay of the same job simply rewrites the same row
 * (see the module comment on the delivery tradeoff).
 *
 * `variant` is the *determined* built/kit choice or null — deliberately
 * not `purchased`'s "built" default, so an inheriting turn can tell
 * "known to be built" apart from "never decided" and ask rather than
 * guess.
 */
async function finishResolvedReply(
  env: Env,
  repoDeps: RepoDeps,
  job: JobRow,
  ref: ProductRef,
  variant: "built" | "kit" | null,
  modifiers: ReplyModifiers,
  inherited: InheritedThreadContext | null,
  deps: RunJobDeps,
): Promise<SlackMessagePayload> {
  // Flags never accumulate across turns (issue #27) — `modifiers` comes
  // wholly from this mention, so `@bot --discord` means discord on and
  // direct off every time. Only the arrival date falls back to the
  // inherited one, and only when this mention named none.
  const arrivalSchedule =
    ref.category === "small"
      ? null
      : (arrivalScheduleFromPreset(modifiers.arrival, deps.now) ?? inherited?.context.arrivalSchedule ?? null);

  // The text that gates `variant-match` literal blocks (e.g. zudo-rail's
  // Lite renewal notice) is the text that *named* the product — this
  // mention normally, or, when this one is modifier-only, whatever the
  // thread is still carrying from the naming turn. Recording it (rather
  // than letting the next turn re-read the prior job's raw_text) is what
  // keeps the notice alive past turn 2 of a chain: turn 3's predecessor
  // is `@bot --discord`, whose text contains no needle at all.
  const variantText = inherited?.variantText ?? job.raw_text;

  await recordResolvedContext(repoDeps, job.id, { slug: ref.slug, variant, arrivalSchedule, variantText });

  return composeMatchPayload(env, job.id, ref, variant ?? "built", variantText, modifiers, deps, arrivalSchedule);
}

/**
 * Builds the Slack payload for a `reply` job. A `small`-category match
 * and a `general`/`general-diy` match that already carries (or is given)
 * an arrival date produce the final reply; `miss` posts the
 * create-a-reference card (epic issue #1 decision 7: "a mention that
 * resolves to no reference does not dead-end"); everything else — no
 * arrival date yet, `variant-ambiguous`, `ambiguous` — posts an
 * interactive quick-pick (see the module comment), and
 * src/slack/interactions.ts finishes the job from there.
 *
 * The mention is parsed **before** it is resolved: a `reply_modifiers`
 * mention (`@bot --discord`) carries no product to resolve, and running
 * the resolver on it first would answer a follow-up with the
 * missing-reference card instead of the thread's product.
 */
async function buildReplyJobPayload(
  env: Env,
  repoDeps: RepoDeps,
  job: JobRow,
  deps: RunJobDeps,
): Promise<SlackMessagePayload> {
  const parsed = parseCommand(job.raw_text, env.SLACK_BOT_USER_ID);

  if (parsed.kind === "help") {
    return buildTextMessagePayload(USAGE_TEXT, "使い方");
  }
  if (parsed.kind === "unknown") {
    return buildUnknownCommandPayload(parsed.reason);
  }

  if (parsed.kind === "reply_modifiers") {
    const inheritable = await findInheritableThreadContext(repoDeps, job);
    // Degradation is the whole safety story here: with no memory, this
    // mention gets byte-for-byte the message it got before inheritance
    // existed. Never a guessed product — a wrong product in a reply the
    // operator pastes to a customer is the worst outcome this feature has.
    if (inheritable === null) return buildUnknownCommandPayload(NO_PRODUCT_QUERY_REASON);

    const refRow = await getProductRefBySlug(repoDeps, inheritable.context.slug);
    // The remembered slug no longer exists (retired between turns) —
    // same degradation, for the same reason.
    if (refRow === null) return buildUnknownCommandPayload(NO_PRODUCT_QUERY_REASON);

    const ref = parseProductRefMarkdown({ slug: refRow.slug, markdown: refRow.body_md });
    // ResolvedJobContext.variant is `string | null` on purpose (a
    // persisted snapshot, not a live resolver result), so narrow it to
    // today's closed union rather than trusting the stored value.
    const storedVariant = inheritable.context.variant;
    const variant = storedVariant === "built" || storedVariant === "kit" ? storedVariant : null;
    if (ref.category === "general-diy" && variant === null) {
      // Inherited a general-diy product whose built/kit choice was never
      // decided. Ask, never default — shipping a built reply for a kit
      // purchase sends the customer the wrong links (src/refs/resolve.ts).
      // Nothing is recorded for this job: asking is not resolving, and the
      // click that answers re-reads the thread (src/jobs/thread-context.ts
      // findClickTimeThreadContext).
      return buildVariantPickerPayload(job.id, ref.displayName);
    }
    return finishResolvedReply(env, repoDeps, job, ref, variant, parsed, inheritable, deps);
  }

  if (parsed.kind !== "reply") {
    // src/slack/events.ts classifyJobKind already routes a text starting
    // with "ref"/"polish" to job.kind "ref"/"polish" before this function
    // is ever reached (see composeAndPost's switch below) — a "reply"-kind
    // job whose own parseCommand disagrees means the two tokenizers have
    // drifted apart, which is a real bug, not a normal runtime state.
    throw new Error(
      `reply job ${job.id}: parseCommand returned "${parsed.kind}" for a job classified as "reply" ` +
        `— classifyJobKind/parseCommand drift`,
    );
  }

  const resolved = await resolveProductRef(repoDeps, job.raw_text);

  if (resolved.kind === "miss") {
    // `job.id` rides along in the button's envelope so the draft the
    // click produces records which mention asked for it (epic #22
    // thread continuity) — see src/slack/commands.ts buildMissingRefPayload.
    return buildMissingRefPayload({ query: stripMention(job.raw_text), originJobId: job.id });
  }
  if (resolved.kind === "variant-ambiguous") {
    const ref = parseProductRefMarkdown({ slug: resolved.slug, markdown: resolved.ref.body_md });
    return buildVariantPickerPayload(job.id, ref.displayName);
  }
  if (resolved.kind === "ambiguous") {
    return buildCandidatePickerPayload(
      job.id,
      resolved.candidates.map((candidate) => candidate.slug),
    );
  }

  // resolved.kind === "match" — this mention named the product, so it
  // inherits nothing even if the thread has memory.
  const ref = parseProductRefMarkdown({ slug: resolved.slug, markdown: resolved.ref.body_md });
  return finishResolvedReply(env, repoDeps, job, ref, resolved.variant ?? null, parsed, null, deps);
}

/**
 * Dispatches a claimed job on `job.kind` and produces the Slack payload
 * to post. Composing and posting are one step here deliberately — see
 * the module comment on the at-least-once tradeoff this implies (a crash
 * between "the text is composed" and "the D1 write says so" replays as a
 * second post attempt, never a silent loss).
 */
/**
 * `@bot polish` + pasted Japanese. Issue #16 owns the transformation
 * (src/reply/polish.ts); this only turns its result into a message.
 *
 * The visible "unavailable" note is not decoration. On any guard trip
 * polishText returns the input **unchanged**, byte for byte — so without a
 * note the operator sees their own text in a code block and has no way to
 * tell it was never polished. That text gets pasted into Mercari verbatim,
 * which makes "looks polished but is not" the failure worth spending a
 * block on. `usedFallback` is the only signal, since the text itself is
 * identical by design.
 */
async function buildPolishJobPayload(env: Env, job: JobRow, deps: RunJobDeps): Promise<SlackMessagePayload> {
  const parsed = parseCommand(job.raw_text, env.SLACK_BOT_USER_ID);
  if (parsed.kind !== "polish") {
    // classifyJobKind said "polish" but the grammar disagrees — report the
    // parser's own Japanese explanation rather than a stack trace.
    const reason = parsed.kind === "unknown" ? parsed.reason : USAGE_TEXT;
    return buildTextMessagePayload(reason, "推敲コマンドを解釈できませんでした");
  }

  const polish = deps.polishText ?? defaultPolishText;
  const result = await polish({ env, fetch: deps.fetch, now: deps.now }, { text: parsed.text });

  const blocks = buildReplyBlocks(result.text);
  if (!result.usedFallback) {
    return buildMessagePayload(blocks, "推敲しました");
  }
  return buildMessagePayload(
    [
      {
        type: "section",
        block_id: "polish_fallback_notice",
        text: { type: "mrkdwn", text: "推敲を実行できませんでした。以下は *元のテキストそのまま* です。" },
      },
      ...blocks,
    ],
    "推敲できませんでした（元のテキストを表示）",
  );
}

/** Runs the admin-only policy rewrite and maps every typed outcome to a Japanese operational reply. */
async function buildPolicyJobPayload(env: Env, job: JobRow, deps: RunJobDeps): Promise<SlackMessagePayload> {
  const parsed = parseCommand(job.raw_text, env.SLACK_BOT_USER_ID);
  if (parsed.kind !== "policy_update") {
    const reason = parsed.kind === "unknown" ? parsed.reason : USAGE_TEXT;
    return buildTextMessagePayload(reason, "ポリシー更新コマンドを解釈できませんでした");
  }
  // Defense in depth: ingress already refuses non-admin policy mentions,
  // but a manually inserted or legacy row must not gain GitHub access.
  if (!isAdminUser(env, job.actor_user_id)) {
    return buildTextMessagePayload("この操作には管理者権限が必要です。", "この操作には管理者権限が必要です。");
  }

  if (parsed.policyCommand !== undefined) {
    // History and rollback are stash-only operations. Their own route checks
    // the complete write configuration and returns a bounded Japanese refusal
    // when it is absent; importantly, they never reach the GitHub fallback.
    return runPolicyHistoryRollback(
      {
        env,
        fetch: deps.fetch,
        now: deps.now,
        stashApi: deps.stashApi,
        invalidatePolicyCache: deps.invalidatePolicyCache,
      },
      { jobId: job.id, attempts: job.attempts, command: parsed.policyCommand },
    );
  }

  // Stash is an opt-in route: both the endpoint and write credential must be
  // present. Any incomplete stash configuration still takes the stash route
  // once both selectors are non-empty, where the proposal module refuses in
  // Japanese rather than silently falling back to GitHub.
  if (typeof env.STASH_BASE_URL === "string" && env.STASH_BASE_URL.length > 0
      && typeof env.STASH_WRITE_TOKEN === "string" && env.STASH_WRITE_TOKEN.length > 0) {
    const proposal = await runStashPolicyProposal(
      {
        env,
        fetch: deps.fetch,
        now: deps.now,
        stashApi: deps.stashApi,
        updatePolicy: deps.updatePolicy,
      },
      { jobId: job.id, request: parsed.request },
    );
    return proposal.payload;
  }

  const githubDeps: GithubApiDeps = { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO, fetch: deps.fetch };
  const getPolicyFile = deps.getPolicyFile ?? defaultGetPolicyFile;
  const updatePolicy = deps.updatePolicy ?? defaultUpdatePolicy;
  const ensurePolicyPr = deps.ensurePolicyPr ?? defaultEnsurePolicyPr;

  const current = await getPolicyFile(githubDeps);
  const proposal = await updatePolicy(
    { env, fetch: deps.fetch, now: deps.now },
    { currentDocument: current.text, request: parsed.request },
  );

  if (proposal.kind === "no_change") {
    return buildTextMessagePayload("変更なしと判断しました。", "ポリシー変更なし");
  }
  if (proposal.kind === "rejected") {
    return buildTextMessagePayload(
      `更新案の検証に失敗しました（${proposal.reason}）。`,
      "ポリシー更新案の検証に失敗しました",
    );
  }

  const pull = await ensurePolicyPr(githubDeps, {
    jobId: String(job.id),
    newContent: proposal.document,
    title: buildPolicyPrTitle(parsed.request),
    body: buildPolicyPrBody(parsed.request, job.actor_user_id),
  });
  if (pull.kind === "conflict") {
    return buildTextMessagePayload(
      `既存のポリシーPRがオープン中です: ${escapeMrkdwn(pull.url)}`,
      "既存のポリシーPRがあります",
    );
  }

  return buildTextMessagePayload(
    `ポリシー更新PRを用意しました: ${escapeMrkdwn(pull.url)}\n> ${oneLineRequestEcho(parsed.request)}`,
    "ポリシー更新PRを用意しました",
  );
}

async function composeAndPost(env: Env, job: JobRow, deps: RunJobDeps): Promise<void> {
  let payload: SlackMessagePayload;
  switch (job.kind) {
    case "reply": {
      const repoDeps: RepoDeps = { db: env.DB, now: deps.now };
      payload = await buildReplyJobPayload(env, repoDeps, job, deps);
      break;
    }
    case "polish": {
      payload = await buildPolishJobPayload(env, job, deps);
      break;
    }
    case "ref": {
      const repoDeps: RepoDeps = { db: env.DB, now: deps.now };
      payload = await buildRefCommandPayload(env, repoDeps, job);
      break;
    }
    case "policy_update": {
      payload = await buildPolicyJobPayload(env, job, deps);
      break;
    }
    case "policy_decision": {
      await runPolicyDecisionJob(env, job, deps);
      return;
    }
  }

  const slackDeps: SlackApiDeps = {
    botToken: env.SLACK_BOT_TOKEN,
    fetch: deps.fetch,
    sleep: deps.sleep,
    // A cron/sweep-style caller can afford the extra latency a 5xx retry
    // costs — see src/slack/api.ts SlackApiDeps.retryServerErrors.
    retryServerErrors: true,
  };
  await postMessage(slackDeps, { channel: job.channel_id, threadTs: job.thread_ts, payload });
}

/**
 * The per-job unit of work: dispatches on `job.kind`, composes, and
 * posts to Slack. Exported per issue #10's stated shape
 * (`runJob(env, job, deps)`); does not touch job state itself — see
 * deliverClaimedJob, which owns every state transition around this call.
 */
export async function runJob(env: Env, job: JobRow, deps: RunJobDeps): Promise<void> {
  await composeAndPost(env, job, deps);
}

/**
 * Fenced state transition: validates the edge against
 * JOB_STATE_TRANSITIONS, writes it, and on a lost fence (lease expired
 * and reclaimed elsewhere) logs the rejection per issue #10 ("log the
 * fence rejection — it means the lease is too short for the real work")
 * rather than throwing, since by this point the caller no longer owns
 * the row and must not touch it further.
 */
async function transition(
  repoDeps: RepoDeps,
  job: JobRow,
  claimToken: string,
  to: JobState,
  extra: { lastError?: string | null; claimExpiresAt?: number; incrementAttempts?: boolean } = {},
): Promise<boolean> {
  if (!isValidTransition(job.state, to)) {
    throw new Error(`jobs: invalid state transition ${job.state} -> ${to} for job ${job.id}`);
  }
  const ok = await updateJobState(repoDeps, { id: job.id, claimToken, state: to, ...extra });
  if (ok) {
    job.state = to;
  } else {
    log("warn", "jobs: fence rejection — lease is too short for the real work", {
      jobId: job.id,
      from: job.state,
      to,
    });
  }
  return ok;
}

/**
 * Records a failed attempt: always parks in `failed` first (the only
 * edge `composing`/`delivering` have toward `dead`), then hops to `dead`
 * when the retry ceiling is reached — see src/jobs/queue.ts's module
 * comment on why `dead` is never reached directly.
 */
async function recordFailure(
  repoDeps: RepoDeps,
  job: JobRow,
  claimToken: string,
  error: unknown,
): Promise<void> {
  const message = errorSnippet(error);
  const nextAttempts = job.attempts + 1;
  const landing = nextStateAfterFailure(nextAttempts, DEFAULT_RETRY_POLICY);
  const claimExpiresAt =
    landing === "failed" ? repoDeps.now().getTime() + DEFAULT_RETRY_POLICY.backoffMs(nextAttempts) : undefined;

  const parked = await transition(repoDeps, job, claimToken, "failed", {
    lastError: message,
    incrementAttempts: true,
    claimExpiresAt,
  });
  if (!parked) return; // fence already logged by transition()

  if (landing === "dead") {
    await transition(repoDeps, job, claimToken, "dead", { lastError: message });
  }
}

/**
 * Runs one claimed job through its full lifecycle: requeue-if-retry,
 * composing, delivering, done — or `failed`/`dead` on any throw. Returns
 * true when the job is considered delivered (the Slack post completed,
 * even if the final `done` write then lost its fence — see the module
 * comment on the at-least-once tradeoff).
 */
async function deliverClaimedJob(
  env: Env,
  repoDeps: RepoDeps,
  job: JobRow,
  claimToken: string,
  deps: RunJobDeps,
): Promise<boolean> {
  // A reclaimed `failed` job has no failed -> composing edge (see
  // src/jobs/queue.ts) — replay the same first hop a fresh job takes.
  if (job.state === "failed") {
    const requeued = await transition(repoDeps, job, claimToken, "pending");
    if (!requeued) return false;
  }

  if (job.kind === "policy_decision") {
    try {
      // Keep the job pending through every external/durable checkpoint.
      // Cron can reclaim pending after lease expiry; composing/delivering
      // are intentionally never used for this kind.
      await runJob(env, job, deps);
    } catch (error) {
      await recordFailure(repoDeps, job, claimToken, error);
      return false;
    }
    const completed = await completePolicyDecisionJob(repoDeps, { id: job.id, claimToken });
    if (!completed) {
      log("warn", "jobs: policy decision completion fence rejected", { jobId: job.id });
    }
    return true;
  }

  const toComposing = await transition(repoDeps, job, claimToken, "composing");
  if (!toComposing) return false;

  try {
    await runJob(env, job, deps);
  } catch (error) {
    await recordFailure(repoDeps, job, claimToken, error);
    return false;
  }

  // The Slack post above already succeeded — composing -> delivering ->
  // done is now a formality to satisfy the state graph (composing has no
  // direct edge to done), not a real observation window. A lost fence
  // from here on is logged by transition() and left alone: the message
  // already sent.
  const toDelivering = await transition(repoDeps, job, claimToken, "delivering");
  if (!toDelivering) return true;

  await transition(repoDeps, job, claimToken, "done");
  return true;
}

/**
 * One delivery pass: claims up to CLAIM_BATCH_SIZE jobs currently
 * `pending` or `failed` (see src/jobs/queue.ts for why `failed` is
 * claimable the same way `pending` is), then runs each through
 * deliverClaimedJob in turn. Called both from `ctx.waitUntil` right
 * after ack (an optimization) and from the cron sweep (the contract) —
 * see the module comment.
 */
export async function runDeliveryPass(deps: RunDeliveryPassDeps): Promise<RunDeliveryPassResult> {
  const repoDeps: RepoDeps = { db: deps.env.DB, now: deps.now };
  const claimToken = crypto.randomUUID();

  const claimed = await claimJobs(repoDeps, {
    states: ["pending", "failed"],
    limit: CLAIM_BATCH_SIZE,
    claimToken,
    claimTtlMs: CLAIM_TTL_MS,
  });

  let succeeded = 0;
  let failed = 0;
  for (const job of claimed) {
    const ok = await deliverClaimedJob(deps.env, repoDeps, job, claimToken, {
      fetch: deps.fetch,
      now: deps.now,
      sleep: deps.sleep,
      composeReply: deps.composeReply,
      // Every dep is forwarded by name here, so a new one added to
      // RunDeliveryPassDeps is silently dropped unless it is listed —
      // there is no type error, the real implementation just runs and
      // tests quietly exercise the provider instead of their fake.
      polishText: deps.polishText,
      getPolicyFile: deps.getPolicyFile,
      updatePolicy: deps.updatePolicy,
      ensurePolicyPr: deps.ensurePolicyPr,
      stashApi: deps.stashApi,
      invalidatePolicyCache: deps.invalidatePolicyCache,
    });
    if (ok) succeeded++;
    else failed++;
  }

  return { claimed: claimed.length, succeeded, failed };
}

/**
 * The cron entry point (src/index.ts scheduled()): sweep the job queue,
 * then run retention. Each phase is caught and logged independently so
 * one failing never blocks the other, and this function itself never
 * rejects — it is always called from `ctx.waitUntil`, and an unhandled
 * rejection there is silent (see src/slack/events.ts's identical
 * catch-and-log pattern for the ack-path optimization call).
 */
export async function runScheduledSweep(deps: RunDeliveryPassDeps): Promise<void> {
  try {
    const result = await runDeliveryPass(deps);
    log("info", "jobs: delivery pass complete", { ...result });
  } catch (error) {
    log("error", "jobs: delivery pass failed during scheduled sweep", { error: errorSnippet(error) });
  }

  try {
    const result = await runRetentionSweep({ db: deps.env.DB, now: deps.now });
    log("info", "jobs: retention sweep complete", { ...result });
  } catch (error) {
    log("error", "jobs: retention sweep failed during scheduled sweep", { error: errorSnippet(error) });
  }
}
