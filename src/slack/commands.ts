/**
 * Parses an app_mention's text into a command, gates the admin-only
 * ones, and carries the two small protocols the interactive follow-up
 * flow needs: JST arrival-date computation (issue #14's "render time,
 * injected clock" requirement) and the compact button-value envelope
 * (epic issue #1 decision 8 — a button `value` is an id, never content).
 * Flags/subcommands per data/seed/source-skill.md's original
 * `/l-reply-purchase` workflow (`--discord`, `--direct`) plus the ref
 * management commands from epic issue #1.
 *
 * This module owns no I/O — src/jobs/worker.ts (the initial post) and
 * src/slack/interactions.ts (the click) both import from here so the
 * arrival/variant/candidate picker blocks and their action_ids stay in
 * exactly one place.
 */
import type { Env } from "../env";
import { parseCommaSeparated } from "../env";
import {
  buildArrivalDateBlocks,
  buildConfirmCancelBlocks,
  buildMessagePayload,
  buildMissingRefBlocks,
  escapeMrkdwn,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_CHARS_PER_PREFORMATTED_BLOCK,
  mrkdwnSection,
  type SlackMessagePayload,
} from "./blocks";
import type { ChangeSetDiffResult } from "../stash/api";

/* -------------------------------------------------------------------------
 * Command grammar.
 * ---------------------------------------------------------------------- */

export type ArrivalPresetKey = "tomorrow" | "day_after_tomorrow" | "day_after_day_after_tomorrow";

/**
 * The modifier half of a `reply` command — the parts that mean the same
 * thing whether or not the mention also named a product. Shared by the
 * `reply` and `reply_modifiers` variants so a consumer that only needs
 * the modifiers (src/jobs/worker.ts composeMatchPayload) can accept
 * either without re-listing the fields.
 */
export interface ReplyModifiers {
  discord: boolean;
  direct: boolean;
  arrival: ArrivalPresetKey | null;
}

/** The two stash-only administrative operations carried by a policy job. */
export type PolicyCommand =
  | { operation: "history" }
  | { operation: "rollback"; version: number };

export type ParsedCommand =
  | ({ kind: "reply"; query: string } & ReplyModifiers)
  /**
   * Valid reply modifiers with no product query — `@bot --discord`,
   * `@bot 明日 --direct` (epic #22 thread continuity, issue #27). This is
   * a deliberately narrow carve-out from `unknown`: the *only* way to
   * reach it is a mention whose every token is a known flag or a known
   * arrival preset. An unknown flag, an empty mention and two
   * contradictory arrival presets all still return `unknown`.
   *
   * The parser stays pure and says nothing about inheritance — it only
   * reports that the mention carried modifiers and no product. Deciding
   * whether a prior job in the thread supplies the missing product is
   * src/jobs/worker.ts's job, and when nothing does, that path replies
   * with exactly the {@link NO_PRODUCT_QUERY_REASON} + usage text this
   * input produced before the carve-out existed.
   */
  | ({ kind: "reply_modifiers" } & ReplyModifiers)
  | { kind: "ref_show"; slug: string }
  | { kind: "ref_history"; slug: string }
  | { kind: "ref_new"; query: string }
  | { kind: "ref_refresh"; slug: string }
  | { kind: "ref_restore"; slug: string; version: number }
  | { kind: "polish"; text: string }
  /**
   * Policy history/rollback deliberately retain the durable `policy_update`
   * job kind. `policyCommand` is an in-memory parser detail so the jobs table
   * and every unrelated dispatcher keep their existing shape.
   */
  | { kind: "policy_update"; request: string; policyCommand?: PolicyCommand }
  | { kind: "help" }
  /** Unparseable input or an unknown flag — `reason` is a ready-to-post Japanese explanation, never a stack trace (issue #14: "never a silent no-op and never a stack trace"). */
  | { kind: "unknown"; raw: string; reason: string };

