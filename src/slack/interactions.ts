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
  isAdminUser,
  parseCommand,
  buildArrivalPickerPayload,
} from "./commands";
import {
  CREATE_REFERENCE_ACTION_ID,
  buildMessagePayload,
  buildReplyMessagePayload,
  type SlackMessagePayload,
} from "./blocks";
import {
  consumeRefDraft,
  getJobById,
  getProductRefBySlug,
  recordInteractionReceipt,
  upsertProductRef,
  type RepoDeps,
} from "../db/repos";
import type { ProductRefRow } from "../db/schema";
import { resolveProductRef } from "../refs/resolve";
import { parseProductRefMarkdown } from "../refs/parse";
import { openView, postEphemeral, postToResponseUrl, updateMessage, type SlackApiDeps } from "./api";
import { composeReply as defaultComposeReply, type ComposeReplyDeps, type ComposeReplyInput, type ComposeReplyResult } from "../reply/compose";
import { formatArrivalSchedule } from "../reply/templates";
import { log } from "../ops/log";

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
  // decodes as our envelope; otherwise (e.g. CREATE_REFERENCE_ACTION_ID's
  // plain-string query value) the raw value stands in for it.
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
      handleRefDraftDecision(repoDeps, slackApiDeps, { draftId, approve, actorUserId: click.userId, channelId: click.channelId, messageTs: click.messageTs }).catch(
        (error) => log("error", "interactions: ref draft decision failed", { error: errorText(error) }),
      ),
    );
    return ack();
  }

  if (click.actionId === CREATE_REFERENCE_ACTION_ID) {
    // The actual authoring pipeline (LLM-drafted new reference content,
    // src/env.ts AUTHOR_PROVIDER) is issue #16's responsibility and
    // doesn't exist yet — acknowledge honestly rather than pretending
    // this button already does something it can't.
    deps.waitUntil(
      postEphemeral(slackApiDeps, {
        channel: click.channelId,
        user: click.userId,
        payload: buildTextPayload("リファレンスの新規作成はまだ実装されていません（issue #16 待ち）。"),
      }).catch((error) => log("error", "interactions: create_reference ack failed", { error: errorText(error) })),
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
      }).catch((error) => log("error", "interactions: openArrivalModal failed", { error: errorText(error) })),
    );
    return ack();
  }

  if (click.actionId.startsWith(ACTION_IDS.arrivalPick)) {
    const envelope = decodeButtonValue(click.value);
    const parts = envelope?.a ? decodeArrivalOptionArg(envelope.a) : null;
    if (!envelope || !parts) return ack();
    deps.waitUntil(
      finishReplyAfterInteraction(env, repoDeps, deps, {
        jobId: Number(envelope.id),
        arrivalSchedule: formatArrivalSchedule(parts),
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

async function handleRefDraftDecision(
  repoDeps: RepoDeps,
  slackApiDeps: SlackApiDeps,
  ctx: { draftId: string; approve: boolean; actorUserId: string; channelId: string; messageTs: string },
): Promise<void> {
  if (!ctx.draftId) return;
  const draft = await consumeRefDraft(repoDeps, ctx.draftId);
  if (!draft) {
    await tryUpdate(slackApiDeps, ctx, buildTextPayload("この変更は既に処理済みか、期限切れです。"));
    return;
  }

  if (!ctx.approve) {
    await tryUpdate(slackApiDeps, ctx, buildTextPayload(`「${draft.slug}」の変更をキャンセルしました。`));
    return;
  }

  await upsertProductRef(repoDeps, {
    slug: draft.slug,
    category: draft.category,
    productUrl: draft.product_url,
    bodyMd: draft.body_md,
    changedByUserId: ctx.actorUserId,
    source: draft.base_version === null ? "authored" : "refreshed",
  });
  await tryUpdate(slackApiDeps, ctx, buildTextPayload(`「${draft.slug}」を承認し反映しました。`));
}

async function tryUpdate(
  slackApiDeps: SlackApiDeps,
  ctx: { channelId: string; messageTs: string },
  payload: SlackMessagePayload,
): Promise<void> {
  if (!ctx.channelId || !ctx.messageTs) return;
  await updateMessage(slackApiDeps, { channel: ctx.channelId, ts: ctx.messageTs, payload });
}

/* -------------------------------------------------------------------------
 * arrival_pick / variant_pick / candidate_pick — finish composing.
 * ---------------------------------------------------------------------- */

interface FinishReplyContext {
  jobId: number;
  /** Already-resolved (from an arrival_pick click or the arrival_other modal), or null to fall back to the original mention's typed preset, or to ask again. */
  arrivalSchedule: string | null;
  variantOverride?: "built" | "kit";
  candidateSlugOverride?: string;
  channelId: string;
  messageTs: string;
  responseUrl?: string;
}

async function finishReplyAfterInteraction(
  env: Env,
  repoDeps: RepoDeps,
  deps: SlackInteractionsDeps,
  ctx: FinishReplyContext,
): Promise<void> {
  const job = await getJobById(repoDeps, ctx.jobId);
  if (!job) {
    log("warn", "interactions: job not found for click", { jobId: ctx.jobId });
    return;
  }

  const parsed = parseCommand(job.raw_text, env.SLACK_BOT_USER_ID);
  if (parsed.kind !== "reply") {
    log("error", "interactions: parseCommand drift for job on click", { jobId: ctx.jobId, parsedKind: parsed.kind });
    return;
  }

  let refRow: ProductRefRow | null = null;
  let purchased: "built" | "kit" = "built";
  if (ctx.candidateSlugOverride) {
    refRow = await getProductRefBySlug(repoDeps, ctx.candidateSlugOverride);
    // The chosen candidate could itself be a general-diy product with an
    // as-yet-undetermined variant, but there is no second round of
    // disambiguation here — defaults to "built", same as
    // src/jobs/worker.ts composeMatchPayload's `resolved.variant ?? "built"`.
  } else {
    const resolved = await resolveProductRef(repoDeps, job.raw_text);
    if (resolved.kind === "match") {
      refRow = resolved.ref;
      purchased = resolved.variant ?? "built";
    } else if (resolved.kind === "variant-ambiguous") {
      refRow = resolved.ref;
    }
  }
  if (ctx.variantOverride) purchased = ctx.variantOverride;
  if (!refRow) {
    log("warn", "interactions: could not re-resolve product for click", { jobId: ctx.jobId });
    return;
  }

  const ref = parseProductRefMarkdown({ slug: refRow.slug, markdown: refRow.body_md });

  let arrivalSchedule = ctx.arrivalSchedule;
  if (arrivalSchedule === null && parsed.arrival !== null) {
    // The original mention already specified an arrival preset (e.g.
    // "明後日") — a variant/candidate pick shouldn't re-ask for it.
    const option = computeArrivalPresetOptions(deps.now).find((candidate) => candidate.preset === parsed.arrival);
    if (option) {
      arrivalSchedule = formatArrivalSchedule({ dayLabel: option.dayLabel, month: option.month, day: option.day });
    }
  }

  const slackApiDeps: SlackApiDeps = { botToken: env.SLACK_BOT_TOKEN, fetch: deps.fetch, sleep: deps.sleep };

  if (ref.category !== "small" && arrivalSchedule === null) {
    // Resolved which product/variant, but still need an arrival date --
    // chain into the same picker the initial reply-job post would have
    // shown (src/jobs/worker.ts composeMatchPayload's mirror image).
    await updateOriginalMessage(deps, slackApiDeps, ctx, buildArrivalPickerPayload(job.id, deps.now));
    return;
  }

  const compose = deps.composeReply ?? defaultComposeReply;
  const composed = await compose(
    // `now` forwarded so composeReply's UTC-day budget window agrees
    // with the rest of this job's clock — src/reply/compose.ts
    // ComposeReplyDeps.now.
    { env, fetch: deps.fetch, now: deps.now },
    { ref, arrivalSchedule, discord: parsed.discord, direct: parsed.direct, purchased, variantText: job.raw_text },
  );
  const finalPayload = buildReplyMessagePayload({ replyText: composed.text, summaryText: `${ref.displayName} の返信` });
  await updateOriginalMessage(deps, slackApiDeps, ctx, finalPayload);
}

/* -------------------------------------------------------------------------
 * arrival_other -- modal.
 * ---------------------------------------------------------------------- */

const ARRIVAL_MODAL_CALLBACK_ID = "arrival_other_modal";

interface ArrivalModalMetadata {
  jobId: string;
  channelId: string;
  messageTs: string;
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
  return { jobId, channelId, messageTs };
}

async function openArrivalModal(
  slackApiDeps: SlackApiDeps,
  ctx: { triggerId: string; jobId: string; channelId: string; messageTs: string },
): Promise<void> {
  await openView(slackApiDeps, {
    triggerId: ctx.triggerId,
    view: {
      type: "modal",
      callback_id: ARRIVAL_MODAL_CALLBACK_ID,
      private_metadata: encodeModalMetadata({ jobId: ctx.jobId, channelId: ctx.channelId, messageTs: ctx.messageTs }),
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

  deps.waitUntil(
    finishReplyAfterInteraction(env, repoDeps, deps, {
      jobId: Number(metadata.jobId),
      arrivalSchedule,
      channelId: metadata.channelId,
      messageTs: metadata.messageTs,
    }).catch((error) => log("error", "interactions: arrival_other submission failed", { error: errorText(error) })),
  );

  return ack(); // empty 200 closes the modal
}
