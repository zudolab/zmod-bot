/**
 * `POST /slack/interactions` — Block Kit `block_actions` (button clicks)
 * and `view_submission` (modal, the arrival_other "その他" follow-up)
 * payloads.
 *
 * Slack posts the interaction payload as a **URL-encoded form** with a
 * single `payload` field containing JSON — not a JSON body, unlike
 * src/slack/events.ts. Signature verification still runs over the exact
 * raw request body first, before anything is decoded, for the same
 * reason events.ts's does: verifying a re-serialized body is the classic
 * way this check silently always fails, or worse, always passes.
 *
 * **Ack fast, do the work in the background.** Every branch below
 * returns 200 almost immediately; the actual re-resolve/compose/post
 * work is scheduled via `deps.waitUntil` so it never eats into Slack's
 * 3s interaction budget (issue #14: "Ack within 3s, then do the work").
 *
 * **Idempotency.** Interactions carry no `event_id`. A synthetic id —
 * `(action_id, the button's opaque target id, action_ts)` for a click,
 * `(jobId, view.id)` for a modal submission — is recorded in
 * `slack_event_receipts` via src/db/repos.ts recordInteractionReceipt,
 * the same table + ON CONFLICT DO NOTHING de-dup recordIncomingEvent
 * uses for events, so a double-click or a Slack retry runs the effect
 * exactly once.
 *
 * **Authorization is checked on the click**, not at render time — the
 * person who clicks `ref_approve`/`ref_reject`/`create_reference` is not
 * necessarily the person the bot was originally mentioning, and the two
 * can be minutes apart (issue #14).
 */
import type { Env } from "../env";
import type { RouteContext } from "../router";
import type { FetchLike, NowFn, SleepFn, WaitUntilFn } from "../types";
import { verifySlackSignature } from "./verify";
import {
  ACTION_IDS,
  computeArrivalPresetOptions,
  decodeArrivalOptionArg,
  decodeButtonValue,
  decodePriorChoice,
  encodePriorChoice,
  isAdminUser,
  parseCommand,
  buildArrivalPickerPayload,
  buildVariantPickerPayload,
  type ButtonValueEnvelope,
} from "./commands";
import {
  CREATE_REFERENCE_ACTION_ID,
  buildMessagePayload,
  buildReplyMessagePayload,
  type SlackMessagePayload,
} from "./blocks";
import {
  getJobById,
  getProductRefBySlug,
  getRefDraft,
  recordInteractionReceipt,
  recordResolvedContext,
  type RepoDeps,
} from "../db/repos";
import type { ProductRefRow } from "../db/schema";
import { findClickTimeThreadContext } from "../jobs/thread-context";
import { buildAuthoredRefPayload } from "../refs/commands";
import { resolveProductRef } from "../refs/resolve";
import { parseProductRefMarkdown } from "../refs/parse";
import { approveRefDraft, describeRefDraftOutcome, rejectRefDraft } from "../refs/commands";
import { openView, postEphemeral, postMessage, postToResponseUrl, updateMessage, type SlackApiDeps } from "./api";
import { composeReply as defaultComposeReply, type ComposeReplyDeps, type ComposeReplyInput, type ComposeReplyResult } from "../reply/compose";
import { formatArrivalSchedule } from "../reply/templates";
import { errorSnippet, log } from "../ops/log";

type ComposeReplyFn = (deps: ComposeReplyDeps, input: ComposeReplyInput) => Promise<ComposeReplyResult>;

export interface SlackInteractionsDeps {
  db: D1Database;
  now: NowFn;
  fetch: FetchLike;
  waitUntil: WaitUntilFn;
  /** Injected so Slack retry/backoff (src/slack/api.ts) runs instantly in tests; defaults to a real timer. */
  sleep?: SleepFn;
  /** Injected compose step — defaults to the real src/reply/compose.ts composeReply (issue #13). Tests supply a deterministic fake instead of exercising the real LLM/Workers AI call, matching src/jobs/worker.ts's identical injection. */
  composeReply?: ComposeReplyFn;
}

export async function handleSlackInteractions(context: RouteContext): Promise<Response> {
  return handleSlackInteractionsWithDeps(context.request, context.env, {
    db: context.env.DB,
    now: () => new Date(),
    fetch,
    waitUntil: (promise) => context.ctx.waitUntil(promise),
  });
}