/** `@bot help` and every parse failure point here — always shown alongside `reason` for an unknown command. */
export const USAGE_TEXT = [
  "*使い方*",
  "`@bot <製品名またはURL>` — 返信を作成します（到着予定日が未指定ならボタンで確認します）",
  "`@bot <製品名> 明日|明後日|明々後日` — 到着予定日を指定して返信します",
  "`@bot <製品名> --discord --direct` — Discord案内を追加 / 直接取引（評価依頼なし）にします（順不同、どちらか片方でも両方でも可）",
  "`@bot --discord` / `@bot 明日` — 同じスレッド内なら、直前に返信した製品のまま指定だけを付け直します（フラグは毎回指定し直しです）",
  "`@bot polish` の次の行に整えたい文章を貼り付けます",
  "`@bot policy <変更内容>` — 返信ポリシーの更新PRを作成します（管理者のみ）",
  "`@bot policy history` — 返信ポリシーの履歴を表示します（管理者のみ）",
  "`@bot policy rollback <バージョン番号>` — 指定したポリシーのバージョンへ戻します（管理者のみ）",
  "`@bot ref show|history|restore|new|refresh <slugまたは製品名> [引数]` — 製品リファレンスの管理コマンド",
  "`@bot help` — この使い方を表示します",
].join("\n");

const GENERIC_MENTION_PREFIX = /^<@[^>]*>\s*/;

/** Escapes `botUserId` for use inside a RegExp — Slack user ids are `[A-Z0-9]+` in practice, but this is defensive rather than assuming that. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strips the leading `<@BOT_ID>` mention. Matches specifically against
 * `botUserId` first (the Events API only ever delivers app_mention text
 * mentioning this bot, so that should always hit); falls back to
 * stripping any leading mention token — the same generic pattern
 * src/refs/resolve.ts and src/jobs/worker.ts already use — so a mismatch
 * still degrades gracefully instead of leaving a raw `<@...>` token
 * glued onto the query.
 */
function stripBotMention(rawText: string, botUserId: string): string {
  const specific = new RegExp(`^<@${escapeForRegExp(botUserId)}(?:\\|[^>]*)?>\\s*`, "i");
  return specific.test(rawText) ? rawText.replace(specific, "") : rawText.replace(GENERIC_MENTION_PREFIX, "");
}

const KNOWN_FLAGS = new Set(["--discord", "--direct"]);
const ARRIVAL_PRESET_BY_TOKEN: Record<string, ArrivalPresetKey> = {
  明日: "tomorrow",
  明後日: "day_after_tomorrow",
  明々後日: "day_after_day_after_tomorrow",
};
const REF_SUBCOMMANDS = new Set(["show", "history", "restore", "new", "refresh"]);

/**
 * The Japanese explanation a mention naming no product gets. Exported
 * because src/jobs/worker.ts replies with exactly this string when a
 * `reply_modifiers` mention finds no thread context to inherit — the
 * degradation contract for issue #27 is that such a mention gets the
 * *same* message it got before inheritance existed, not a new one.
 */
export const NO_PRODUCT_QUERY_REASON = "製品名またはURLを指定してください。";

function unknownCommand(raw: string, reason: string): ParsedCommand {
  return { kind: "unknown", raw, reason };
}

/**
 * Parses the text after stripping the leading `<@BOT_ID>` mention. Pure —
 * same input always produces the same ParsedCommand — so the table-driven
 * grammar tests can assert on it directly with no I/O or clock involved.
 */
export function parseCommand(rawText: string, botUserId: string): ParsedCommand {
  const untrimmedBody = stripBotMention(rawText, botUserId);
  const body = untrimmedBody.trim();
  if (body === "") return unknownCommand(rawText, "コマンドが空です。製品名またはコマンドを入力してください。");

  const newlineIndex = body.indexOf("\n");
  const firstLine = (newlineIndex === -1 ? body : body.slice(0, newlineIndex)).trim();
  const afterFirstLine = newlineIndex === -1 ? "" : body.slice(newlineIndex + 1);
  const headTokens = firstLine.split(/\s+/).filter((token) => token.length > 0);
  const head = headTokens[0]?.toLowerCase() ?? "";

  if (head === "help") return { kind: "help" };

  // These are intentionally recognized before the prose-shaped policy
  // update grammar. They keep the durable job kind as `policy_update` while
  // preventing a mistyped rollback from becoming a GitHub edit request.
  if (/^policy[ \t]+history(?:[ \t\r\n]|$)/i.test(body)) {
    if (/^policy history$/i.test(body)) {
      return { kind: "policy_update", request: "history", policyCommand: { operation: "history" } };
    }
    return unknownCommand(rawText, "policy history は引数なしで指定してください。");
  }
  if (/^policy[ \t]+rollback(?:[ \t\r\n]|$)/i.test(body)) {
    const match = /^policy rollback ([0-9]+)$/i.exec(body);
    if (match === null) {
      return unknownCommand(rawText, "policy rollback <バージョン番号> の形式で指定してください。");
    }
    const versionToken = match[1]!;
    if (!/^[1-9]\d*$/.test(versionToken)) {
      return unknownCommand(rawText, "policy rollback のバージョン番号は正の整数で指定してください。");
    }
    const version = Number(versionToken);
    if (!Number.isSafeInteger(version) || version < 1) {
      return unknownCommand(rawText, "policy rollback のバージョン番号が大きすぎます。");
    }
    return { kind: "policy_update", request: `rollback ${version}`, policyCommand: { operation: "rollback", version } };
  }

  // Unlike the tokenized reply/ref grammars, a policy request is prose:
  // preserve every byte after the required command separator so the
  // operator's requested wording reaches the policy editor unchanged.
  if (/^policy /i.test(untrimmedBody)) {
    const request = untrimmedBody.slice("policy ".length);
    if (request.trim() === "") return unknownCommand(rawText, "policy の後に変更内容を入力してください。");
    return { kind: "policy_update", request };
  }
  if (/^policy$/i.test(body)) {
    return unknownCommand(rawText, "policy の後に変更内容を入力してください。");
  }

  if (head === "polish") {
    const text = afterFirstLine.trim();
    if (text === "") return unknownCommand(rawText, "polish の後に改行して、整えたい文章を貼り付けてください。");
    return { kind: "polish", text };
  }

  if (head === "ref") {
    const sub = headTokens[1]?.toLowerCase();
    if (sub === undefined || !REF_SUBCOMMANDS.has(sub)) {
      return unknownCommand(rawText, "ref の後には show|history|restore|new|refresh のいずれかを指定してください。");
    }
    const args = headTokens.slice(2);

    if (sub === "restore") {
      if (args.length < 2) return unknownCommand(rawText, "ref restore <slugまたは製品名> <バージョン番号> の形式で指定してください。");
      const versionToken = args[args.length - 1]!;
      const version = Number(versionToken);
      if (!Number.isInteger(version) || version < 1) {
        return unknownCommand(rawText, `ref restore のバージョン指定が不正です: ${versionToken}`);
      }
      const slug = args.slice(0, -1).join(" ").trim();
      if (slug === "") return unknownCommand(rawText, "ref restore には対象のslugまたは製品名が必要です。");
      return { kind: "ref_restore", slug, version };
    }

    const value = args.join(" ").trim();
    if (value === "") return unknownCommand(rawText, `ref ${sub} には対象のslugまたは製品名が必要です。`);
    if (sub === "show") return { kind: "ref_show", slug: value };
    if (sub === "history") return { kind: "ref_history", slug: value };
    if (sub === "new") return { kind: "ref_new", query: value };
    return { kind: "ref_refresh", slug: value };
  }

  // Everything else is a `reply` command: product query + an optional
  // arrival preset + `--discord`/`--direct`, order-independent and
  // scanned across the whole body (not just the first line) so an
  // accidental line break in a pasted query doesn't split a flag off.
  const allTokens = body.split(/\s+/).filter((token) => token.length > 0);
  let discord = false;
  let direct = false;
  let arrival: ArrivalPresetKey | null = null;
  const queryWords: string[] = [];

  for (const token of allTokens) {
    if (token.startsWith("--")) {
      const flag = token.toLowerCase();
      if (!KNOWN_FLAGS.has(flag)) return unknownCommand(rawText, `不明なフラグです: ${token}`);
      if (flag === "--discord") discord = true;
      else direct = true;
      continue;
    }
    const preset = ARRIVAL_PRESET_BY_TOKEN[token];
    if (preset !== undefined) {
      if (arrival !== null && arrival !== preset) {
        return unknownCommand(rawText, "到着予定日の指定が複数あります。一つにしてください。");
      }
      arrival = preset;
      continue;
    }
    queryWords.push(token);
  }

  const query = queryWords.join(" ").trim();
  if (query === "") {
    // Modifiers with no product name — a `reply_modifiers` command, so a
    // follow-up in a thread can be given its predecessor's product (see
    // that variant's doc comment). The `unknown` fallback below is not
    // reachable from a non-empty body (every token is either a modifier
    // or a query word, and an empty body returned above), and is kept
    // only so "no product AND no modifier" can never be mistaken for a
    // valid command if that ever changes.
    if (discord || direct || arrival !== null) return { kind: "reply_modifiers", discord, direct, arrival };
    return unknownCommand(rawText, NO_PRODUCT_QUERY_REASON);
  }

  return { kind: "reply", query, discord, direct, arrival };
}