function ack(): Response {
  return new Response(null, { status: 200 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/**
 * The testable core of the interactions handler — every I/O boundary is
 * an injected option rather than read from a Workers runtime, per
 * CLAUDE.md "Dependency injection at every I/O boundary".
 */
export async function handleSlackInteractionsWithDeps(
  request: Request,
  env: Env,
  deps: SlackInteractionsDeps,
): Promise<Response> {
  // Read the raw body exactly once as text and verify before any parsing
  // — see the module comment.
  const rawBody = await request.text();

  let signatureValid: boolean;
  try {
    signatureValid = await verifySlackSignature({
      signingSecret: env.SLACK_SIGNING_SECRET,
      timestamp: request.headers.get("X-Slack-Request-Timestamp") ?? "",
      signature: request.headers.get("X-Slack-Signature") ?? "",
      body: rawBody,
      now: deps.now,
    });
  } catch {
    // A missing/empty signing secret is a deployment error, distinct
    // from a bad signature — see src/slack/verify.ts.
    return new Response("server misconfigured", { status: 500 });
  }
  if (!signatureValid) return new Response("invalid signature", { status: 401 });

  // The body is a URL-encoded form with a single `payload` field
  // containing JSON — not a JSON body (issue #14).
  const form = new URLSearchParams(rawBody);
  const payloadText = form.get("payload");
  if (payloadText === null) return new Response("missing payload field", { status: 400 });

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (!isRecord(payload)) return new Response("invalid payload", { status: 400 });

  const repoDeps: RepoDeps = { db: deps.db, now: deps.now };

  if (payload.type === "block_actions") {
    return handleBlockActions(env, repoDeps, deps, payload);
  }
  if (payload.type === "view_submission") {
    return handleViewSubmission(env, repoDeps, deps, payload);
  }

  // Any interaction type this bot doesn't handle (e.g. a shortcut) is
  // still acknowledged — same "every ignored event returns 200" rule
  // src/slack/events.ts follows.
  return ack();
}

/* -------------------------------------------------------------------------
 * block_actions — button clicks.
 * ---------------------------------------------------------------------- */

interface ClickContext {
  actionId: string;
  actionTs: string;
  value: string;
  userId: string;
  channelId: string;
  messageTs: string;
  responseUrl?: string;
  triggerId?: string;
}

function extractClickContext(payload: Record<string, unknown>): ClickContext | null {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = actions[0];
  if (!isRecord(action)) return null;
  const actionId = stringField(action, "action_id");
  const actionTs = stringField(action, "action_ts");
  if (actionId === "" || actionTs === "") return null;

  const user = payload.user;
  const userId = isRecord(user) ? stringField(user, "id") : "";
  if (userId === "") return null;

  const container = payload.container;
  const channel = payload.channel;
  const message = payload.message;
  const channelId = (isRecord(container) ? stringField(container, "channel_id") : "") || (isRecord(channel) ? stringField(channel, "id") : "");
  const messageTs = (isRecord(container) ? stringField(container, "message_ts") : "") || (isRecord(message) ? stringField(message, "ts") : "");

  return {
    actionId,
    actionTs,
    value: typeof action.value === "string" ? action.value : "",
    userId,
    channelId,
    messageTs,
    responseUrl: typeof payload.response_url === "string" ? payload.response_url : undefined,
    triggerId: typeof payload.trigger_id === "string" ? payload.trigger_id : undefined,
  };
}

/**
 * Recovers what a `create_reference` click needs: the search query, and
 * the reply job that offered the button (epic #22 — it becomes the
 * draft's `origin_job_id`).
 *
 * Two shapes reach here, and both are legitimate:
 *
 * - **Envelope** (issue #25 onward) — `id` is the originating `jobs.id`,
 *   `a` the query.
 * - **Plain string** (a button rendered before that change, still sitting
 *   in channel history) — the whole value is the query, and there is no
 *   origin to record. decodeButtonValue returns null for it rather than
 *   throwing, so this is an ordinary case, not an error.
 *
 * Returns null only for the third, illegitimate shape: something that
 * decoded as our envelope but whose `id` is not a job number.
 */
function createReferenceOrigin(
  rawValue: string,
  envelope: ButtonValueEnvelope | null,
): { query: string; originJobId: number | null } | null {
  if (!envelope) return { query: rawValue, originJobId: null };
  const originJobId = Number(envelope.id);
  if (!Number.isInteger(originJobId) || originJobId <= 0) return null;
  return { query: envelope.a ?? "", originJobId };
}

async function handleBlockActions(
  env: Env,
  repoDeps: RepoDeps,
  deps: SlackInteractionsDeps,
  payload: Record<string, unknown>,
): Promise<Response> {
  const click = extractClickContext(payload);
  if (!click) return ack();

  // Idempotency — issue #14: key on (action_id, opaque target id,
  // action_ts). The envelope's `id` is the opaque target when the value
  // decodes as our envelope; otherwise the raw value stands in for it.
  //
  // Since issue #25 CREATE_REFERENCE_ACTION_ID also carries an envelope,
  // whose `id` is the originating job — so two miss offers from two
  // different mentions key apart even if Slack hands them the same
  // `action_ts`, where the old plain-string value would have collided
  // whenever both mentions searched for the same text. The `??` fallback
  // stays load-bearing regardless: decodeButtonValue returns null (never
  // throws) for a plain string, which is exactly what a create_reference
  // button rendered *before* this change still sends, and that click must
  // keep deduping on its query text.
  const envelopeForKey = decodeButtonValue(click.value);
  const receiptId = `interaction:${click.actionId}:${envelopeForKey?.id ?? click.value}:${click.actionTs}`;
  const isNew = await recordInteractionReceipt(repoDeps, { id: receiptId, eventType: "block_actions" });
  if (!isNew) return ack(); // duplicate click or Slack retry — already handled once

  const slackApiDeps: SlackApiDeps = { botToken: env.SLACK_BOT_TOKEN, fetch: deps.fetch, sleep: deps.sleep };

  if (click.actionId === ACTION_IDS.refApprove || click.actionId === ACTION_IDS.refReject || click.actionId === CREATE_REFERENCE_ACTION_ID) {
    if (!isAdminUser(env, click.userId)) {
      deps.waitUntil(
        postEphemeral(slackApiDeps, {
          channel: click.channelId,
          user: click.userId,
          payload: buildTextPayload("この操作には管理者権限が必要です。"),
        }).catch((error) => log("error", "interactions: non-admin refusal failed to post", { error: errorText(error) })),
      );
      return ack();
    }
  }

  if (click.actionId === ACTION_IDS.refApprove || click.actionId === ACTION_IDS.refReject) {
    const draftId = envelopeForKey?.id ?? "";
    const approve = click.actionId === ACTION_IDS.refApprove;
    deps.waitUntil(
      handleRefDraftDecision(env, repoDeps, deps, slackApiDeps, {
        draftId,
        approve,
        actorUserId: click.userId,
        channelId: click.channelId,
        messageTs: click.messageTs,
      }).catch((error) => log("error", "interactions: ref draft decision failed", { error: errorText(error) })),
    );
    return ack();
  }

  if (click.actionId === CREATE_REFERENCE_ACTION_ID) {
    // The implicit authoring path (issue #17): a mention that resolved to
    // no reference offered this button, and clicking it drafts one.
    //
    // Since issue #25 the button carries an envelope — `id` is the
    // originating job, `a` the search query (src/slack/commands.ts
    // buildMissingRefPayload). A button rendered before that change sends
    // the bare query string instead, which decodes to null; that path
    // still authors, just with no origin to record.
    const origin = createReferenceOrigin(click.value, envelopeForKey);
    if (!origin) {
      // A value that decoded as our envelope but whose `id` is not a job
      // number is a bug or a tampered click, not a stale button. Refuse
      // rather than draft against a bogus origin — a wrong origin_job_id
      // silently mis-attributes the draft, which is worse than no draft.
      // Snippet-ed, not spread: a tampered `id` is unbounded caller-controlled text.
      log("error", "interactions: create_reference envelope carried a non-numeric job id", {
        id: errorSnippet(envelopeForKey?.id ?? ""),
      });
      deps.waitUntil(
        postEphemeral(slackApiDeps, {
          channel: click.channelId,
          user: click.userId,
          payload: buildTextPayload("このボタンは読み取れませんでした。`@bot ref new <検索語>` で作成してください。"),
        }).catch((error) => log("error", "interactions: create_reference refusal failed to post", { error: errorText(error) })),
      );
      return ack();
    }

    // Authoring fetches several pages and calls the stronger model, so it
    // can run for tens of seconds. The interim ephemeral exists because a
    // button that sits silent that long reads as broken, and the operator
    // clicks it again — which the receipt above would then swallow as a
    // duplicate, leaving them with nothing at all.
    const query = origin.query;
    deps.waitUntil(
      (async () => {
        await postEphemeral(slackApiDeps, {
          channel: click.channelId,
          user: click.userId,
          payload: buildTextPayload(`「${query}」のリファレンスを作成しています。少しお待ちください。`),
        });
        const payload = await buildAuthoredRefPayload(
          env,
          repoDeps,
          { mode: "new", query },
          click.userId,
          { fetch: deps.fetch, originJobId: origin.originJobId },
        );
        await postMessage(slackApiDeps, {
          channel: click.channelId,
          threadTs: click.messageTs,
          payload,
        });
      })().catch((error) => log("error", "interactions: create_reference authoring failed", { error: errorText(error) })),
    );
    return ack();
  }

  if (click.actionId === ACTION_IDS.arrivalOther) {
    const envelope = decodeButtonValue(click.value);
    if (!envelope || !click.triggerId) return ack();
    deps.waitUntil(
      openArrivalModal(slackApiDeps, {
        triggerId: click.triggerId,
        jobId: envelope.id,
        channelId: click.channelId,
        messageTs: click.messageTs,
        // Carried forward from a chained variant_pick/candidate_pick
        // click, so the modal's view_submission doesn't lose it either
        // — see ButtonValueEnvelope.p.
        priorChoice: envelope.p,
      }).catch((error) => log("error", "interactions: openArrivalModal failed", { error: errorText(error) })),
    );
    return ack();
  }

  if (click.actionId.startsWith(ACTION_IDS.arrivalPick)) {
    const envelope = decodeButtonValue(click.value);
    const parts = envelope?.a ? decodeArrivalOptionArg(envelope.a) : null;
    if (!envelope || !parts) return ack();
    // A variant_pick/candidate_pick click for a product that *also*
    // needed an arrival date chains into this same picker (see
    // finishReplyAfterInteraction below) — recover that choice here
    // rather than letting the re-resolution below silently lose it
    // (issue #12; for variant_pick specifically this defaulted to
    // "built" even when the customer had just clicked "kit").
    const prior = decodePriorChoice(envelope.p);
    deps.waitUntil(
      finishReplyAfterInteraction(env, repoDeps, deps, {
        jobId: Number(envelope.id),
        arrivalSchedule: formatArrivalSchedule(parts),
        candidateSlugOverride: prior.candidateSlug,
        variantOverride: prior.variant,
        channelId: click.channelId,
        messageTs: click.messageTs,
        responseUrl: click.responseUrl,
      }).catch((error) => log("error", "interactions: arrival_pick failed", { error: errorText(error) })),
    );
    return ack();
  }

  if (click.actionId.startsWith(ACTION_IDS.variantPick)) {
    const envelope = decodeButtonValue(click.value);
    if (!envelope || (envelope.a !== "built" && envelope.a !== "kit")) return ack();
    deps.waitUntil(
      finishReplyAfterInteraction(env, repoDeps, deps, {
        jobId: Number(envelope.id),
        arrivalSchedule: null,
        variantOverride: envelope.a,
        channelId: click.channelId,
        messageTs: click.messageTs,
        responseUrl: click.responseUrl,
      }).catch((error) => log("error", "interactions: variant_pick failed", { error: errorText(error) })),
    );
    return ack();
  }

  if (click.actionId.startsWith(ACTION_IDS.candidatePick)) {
    const envelope = decodeButtonValue(click.value);
    if (!envelope || !envelope.a) return ack();
    deps.waitUntil(
      finishReplyAfterInteraction(env, repoDeps, deps, {
        jobId: Number(envelope.id),
        arrivalSchedule: null,
        candidateSlugOverride: envelope.a,
        channelId: click.channelId,
        messageTs: click.messageTs,
        responseUrl: click.responseUrl,
      }).catch((error) => log("error", "interactions: candidate_pick failed", { error: errorText(error) })),
    );
    return ack();
  }

  // Unknown/future action_id — ignore, still ack 200 (CLAUDE.md "every
  // ignored event returns 200").
  return ack();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildTextPayload(text: string): SlackMessagePayload {
  return buildMessagePayload([{ type: "section", block_id: "bot_text", text: { type: "mrkdwn", text } }], text);
}

async function updateOriginalMessage(
  deps: SlackInteractionsDeps,
  slackApiDeps: SlackApiDeps,
  ctx: { channelId: string; messageTs: string; responseUrl?: string },
  payload: SlackMessagePayload,
): Promise<void> {
  if (ctx.responseUrl) {
    try {
      await postToResponseUrl(
        { fetch: deps.fetch, sleep: deps.sleep },
        { responseUrl: ctx.responseUrl, payload: { text: payload.text, blocks: payload.blocks, replace_original: true } },
      );
      return;
    } catch (error) {
      log("warn", "interactions: response_url update failed, falling back to chat.update", { error: errorText(error) });
    }
  }
  if (ctx.channelId && ctx.messageTs) {
    await updateMessage(slackApiDeps, { channel: ctx.channelId, ts: ctx.messageTs, payload });
  }
}

/* -------------------------------------------------------------------------
 * ref_approve / ref_reject.
 * ---------------------------------------------------------------------- */

/**
 * Approve or reject a pending reference edit.
 *
 * **A refusal writes nothing — not even `consumed_at`.** The four ways
 * an approval can be refused (draft gone/expired, `base_version` no
 * longer current, body no longer parses, an alias owned by another
 * product) all leave the draft intact so the operator can fix the cause
 * and click the same button again. Only a reject, or a successful
 * commit, consumes it — and the commit consumes it *inside the same
 * `db.batch()`* that does the write, so the two can never disagree.
 *
 * Refusals go out as an ephemeral to the clicker, leaving the preview in
 * place; a decision (approved / rejected) replaces the preview message,
 * so its buttons stop being clickable-looking once they no longer mean
 * anything. Both are best-effort chrome around a write that has already
 * happened-or-not in D1 — never the record of it.
 *
 * The admin gate runs at the call site (see handleBlockActions), on the
 * click rather than at render time.
 */
async function handleRefDraftDecision(
  env: Env,
  repoDeps: RepoDeps,
  deps: SlackInteractionsDeps,
  slackApiDeps: SlackApiDeps,
  ctx: { draftId: string; approve: boolean; actorUserId: string; channelId: string; messageTs: string },
): Promise<void> {
  if (!ctx.draftId) return;

  if (!ctx.approve) {
    const rejected = await rejectRefDraft(repoDeps, ctx.draftId);
    if (!rejected) {
      await tryEphemeral(slackApiDeps, ctx, describeRefDraftOutcome({ kind: "gone" }));
      return;
    }
    await tryUpdate(slackApiDeps, ctx, buildTextPayload(`「${rejected.slug}」の変更をキャンセルしました。`));
    return;
  }

  const outcome = await approveRefDraft(repoDeps, ctx.draftId, ctx.actorUserId);
  const message = describeRefDraftOutcome(outcome);
  if (outcome.kind !== "committed") {
    // Every refusal (gone/expired, stale base_version, unparseable body,
    // alias conflict, lost race) wrote nothing, so there is nothing to
    // resume from -- the reply resume below is downstream of the COMMIT,
    // never of the click.
    await tryEphemeral(slackApiDeps, ctx, message);
    return;
  }

  // The preview update and the origin-thread reply are two independent
  // deliveries: a Slack failure replacing the preview must not cost the
  // customer-facing reply the mention actually asked for (epic #22 / issue
  // #26). Hence the catch here rather than one try around both.
  try {
    await tryUpdate(slackApiDeps, ctx, buildTextPayload(message));
  } catch (error) {
    log("warn", "interactions: approval preview update failed; continuing to the origin-thread reply", {
      error: errorText(error),
    });
  }
  await resumeOriginReply(env, repoDeps, deps, slackApiDeps, ctx.draftId);
}

/**
 * Closes the loop opened in issue #21: a mention resolved to no reference,
 * the bot offered `create_reference`, an admin authored one and just
 * approved it -- so now post the reply that mention originally asked for,
 * into its own thread.
 *
 * Reached only from a **successful commit**. `commitRefDraft` stamps
 * `consumed_at` inside the same `db.batch()` as the write
 * (src/db/repos.ts), and approveRefDraft refuses outright on an
 * already-consumed draft, so a second approve click never reaches the
 * commit and therefore never reaches here. That existing fence is the
 * double-post guard; there is deliberately no second mechanism.
 *
 * **Delivery is at-most-once, by decision.** If the Worker dies or Slack
 * fails terminally after the commit, this reply is lost with no retry --
 * `consumed_at` is already stamped, so clicking approve again refuses. The
 * operator's recovery is to mention the product again, which now resolves
 * to a `match`. An outbox for this one path is disproportionate to a rare
 * failure with a trivial manual recovery. This is not an oversight.
 *
 * The origin job row is guaranteed to still exist: a draft lives 30
 * minutes (its `expires_at` TTL), far inside the 7-day retention window
 * for `done` jobs (src/jobs/retention.ts), so a draft live enough to
 * approve cannot outlive the job that spawned it.
 *
 * Posting rather than updating is the whole point -- updateOriginalMessage
 * would rewrite the approval preview, which lives wherever the admin
 * clicked, not in the customer's thread.
 */
async function resumeOriginReply(
  env: Env,
  repoDeps: RepoDeps,
  deps: SlackInteractionsDeps,
  slackApiDeps: SlackApiDeps,
  draftId: string,
): Promise<void> {
  // Re-read post-commit: the row survives the commit with `consumed_at`
  // stamped, so this costs one query only on the success path.
  const draft = await getRefDraft(repoDeps, draftId);
  const originJobId = draft?.origin_job_id ?? null;
  // No origin -- an explicit `@bot ref new/refresh`, or a create_reference
  // button rendered before issue #25. Nothing asked for a reply; approving
  // is the whole interaction.
  if (originJobId === null) return;

  const job = await getJobById(repoDeps, originJobId);
  if (!job) {
    log("warn", "interactions: origin job missing for approved draft", { jobId: originJobId });
    return;
  }

  // No overrides: re-resolving from the original mention is exactly what a
  // fresh mention would now do, and the alias the approval just registered
  // is what makes it hit. A miss here (the authored aliases do not cover
  // the typed text) posts nothing and logs -- same manual recovery as any
  // other lost delivery above.
  const payload = await buildFinishReplyPayload(env, repoDeps, deps, { jobId: job.id, arrivalSchedule: null });
  if (!payload) return;

  await postMessage(slackApiDeps, { channel: job.channel_id, threadTs: job.thread_ts, payload });
}

async function tryUpdate(
  slackApiDeps: SlackApiDeps,
  ctx: { channelId: string; messageTs: string },
  payload: SlackMessagePayload,
): Promise<void> {
  if (!ctx.channelId || !ctx.messageTs) return;
  await updateMessage(slackApiDeps, { channel: ctx.channelId, ts: ctx.messageTs, payload });
}

/** Refusal feedback for the clicker only, leaving the preview message untouched so the same button can be clicked again once the cause is fixed. */
async function tryEphemeral(
  slackApiDeps: SlackApiDeps,
  ctx: { channelId: string; actorUserId: string },
  text: string,
): Promise<void> {
  if (!ctx.channelId) return;
  await postEphemeral(slackApiDeps, { channel: ctx.channelId, user: ctx.actorUserId, payload: buildTextPayload(text) });
}

/* -------------------------------------------------------------------------
 * arrival_pick / variant_pick / candidate_pick — finish composing.
 * ---------------------------------------------------------------------- */

/** What a reply payload can be built from: a job, plus whatever a click already pinned down. */
interface BuildReplyPayloadInput {
  jobId: number;
  /** Already-resolved (from an arrival_pick click or the arrival_other modal), or null to fall back to the original mention's typed preset, or to ask again. */
  arrivalSchedule: string | null;
  variantOverride?: "built" | "kit";
  candidateSlugOverride?: string;
}

interface FinishReplyContext extends BuildReplyPayloadInput {
  channelId: string;
  messageTs: string;
  responseUrl?: string;
}

/**
 * Re-resolves a reply job (from its own text, or, for a modifier-only
 * mention, from the thread it inherited from) and builds the message it
 * should now show — **either** the composed reply **or** the arrival picker, whichever the
 * resolution leaves it needing. Returns null when nothing can be built
 * (job gone, parse drift, product no longer resolvable), having logged
 * why.
 *
 * Deliberately knows nothing about delivery: its two callers post the
 * result to different places — finishReplyAfterInteraction replaces the
 * clicked message, resumeOriginReply posts into the origin thread (issue
 * #26). Callers must handle **both** shapes: a freshly authored reference
 * is frequently `general`, which needs an arrival date, so the picker is
 * the common case there, not the exception.
 *
 * Also where `jobs.resolved_context` is written for the interaction path
 * (epic #22): a job finished by a variant/candidate/arrival click is often
 * the most recent reply job in its thread, and the variant a click chose
 * appears nowhere in `raw_text` — so without this the next mention in the
 * thread would have nothing to inherit. Mirrors what src/jobs/worker.ts
 * writes from the non-interactive path.
 */
async function buildFinishReplyPayload(
  env: Env,
  repoDeps: RepoDeps,
  deps: SlackInteractionsDeps,
  ctx: BuildReplyPayloadInput,
): Promise<SlackMessagePayload | null> {
  const job = await getJobById(repoDeps, ctx.jobId);
  if (!job) {
    log("warn", "interactions: job not found for click", { jobId: ctx.jobId });
    return null;
  }

  const parsed = parseCommand(job.raw_text, env.SLACK_BOT_USER_ID);
  // `reply_modifiers` (`@bot --discord`, issue #27) is as legitimate here
  // as `reply`: such a turn posts a picker whenever the context it
  // inherited has no arrival date, or an undecided general-diy variant —
  // and the click that answers lands right here. Treating it as drift
  // made that click a silent no-op.
  if (parsed.kind !== "reply" && parsed.kind !== "reply_modifiers") {
    log("error", "interactions: parseCommand drift for job on click", { jobId: ctx.jobId, parsedKind: parsed.kind });
    return null;
  }

  let refRow: ProductRefRow | null = null;
  /**
   * The *determined* built/kit choice, or null for "never decided" —
   * deliberately not defaulted to "built" here, because this is what gets
   * persisted as ResolvedJobContext.variant and a later turn in the thread
   * must be able to tell the two apart (see that field's doc comment).
   * Only the compose call below falls back to "built".
   */
  let decidedVariant: "built" | "kit" | null = null;
  /** A general-diy product whose variant this path has not decided — ask rather than guess. */
  let variantUndecided = false;
  // Defaults to this job's own text, and is replaced by the thread's when
  // the mention named no product — see ResolvedJobContext.variantText.
  let variantText = job.raw_text;
  /** The arrival date the thread already knows, for a modifier-only mention. Lowest precedence — see the arrival resolution below. */
  let inheritedArrival: string | null = null;
  if (ctx.candidateSlugOverride) {
    refRow = await getProductRefBySlug(repoDeps, ctx.candidateSlugOverride);
    // The chosen candidate could itself be a general-diy product with an
    // as-yet-undetermined variant, but there is no second round of
    // disambiguation here — compose falls back to "built", same as
    // src/jobs/worker.ts composeMatchPayload's `resolved.variant ?? "built"`.
    // What is *recorded* stays null, so the next turn in the thread asks
    // instead of inheriting a guess.
  } else if (parsed.kind === "reply_modifiers") {
    // A modifier-only mention names no product, so re-resolving its
    // raw_text would resolve nothing. The product came from the thread —
    // read it back from where the delivery worker recorded it, which is
    // also the only place the variant-gating text still lives.
    const inherited = await findClickTimeThreadContext(repoDeps, job);
    if (inherited) {
      refRow = await getProductRefBySlug(repoDeps, inherited.context.slug);
      const storedVariant = inherited.context.variant;
      if (storedVariant === "built" || storedVariant === "kit") decidedVariant = storedVariant;
      variantText = inherited.variantText;
      inheritedArrival = inherited.context.arrivalSchedule;
    }
  } else {
    const resolved = await resolveProductRef(repoDeps, job.raw_text);
    if (resolved.kind === "match") {
      refRow = resolved.ref;
      decidedVariant = resolved.variant ?? null;
    } else if (resolved.kind === "variant-ambiguous") {
      refRow = resolved.ref;
      // Nothing has decided built vs kit. Reachable from a *click* only in
      // theory (a variant-ambiguous job posts the variant picker first, and
      // that click supplies ctx.variantOverride below), but resumeOriginReply
      // reaches it for real: a just-authored reference is frequently
      // general-diy, and defaulting to "built" there would send the customer
      // the wrong links (src/refs/resolve.ts).
      variantUndecided = true;
    }
  }
  if (ctx.variantOverride) {
    decidedVariant = ctx.variantOverride;
    variantUndecided = false;
  }
  if (!refRow) {
    log("warn", "interactions: could not re-resolve product for click", { jobId: ctx.jobId });
    return null;
  }

  const ref = parseProductRefMarkdown({ slug: refRow.slug, markdown: refRow.body_md });

  if (variantUndecided) {
    // Ask, never guess — and record nothing: asking is not resolving, the
    // same rule src/jobs/worker.ts applies to its own variant-picker branch.
    return buildVariantPickerPayload(job.id, ref.displayName);
  }

  const purchased: "built" | "kit" = decidedVariant ?? "built";

  let arrivalSchedule = ctx.arrivalSchedule;
  if (arrivalSchedule === null && parsed.arrival !== null) {
    // The original mention already specified an arrival preset (e.g.
    // "明後日") — a variant/candidate pick shouldn't re-ask for it.
    const option = computeArrivalPresetOptions(deps.now).find((candidate) => candidate.preset === parsed.arrival);
    if (option) {
      arrivalSchedule = formatArrivalSchedule({ dayLabel: option.dayLabel, month: option.month, day: option.day });
    }
  }
  // Lowest precedence, and only ever set for a modifier-only mention:
  // the click chose > this mention typed > the thread remembers. Same
  // order src/jobs/worker.ts finishResolvedReply applies, so the click
  // path never re-asks for a date the delivery path would have inherited.
  if (arrivalSchedule === null) arrivalSchedule = inheritedArrival;
  // The `small` template has no arrival sentence (Nekopos has no delivery
  // date) and renderReply *throws* if handed one — which on this path
  // means a click that silently does nothing. src/jobs/worker.ts
  // composeMatchPayload drops the date the same way for the same reason;
  // this is its mirror.
  if (ref.category === "small") arrivalSchedule = null;

  if (ref.category !== "small" && arrivalSchedule === null) {
    // Resolved which product/variant, but still need an arrival date --
    // chain into the same picker the initial reply-job post would have
    // shown (src/jobs/worker.ts composeMatchPayload's mirror image).
    // job.raw_text never changes, so if *this* resolution came from a
    // candidate/variant click rather than an unambiguous match, that
    // choice must ride along on the picker's own buttons (issue #12) --
    // otherwise the arrival_pick click that follows re-derives the
    // product from the still-ambiguous raw text and silently loses it.
    const priorChoice = ctx.candidateSlugOverride
      ? encodePriorChoice({ kind: "candidate", slug: ctx.candidateSlugOverride })
      : ctx.variantOverride
        ? encodePriorChoice({ kind: "variant", variant: ctx.variantOverride })
        : undefined;
    // The product is settled even though the date is not, so record it now
    // rather than only after the arrival click — the thread's memory should
    // not depend on the operator finishing the picker.
    await recordResolvedContext(repoDeps, job.id, {
      slug: ref.slug,
      variant: decidedVariant,
      arrivalSchedule: null,
      variantText,
    });
    return buildArrivalPickerPayload(job.id, deps.now, priorChoice);
  }

  await recordResolvedContext(repoDeps, job.id, { slug: ref.slug, variant: decidedVariant, arrivalSchedule, variantText });

  const compose = deps.composeReply ?? defaultComposeReply;
  const composed = await compose(
    // `now` forwarded so composeReply's UTC-day budget window agrees
    // with the rest of this job's clock — src/reply/compose.ts
    // ComposeReplyDeps.now.
    { env, fetch: deps.fetch, now: deps.now },
    { ref, arrivalSchedule, discord: parsed.discord, direct: parsed.direct, purchased, variantText },
  );
  return buildReplyMessagePayload({ replyText: composed.text, summaryText: `${ref.displayName} の返信` });
}

/**
 * The click path: rebuild the reply and replace the message the click came
 * from. Behaviour is unchanged from before the split — the build half now
 * lives in buildFinishReplyPayload so the approval resume can reuse it
 * (issue #26).
 */
async function finishReplyAfterInteraction(
  env: Env,
  repoDeps: RepoDeps,
  deps: SlackInteractionsDeps,
  ctx: FinishReplyContext,
): Promise<void> {
  const payload = await buildFinishReplyPayload(env, repoDeps, deps, ctx);
  if (!payload) return;
  const slackApiDeps: SlackApiDeps = { botToken: env.SLACK_BOT_TOKEN, fetch: deps.fetch, sleep: deps.sleep };
  await updateOriginalMessage(deps, slackApiDeps, ctx, payload);
}

/* -------------------------------------------------------------------------
 * arrival_other -- modal.
 * ---------------------------------------------------------------------- */

const ARRIVAL_MODAL_CALLBACK_ID = "arrival_other_modal";

interface ArrivalModalMetadata {
  jobId: string;
  channelId: string;
  messageTs: string;
  /** Carried forward from a chained variant_pick/candidate_pick click — see ButtonValueEnvelope.p. */
  priorChoice?: string;
}

function encodeModalMetadata(meta: ArrivalModalMetadata): string {
  return JSON.stringify(meta);
}

function decodeModalMetadata(raw: string): ArrivalModalMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const jobId = stringField(parsed, "jobId");
  const channelId = stringField(parsed, "channelId");
  const messageTs = stringField(parsed, "messageTs");
  if (jobId === "") return null;
  const priorChoice = stringField(parsed, "priorChoice");
  return { jobId, channelId, messageTs, ...(priorChoice === "" ? {} : { priorChoice }) };
}

async function openArrivalModal(
  slackApiDeps: SlackApiDeps,
  ctx: { triggerId: string; jobId: string; channelId: string; messageTs: string; priorChoice?: string },
): Promise<void> {
  await openView(slackApiDeps, {
    triggerId: ctx.triggerId,
    view: {
      type: "modal",
      callback_id: ARRIVAL_MODAL_CALLBACK_ID,
      private_metadata: encodeModalMetadata({
        jobId: ctx.jobId,
        channelId: ctx.channelId,
        messageTs: ctx.messageTs,
        ...(ctx.priorChoice === undefined ? {} : { priorChoice: ctx.priorChoice }),
      }),
      title: { type: "plain_text", text: "到着予定日" },
      submit: { type: "plain_text", text: "送信" },
      close: { type: "plain_text", text: "キャンセル" },
      blocks: [
        {
          type: "input",
          block_id: "day_label_block",
          label: { type: "plain_text", text: "到着予定日（曜日つき）" },
          element: {
            type: "plain_text_input",
            action_id: "day_label",
            placeholder: { type: "plain_text", text: "例: 来週月曜" },
          },
        },
        {
          type: "input",
          block_id: "date_block",
          label: { type: "plain_text", text: "日付 (M/D)" },
          element: {
            type: "plain_text_input",
            action_id: "date",
            placeholder: { type: "plain_text", text: "例: 8/25" },
          },
        },
      ],
    },
  });
}

function extractModalFieldValue(view: Record<string, unknown>, blockId: string, actionId: string): string {
  const state = view.state;
  if (!isRecord(state)) return "";
  const values = state.values;
  if (!isRecord(values)) return "";
  const block = values[blockId];
  if (!isRecord(block)) return "";
  const field = block[actionId];
  if (!isRecord(field)) return "";
  return stringField(field, "value");
}

async function handleViewSubmission(
  env: Env,
  repoDeps: RepoDeps,
  deps: SlackInteractionsDeps,
  payload: Record<string, unknown>,
): Promise<Response> {
  const view = payload.view;
  if (!isRecord(view) || view.callback_id !== ARRIVAL_MODAL_CALLBACK_ID) return ack();

  const privateMetadata = stringField(view, "private_metadata");
  const metadata = privateMetadata ? decodeModalMetadata(privateMetadata) : null;
  if (!metadata) return ack();

  const user = payload.user;
  const userId = isRecord(user) ? stringField(user, "id") : "";
  if (userId === "") return ack();

  const dayLabel = extractModalFieldValue(view, "day_label_block", "day_label").trim();
  const dateText = extractModalFieldValue(view, "date_block", "date").trim();
  const [monthText, dayText] = dateText.split("/");
  const month = Number(monthText);
  const day = Number(dayText);

  const errors: Record<string, string> = {};
  if (dayLabel === "") errors.day_label_block = "到着予定日を入力してください。";
  if (!Number.isInteger(month) || !Number.isInteger(day)) {
    errors.date_block = "M/D の形式で入力してください（例: 8/25）。";
  }
  if (Object.keys(errors).length > 0) {
    // Surfaces the error back into the still-open modal instead of
    // silently dropping it — Slack's documented view_submission
    // validation-error response.
    return Response.json({ response_action: "errors", errors });
  }

  let arrivalSchedule: string;
  try {
    arrivalSchedule = formatArrivalSchedule({ dayLabel, month, day });
  } catch {
    return Response.json({ response_action: "errors", errors: { date_block: "日付が不正です。" } });
  }

  // Idempotency, checked only after validation succeeds -- Slack keeps
  // the same view.id across a validation-error retry within one modal
  // session, so recording a receipt for an invalid attempt would lock
  // out the corrected resubmission that follows it.
  const viewId = stringField(view, "id");
  if (viewId === "") return ack();
  const receiptId = `interaction:${ACTION_IDS.arrivalOther}_submit:${metadata.jobId}:${viewId}`;
  const isNew = await recordInteractionReceipt(repoDeps, { id: receiptId, eventType: "view_submission" });
  if (!isNew) return ack();

  // Same recovery as the arrival_pick branch above, carried instead
  // through the modal's private_metadata (issue #12) — see
  // ArrivalModalMetadata.priorChoice.
  const prior = decodePriorChoice(metadata.priorChoice);
  deps.waitUntil(
    finishReplyAfterInteraction(env, repoDeps, deps, {
      jobId: Number(metadata.jobId),
      arrivalSchedule,
      candidateSlugOverride: prior.candidateSlug,
      variantOverride: prior.variant,
      channelId: metadata.channelId,
      messageTs: metadata.messageTs,
    }).catch((error) => log("error", "interactions: arrival_other submission failed", { error: errorText(error) })),
  );

  return ack(); // empty 200 closes the modal
}