/**
 * Gate for `ref new/refresh/restore` and approval-button clicks —
 * SLACK_ADMIN_USER_IDS only, per CLAUDE.md "writes are gated" and epic
 * issue #1 decision 8.
 */
export function isAdminUser(env: Env, userId: string): boolean {
  return parseCommaSeparated(env.SLACK_ADMIN_USER_IDS).includes(userId);
}

/* -------------------------------------------------------------------------
 * Arrival dates -- JST (UTC+9), computed from an injected clock.
 * ---------------------------------------------------------------------- */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Index = the JST-shifted timestamp's `getUTCDay()` (0 = Sunday), matching data/seed/source-skill.md's `days_jp` table. */
const WEEKDAY_KANJI: readonly string[] = ["日", "月", "火", "水", "木", "金", "土"];

const ARRIVAL_PRESET_KANJI: Record<ArrivalPresetKey, string> = {
  tomorrow: "明日",
  day_after_tomorrow: "明後日",
  day_after_day_after_tomorrow: "明々後日",
};

/** Display order for the three quick-pick buttons — also the iteration order computeArrivalPresetOptions returns. */
export const ARRIVAL_PRESET_ORDER: readonly ArrivalPresetKey[] = [
  "tomorrow",
  "day_after_tomorrow",
  "day_after_day_after_tomorrow",
];

const ARRIVAL_PRESET_OFFSET_DAYS: Record<ArrivalPresetKey, number> = {
  tomorrow: 1,
  day_after_tomorrow: 2,
  day_after_day_after_tomorrow: 3,
};

export interface ArrivalPresetOption {
  preset: ArrivalPresetKey;
  /** e.g. "明後日月曜" — matches src/reply/templates.ts ArrivalScheduleParts.dayLabel. */
  dayLabel: string;
  month: number;
  day: number;
  /** e.g. "明後日月曜 8/18" — the Slack button label (data/seed/source-skill.md "Ask Shipping Details": day+weekday, space, M/D). */
  buttonLabel: string;
}

/**
 * The three preset arrival-date options (明日/明後日/明々後日), computed in
 * JST at call time from the injected clock — never `new Date()` directly,
 * so a test can freeze the clock across a UTC-midnight or month boundary
 * and still get deterministic labels.
 */
export function computeArrivalPresetOptions(now: () => Date): ArrivalPresetOption[] {
  const nowMs = now().getTime();
  return ARRIVAL_PRESET_ORDER.map((preset) => {
    const shifted = new Date(nowMs + JST_OFFSET_MS + ARRIVAL_PRESET_OFFSET_DAYS[preset] * DAY_MS);
    const month = shifted.getUTCMonth() + 1;
    const day = shifted.getUTCDate();
    const dayLabel = `${ARRIVAL_PRESET_KANJI[preset]}${WEEKDAY_KANJI[shifted.getUTCDay()]!}曜`;
    return { preset, dayLabel, month, day, buttonLabel: `${dayLabel} ${month}/${day}` };
  });
}

const ARRIVAL_ARG_SEPARATOR = "|";

/**
 * Packs a resolved (not a preset key) arrival option into a button-value
 * arg: `dayLabel|month|day`. Carrying the *resolved* date, not just the
 * preset key, is deliberate — the button label already committed to a
 * concrete M/D at render time (issue #14: "computed ... at render time"),
 * and a click could land minutes or hours later (immediate delivery is
 * an optimization, the cron sweep is the contract); recomputing "明日"
 * from `now()` again at click time could silently disagree with what the
 * button visibly said if a day boundary was crossed in between.
 */
export function encodeArrivalOptionArg(option: Pick<ArrivalPresetOption, "dayLabel" | "month" | "day">): string {
  return [option.dayLabel, String(option.month), String(option.day)].join(ARRIVAL_ARG_SEPARATOR);
}

/** The inverse of encodeArrivalOptionArg — returns null on any malformed input rather than throwing (a stale/tampered button click must never crash the interactions route). */
export function decodeArrivalOptionArg(
  arg: string,
): { dayLabel: string; month: number; day: number } | null {
  const parts = arg.split(ARRIVAL_ARG_SEPARATOR);
  if (parts.length !== 3) return null;
  const [dayLabel, monthText, dayText] = parts;
  const month = Number(monthText);
  const day = Number(dayText);
  if (!dayLabel || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return { dayLabel, month, day };
}

/* -------------------------------------------------------------------------
 * Button value envelope -- epic issue #1 decision 8: "a button `value`
 * is a compact JSON envelope with an id, never content."
 * ---------------------------------------------------------------------- */

/**
 * Slack rejects a button `value` over 2000 chars (invalid_blocks). Every
 * button this repo renders — the pickers below and, since issue #25, the
 * missing-ref "create a reference" button — goes through encodeButtonValue,
 * so this is the single place the ceiling is enforced.
 */
export const MAX_BUTTON_VALUE_CHARS = 2_000;

export interface ButtonValueEnvelope {
  v: 1;
  /**
   * Opaque id the click needs to recover its context — a `jobs.id`
   * (stringified) for arrival_pick/arrival_other/variant_pick/
   * candidate_pick and (since issue #25) create_reference, or a
   * `ref_drafts.id` (uuid) for ref_approve/ref_reject. Never the
   * reference body or reply text itself.
   *
   * src/slack/interactions.ts also keys its interaction receipt on this,
   * so it must identify what the click acts *on*: two create_reference
   * buttons offered by two different reply jobs are two different targets
   * even if Slack hands them the same `action_ts`.
   */
  id: string;
  /** Action-specific argument, e.g. an encoded arrival option, a chosen candidate slug, "built"/"kit", or create_reference's search query. */
  a?: string;
  /**
   * A disambiguation choice carried forward into a chained arrival-date
   * picker (see encodePriorChoice) — issue #12: a `variant_pick` or
   * `candidate_pick` click for a product that *also* needs an arrival
   * date chains into buildArrivalPickerPayload using the same `jobId`.
   * Without this, the arrival_pick click that follows re-derives the
   * product from the job's original (still-ambiguous) raw text via
   * resolveProductRef and silently loses the earlier choice — for
   * variant_pick specifically, that means composing as "built" even when
   * the customer just clicked "kit". `job.raw_text` never changes across
   * this chain, so the choice has nowhere else to live.
   */
  p?: string;
}

/** Throws rather than silently truncating — an oversized envelope is a bug in the caller, not something to ship a corrupted button over. */
export function encodeButtonValue(envelope: ButtonValueEnvelope): string {
  const raw = JSON.stringify(envelope);
  if (raw.length > MAX_BUTTON_VALUE_CHARS) {
    throw new Error(
      `button value envelope exceeds Slack's ${MAX_BUTTON_VALUE_CHARS}-char cap (${raw.length} chars, id=${envelope.id})`,
    );
  }
  return raw;
}

/** The inverse of encodeButtonValue. Returns null (never throws) for anything that isn't our envelope shape — including plain-string button values like src/slack/blocks.ts's CREATE_REFERENCE_ACTION_ID, and any tampered/stale click. */
export function decodeButtonValue(raw: string): ButtonValueEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1 || typeof record.id !== "string" || record.id === "") return null;
  if (record.a !== undefined && typeof record.a !== "string") return null;
  if (record.p !== undefined && typeof record.p !== "string") return null;
  return {
    v: 1,
    id: record.id,
    ...(record.a === undefined ? {} : { a: record.a as string }),
    ...(record.p === undefined ? {} : { p: record.p as string }),
  };
}

/**
 * Encodes a variant_pick/candidate_pick choice for ButtonValueEnvelope's
 * `p` field — see that field's doc comment for why this needs to exist at
 * all. A tagged string rather than a second pair of fields: a job is
 * ambiguous in exactly one way at a time (resolveProductRef's result is a
 * single discriminated kind), so there is never a "both" case to encode.
 */
export function encodePriorChoice(
  choice: { kind: "variant"; variant: "built" | "kit" } | { kind: "candidate"; slug: string },
): string {
  return choice.kind === "variant" ? `variant:${choice.variant}` : `candidate:${choice.slug}`;
}

/** The inverse of encodePriorChoice. Returns `{}` (never throws) for `undefined` or anything malformed — a stale/tampered button click must never crash the interactions route. */
export function decodePriorChoice(raw: string | undefined): { variant?: "built" | "kit"; candidateSlug?: string } {
  if (raw === undefined) return {};
  if (raw.startsWith("variant:")) {
    const variant = raw.slice("variant:".length);
    return variant === "built" || variant === "kit" ? { variant } : {};
  }
  if (raw.startsWith("candidate:")) {
    const slug = raw.slice("candidate:".length);
    return slug === "" ? {} : { candidateSlug: slug };
  }
  return {};
}

/* -------------------------------------------------------------------------
 * Interactive picker blocks -- shared between the initial post
 * (src/jobs/worker.ts) and a chained re-post after a variant/candidate
 * click resolves which product was actually meant
 * (src/slack/interactions.ts).
 * ---------------------------------------------------------------------- */

/** Stable action_id bases (issue #14: "action_ids are stable across redeploys"). Multi-option rows suffix `_${index}` (see src/slack/blocks.ts buildArrivalDateBlocks) — click routing matches on the prefix, never the exact suffixed id, so which button is which is JSON-envelope; encoded (`a`), not action_id-encoded. */
export const ACTION_IDS = {
  arrivalPick: "arrival_pick",
  arrivalOther: "arrival_other",
  refApprove: "ref_approve",
  refReject: "ref_reject",
  variantPick: "variant_pick",
  candidatePick: "candidate_pick",
  policyApprove: "policy_approve",
  policyReject: "policy_reject",
} as const;

/**
 * Builds the arrival-date quick-pick message for a `reply` job whose
 * product needs an arrival date but none was given in the mention text.
 * `small`-category products never reach this — the caller skips the
 * question entirely for those (issue #14).
 *
 * `priorChoice` (see ButtonValueEnvelope.p / encodePriorChoice) is set
 * only when this picker is posted *after* a variant_pick/candidate_pick
 * click already resolved which product/variant is meant — src/slack/
 * interactions.ts's finishReplyAfterInteraction chains into this same
 * function for that case. It must be carried on every button here so the
 * arrival_pick click that follows doesn't lose it.
 */
export function buildArrivalPickerPayload(jobId: number, now: () => Date, priorChoice?: string): SlackMessagePayload {
  const options = computeArrivalPresetOptions(now);
  const priorArg = priorChoice === undefined ? {} : { p: priorChoice };
  const promptBlock = {
    type: "section",
    block_id: "arrival_prompt",
    text: { type: "mrkdwn", text: "到着予定日を選択してください。" },
  };
  const presetBlocks = buildArrivalDateBlocks({
    blockId: "arrival_pick_block",
    actionId: ACTION_IDS.arrivalPick,
    options: options.map((option) => ({
      label: option.buttonLabel,
      value: encodeButtonValue({ v: 1, id: String(jobId), a: encodeArrivalOptionArg(option), ...priorArg }),
    })),
  });
  const otherBlock = {
    type: "actions",
    block_id: "arrival_other_block",
    elements: [
      {
        type: "button",
        action_id: ACTION_IDS.arrivalOther,
        text: { type: "plain_text", text: "その他", emoji: true },
        value: encodeButtonValue({ v: 1, id: String(jobId), ...priorArg }),
      },
    ],
  };
  return buildMessagePayload([promptBlock, ...presetBlocks, otherBlock], "到着予定日を選択してください。");
}

/** Built vs kit disambiguation for a `general-diy` product the resolver couldn't decide on its own (src/refs/resolve.ts "variant-ambiguous"). */
export function buildVariantPickerPayload(jobId: number, displayName: string): SlackMessagePayload {
  const promptBlock = {
    type: "section",
    block_id: "variant_prompt",
    text: {
      type: "mrkdwn",
      text: `「${escapeMrkdwn(displayName)}」は完成品とDIYキットの両方があります。どちらが購入されましたか？`,
    },
  };
  const pickerBlocks = buildArrivalDateBlocks({
    blockId: "variant_pick_block",
    actionId: ACTION_IDS.variantPick,
    options: [
      { label: "完成品", value: encodeButtonValue({ v: 1, id: String(jobId), a: "built" }) },
      { label: "DIYキット", value: encodeButtonValue({ v: 1, id: String(jobId), a: "kit" }) },
    ],
  });
  return buildMessagePayload([promptBlock, ...pickerBlocks], `${displayName} の購入形態を確認してください。`);
}

/** Candidate disambiguation for a query the resolver matched to more than one product (src/refs/resolve.ts "ambiguous"). */
export function buildCandidatePickerPayload(jobId: number, candidateSlugs: readonly string[]): SlackMessagePayload {
  const promptBlock = {
    type: "section",
    block_id: "candidate_prompt",
    text: { type: "mrkdwn", text: "複数の製品候補が見つかりました。該当するものを選択してください。" },
  };
  const pickerBlocks = buildArrivalDateBlocks({
    blockId: "candidate_pick_block",
    actionId: ACTION_IDS.candidatePick,
    options: candidateSlugs.map((slug) => ({
      label: slug,
      value: encodeButtonValue({ v: 1, id: String(jobId), a: slug }),
    })),
  });
  return buildMessagePayload([promptBlock, ...pickerBlocks], "複数の製品候補があります。該当するものを選択してください。");
}

/** One literal diff block. Unlike an mrkdwn section, this preserves every
 * character that an operator may copy from the review. */
function policyDiffBlock(content: string): unknown {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_preformatted",
        elements: [{ type: "text", text: content }],
      },
    ],
  };
}

/** Splits at code-point boundaries so an oversized stash diff cannot make
 * the whole Slack message invalid. The marker is the only intentional loss
 * and is added only when the bounded review surface is exhausted. */
function boundedPolicyDiffBlocks(text: string, maxBlocks: number): unknown[] {
  const capacity = maxBlocks * MAX_CHARS_PER_PREFORMATTED_BLOCK;
  let bounded = text;
  if (bounded.length > capacity) {
    const budget = capacity - 1;
    let kept = "";
    for (const character of bounded) {
      if (kept.length + character.length > budget) break;
      kept += character;
    }
    bounded = `${kept}…`;
  }

  const chunks: string[] = [];
  let current = "";
  for (const character of bounded) {
    if (current.length + character.length > MAX_CHARS_PER_PREFORMATTED_BLOCK) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current !== "" || chunks.length === 0) chunks.push(current);
  return chunks.map(policyDiffBlock);
}

function policyDiffText(diff: ChangeSetDiffResult): string {
  const entry = diff.entries[0];
  if (entry?.diff.state === "ready") return entry.diff.unified;
  // A text put produced by this route always has one ready entry. Keep a
  // deterministic bounded fallback for a malformed/closed remote response.
  return "差分を表示できませんでした。";
}

/**
 * Renders a stash change-set's candidate-vs-head diff as an inline review.
 * The button value is deliberately just the change-set id envelope; all
 * other decision context is recovered by the later interaction route.
 */
export function buildPolicyReviewPayload(input: {
  changeSetId: string;
  diff: ChangeSetDiffResult;
}): SlackMessagePayload {
  const value = encodeButtonValue({ v: 1, id: input.changeSetId });
  const chromeBlocks = 2; // prompt + approve/reject actions
  const diffBlocks = boundedPolicyDiffBlocks(
    policyDiffText(input.diff),
    MAX_BLOCKS_PER_MESSAGE - chromeBlocks,
  );
  return buildMessagePayload(
    [
      mrkdwnSection("policy_review_prompt", "ポリシー変更案を確認してください。以下は現在の内容との差分です。"),
      ...diffBlocks,
      ...buildConfirmCancelBlocks({
        blockId: "policy_review_actions",
        confirmActionId: ACTION_IDS.policyApprove,
        cancelActionId: ACTION_IDS.policyReject,
        value,
        confirmLabel: "承認",
        cancelLabel: "却下",
      }),
    ],
    "ポリシー変更案を確認してください。",
  );
}

export interface MissingRefPayloadInput {
  /** The search text the resolver failed on — shown in the message and carried back on the click as the authoring query. */
  query: string;
  /** The `reply` job whose resolution missed. Recorded as `ref_drafts.origin_job_id` when the button is clicked (epic #22). */
  originJobId: number;
}

/**
 * Fits `query` into a create_reference envelope that respects Slack's
 * 2000-char `value` cap.
 *
 * The id is the load-bearing half — it is what the resulting draft records
 * as `origin_job_id` and what src/slack/interactions.ts keys its receipt
 * on — so the **query** is what gets truncated when the two cannot both
 * fit, never the other way round (issue #25). The loop measures the
 * *encoded* length rather than subtracting a fixed overhead because JSON
 * escaping can cost more than one character per source character (a quote
 * becomes two, a lone surrogate six).
 */
function fitMissingRefEnvelope(input: MissingRefPayloadInput): ButtonValueEnvelope {
  const id = String(input.originJobId);
  let query = input.query;
  for (;;) {
    const envelope: ButtonValueEnvelope = { v: 1, id, a: query };
    const overflow = JSON.stringify(envelope).length - MAX_BUTTON_VALUE_CHARS;
    if (overflow <= 0 || query === "") return envelope;
    query = query.slice(0, Math.max(0, query.length - overflow));
  }
}

/**
 * Builds the "no reference found" message for a `reply` job whose
 * resolution missed (epic issue #1 decision 7: a miss does not dead-end).
 *
 * Lives here rather than in src/slack/blocks.ts for the same reason the
 * pickers above do: the button carries a `ButtonValueEnvelope`, and this
 * module owns that protocol.
 */
export function buildMissingRefPayload(input: MissingRefPayloadInput): SlackMessagePayload {
  const value = encodeButtonValue(fitMissingRefEnvelope(input));
  return buildMessagePayload(buildMissingRefBlocks(input.query, value), "製品リファレンスが見つかりませんでした。");
}
