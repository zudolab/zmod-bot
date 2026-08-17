/**
 * The `@bot ref …` command handlers — read (`show`, `history`), roll back
 * (`restore`), and the approve/reject half of the draft flow that every
 * reference write goes through.
 *
 * **This module is the undo mechanism.** Choosing D1 over git means an
 * edit here has no `git revert`: `product_ref_versions` plus `ref
 * restore` *is* the rollback, so history is append-only (a restore
 * writes a NEW version, it never rewrites or deletes one) and a commit
 * is refused rather than guessed at whenever anything about it has
 * shifted since the operator saw the preview.
 *
 * **The approval contract** (issue #15), implemented by approveRefDraft
 * below and committed by src/db/repos.ts commitRefDraft in one
 * `db.batch()`:
 *
 * 1. The draft must exist, be unconsumed and unexpired.
 * 2. `base_version` must still equal the reference's current `version`.
 *    A preview generated against v3 and approved after someone else
 *    landed v4 is refused with both numbers named — never applied on
 *    top, which would silently erase that concurrent edit.
 * 3. The body is re-parsed with src/refs/parse.ts **before** anything is
 *    written. A draft the renderer could not render must never land.
 * 4. Aliases are derived from the freshly parsed body and *replace* the
 *    slug's rows wholesale, so an alias dropped from the body stops
 *    resolving.
 *
 * Every one of those refusals writes nothing at all — not even the
 * draft's `consumed_at` — so the operator can fix the cause and approve
 * the same preview, or re-run the command, without a lost draft.
 */
import type { Env } from "../env";
import {
  commitRefDraft,
  createRefDraft,
  consumeRefDraft,
  findAliasOwners,
  getProductRefBySlug,
  getProductRefVersion,
  getRefDraft,
  listProductRefVersions,
  type RepoDeps,
} from "../db/repos";
import type { JobRow, ProductCategory, ProductRefRow, ProductRefVersionRow, RefDraftRow } from "../db/schema";
import { authorProductRef, type AuthorRefInput, type AuthorRefOutcome } from "./authoring";
import { RefParseError, type ProductRef, type RefCategory } from "./model";
import { parseProductRefMarkdown } from "./parse";
import { normalizeAlias, resolveProductRef } from "./resolve";
import {
  MAX_BLOCKS_PER_MESSAGE,
  buildConfirmCancelBlocks,
  buildMessagePayload,
  buildReplyBlocks,
  escapeMrkdwn,
  type SlackMessagePayload,
} from "../slack/blocks";
import { ACTION_IDS, encodeButtonValue, isAdminUser, parseCommand, USAGE_TEXT } from "../slack/commands";
import type { FetchLike } from "../types";

/**
 * How long a preview stays approvable (issue #15). Long enough for a
 * human to read a reference document, short enough that a forgotten tab
 * cannot commit an edit authored against a long-gone version — and the
 * expected-version check below is what covers the window anyway.
 */
export const REF_DRAFT_TTL_MS = 30 * 60 * 1000;

/** `ref history` caps its listing here; the rest is reported as a count (issue #15). */
export const REF_HISTORY_LIMIT = 20;

/* -------------------------------------------------------------------------
 * Small shared helpers.
 * ---------------------------------------------------------------------- */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `YYYY-MM-DD HH:MM JST` for a stored epoch-ms column. Pure — the timestamp is data, never `now()`, so this needs no injected clock. */
export function formatJstTimestamp(epochMs: number): string {
  const shifted = new Date(epochMs + JST_OFFSET_MS);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} JST`
  );
}

/**
 * The parser's RefCategory to the spelling stored in
 * `product_refs.category`. Named separately from REF_CATEGORY_LABELS
 * (src/refs/model.ts) because this one is checked against
 * ProductCategory, i.e. against the column's DDL enum, rather than
 * against the markdown source's wording — the two are the same three
 * strings for the same reason, not by coincidence, and a drift test pins
 * them together (src/refs/commands.test.ts).
 */
export const DB_CATEGORY_BY_REF_CATEGORY = {
  general: "general",
  "general-diy": "general (built) / diy (kit)",
  small: "small",
} as const satisfies Record<RefCategory, ProductCategory>;

const encoder = new TextEncoder();

/** UTF-8 byte length — what `ref history` reports, since the corpus is Japanese and `.length` would understate every body by roughly a third. */
export function byteSize(text: string): number {
  return encoder.encode(text).length;
}

/** First non-blank line of a body (the H1), for one-line history entries. Never the whole body — CLAUDE.md: a reference body is customer-facing business text. */
function firstLine(bodyMd: string): string {
  return bodyMd.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/**
 * The alias set a reference registers: every declared alias plus its own
 * H1 display name, normalized and deduped.
 *
 * This deliberately mirrors `aliasesFor` in
 * scripts/build-seed-migration.mjs, which is why the H1 is included —
 * the resolver exact-matches before it ever falls back to containment
 * (issue #9), so a product that lost its H1 alias on the first approved
 * edit would start resolving `ambiguous` from its own display name.
 * Deduped because `product_ref_aliases.alias_norm` is a PRIMARY KEY and
 * many references already list their H1 among their aliases.
 */
export function productRefAliasNorms(ref: ProductRef): string[] {
  return [...new Set([...ref.aliases, ref.displayName].map(normalizeAlias))].filter((alias) => alias !== "");
}

function textPayload(text: string, summaryText = text): SlackMessagePayload {
  return buildMessagePayload([{ type: "section", block_id: "bot_text", text: { type: "mrkdwn", text } }], summaryText);
}

function contextBlock(blockId: string, text: string): unknown {
  return { type: "context", block_id: blockId, elements: [{ type: "mrkdwn", text }] };
}

/**
 * Renders `bodyMd` as rich_text_preformatted blocks that fit alongside
 * `chromeBlocks` chrome blocks within Slack's 50-block message ceiling.
 * A reference long enough to trip this does not exist in the corpus, but
 * the alternative failure is `invalid_blocks` from Slack with no output
 * at all — a truncated body with a visible marker is strictly better
 * than nothing for a read-only command.
 */
function bodyBlocks(bodyMd: string, chromeBlocks: number): { blocks: unknown[]; truncated: boolean } {
  const all = buildReplyBlocks(bodyMd);
  const budget = MAX_BLOCKS_PER_MESSAGE - chromeBlocks;
  if (all.length <= budget) return { blocks: all, truncated: false };
  return { blocks: all.slice(0, Math.max(budget - 1, 1)), truncated: true };
}

/* -------------------------------------------------------------------------
 * Resolving a `ref <sub> <target>` argument to a stored reference.
 * ---------------------------------------------------------------------- */

export type RefTargetResult =
  | { kind: "found"; ref: ProductRefRow }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "miss" };

/**
 * Resolves the `<slugまたは製品名>` argument. An exact slug wins outright
 * — it is the unambiguous spelling `ref show`'s own output prints, so a
 * copy-paste of that must never go through fuzzy matching — and anything
 * else falls through to the normal resolver (alias, product URL,
 * containment; src/refs/resolve.ts).
 */
export async function resolveRefTarget(deps: RepoDeps, target: string): Promise<RefTargetResult> {
  const exact = await getProductRefBySlug(deps, target.trim());
  if (exact) return { kind: "found", ref: exact };

  const resolved = await resolveProductRef(deps, target);
  if (resolved.kind === "match" || resolved.kind === "variant-ambiguous") {
    // A general-diy product resolves `variant-ambiguous` when built-vs-kit
    // cannot be told from the text. That distinction is about which reply
    // to compose; the reference document is the same one either way, so
    // these commands do not need to ask.
    return { kind: "found", ref: resolved.ref };
  }
  if (resolved.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: resolved.candidates.map((candidate) => candidate.slug) };
  }
  return { kind: "miss" };
}

function targetProblemPayload(target: string, result: Exclude<RefTargetResult, { kind: "found" }>): SlackMessagePayload {
  if (result.kind === "ambiguous") {
    const list = result.candidates.map((slug) => `• \`${escapeMrkdwn(slug)}\``).join("\n");
    return textPayload(
      `「${escapeMrkdwn(target)}」に複数の製品が該当します。slugで指定し直してください。\n${list}`,
      "製品候補が複数あります。",
    );
  }
  return textPayload(
    `「${escapeMrkdwn(target)}」に一致する製品リファレンスが見つかりませんでした。`,
    "製品リファレンスが見つかりませんでした。",
  );
}

/* -------------------------------------------------------------------------
 * ref show / ref history.
 * ---------------------------------------------------------------------- */

export function buildRefShowPayload(ref: ProductRefRow): SlackMessagePayload {
  const header = {
    type: "section",
    block_id: "ref_show_header",
    text: { type: "mrkdwn", text: `*${escapeMrkdwn(ref.slug)}* のリファレンス（v${ref.version}）` },
  };
  const { blocks, truncated } = bodyBlocks(ref.body_md, 3);
  const context = contextBlock(
    "ref_show_context",
    [
      `slug: \`${escapeMrkdwn(ref.slug)}\``,
      `category: ${escapeMrkdwn(ref.category)}`,
      `v${ref.version}`,
      `更新: ${formatJstTimestamp(ref.updated_at)}`,
      `更新者: ${escapeMrkdwn(ref.updated_by)}`,
      `${byteSize(ref.body_md)} B`,
    ].join(" ｜ "),
  );

  return buildMessagePayload(
    [
      header,
      ...blocks,
      ...(truncated ? [contextBlock("ref_show_truncated", "（長すぎるため一部のみ表示しています）")] : []),
      context,
    ],
    `${ref.slug} のリファレンス`,
  );
}

export function buildRefHistoryPayload(slug: string, versions: readonly ProductRefVersionRow[]): SlackMessagePayload {
  if (versions.length === 0) {
    return textPayload(`\`${escapeMrkdwn(slug)}\` の変更履歴がありません。`, "変更履歴がありません。");
  }

  const shown = versions.slice(0, REF_HISTORY_LIMIT);
  const lines = shown.map((version) =>
    [
      `*v${version.version}*`,
      formatJstTimestamp(version.created_at),
      escapeMrkdwn(version.created_by),
      escapeMrkdwn(version.source),
      `${byteSize(version.body_md)} B`,
      escapeMrkdwn(firstLine(version.body_md)),
    ].join(" ｜ "),
  );

  const remaining = versions.length - shown.length;
  const more = remaining > 0 ? `\n\n他 ${remaining} 件（新しい順に ${REF_HISTORY_LIMIT} 件のみ表示）` : "";
  const restoreHint = `\n\n\`@bot ref restore ${slug} <バージョン番号>\` で任意のバージョンに戻せます。`;

  return buildMessagePayload(
    [
      {
        type: "section",
        block_id: "ref_history",
        text: {
          type: "mrkdwn",
          text: `*${escapeMrkdwn(slug)}* の変更履歴（新しい順）\n\n${lines.join("\n")}${more}${restoreHint}`,
        },
      },
    ],
    `${slug} の変更履歴`,
  );
}

/* -------------------------------------------------------------------------
 * The draft preview — the single approval surface for every reference
 * write — `ref restore`, `ref new` and `ref refresh` alike.
 * ---------------------------------------------------------------------- */

export interface RefDraftPreviewInput {
  draftId: string;
  slug: string;
  /** The exact body the approval will store — shown verbatim so what is approved is what lands. */
  bodyMd: string;
  /** One mrkdwn line stating what approving does, e.g. "v3 の内容に戻します（現在 v7 → 承認すると v8）". */
  headline: string;
  /** Draft `expires_at`, rendered as a hint so the operator sees the window. */
  expiresAt: number;
}

/**
 * The approve/reject preview message.
 *
 * ⚠️ Built with `buildConfirmCancelBlocks` and EXPLICIT action ids, not
 * with `buildApprovalBlocks`: that helper derives
 * `${actionId}_approve` / `${actionId}_cancel`, and src/slack/
 * interactions.ts has a handler for `ref_reject`, none for any
 * `_cancel`. A reject button built the other way renders perfectly and
 * does nothing at all — the draft stays pending with no feedback (issue
 * #14's report; issue #15 comment).
 */
export function buildRefDraftPreviewPayload(input: RefDraftPreviewInput): SlackMessagePayload {
  const header = {
    type: "section",
    block_id: "ref_draft_header",
    text: { type: "mrkdwn", text: `*${escapeMrkdwn(input.slug)}*\n${input.headline}` },
  };
  const { blocks, truncated } = bodyBlocks(input.bodyMd, 4);
  const actions = buildConfirmCancelBlocks({
    blockId: "ref_draft_actions",
    confirmActionId: ACTION_IDS.refApprove,
    cancelActionId: ACTION_IDS.refReject,
    value: encodeButtonValue({ v: 1, id: input.draftId }),
  });
  const hint = contextBlock(
    "ref_draft_hint",
    `この確認は ${formatJstTimestamp(input.expiresAt)} まで有効です。承認・却下できるのは管理者のみです。`,
  );

  return buildMessagePayload(
    [
      header,
      ...blocks,
      ...(truncated ? [contextBlock("ref_draft_truncated", "（長すぎるため一部のみ表示しています）")] : []),
      ...actions,
      hint,
    ],
    `${input.slug} の変更を確認してください`,
  );
}

/* -------------------------------------------------------------------------
 * Approve / reject.
 * ---------------------------------------------------------------------- */

export type RefDraftOutcome =
  /** Written. `version` is the new current version. */
  | { kind: "committed"; slug: string; version: number }
  /** The draft is missing, already consumed, or past `expires_at`. */
  | { kind: "gone" }
  /** `base_version` no longer matches the stored `version` — a concurrent edit landed in between. */
  | { kind: "stale"; slug: string; baseVersion: number | null; currentVersion: number | null }
  /** The body does not parse. `message` is the RefParseError text (file/heading/line), never the body itself. */
  | { kind: "unparseable"; slug: string; message: string }
  /** One of the body's aliases is already registered to a different product; `product_ref_aliases.alias_norm` is a PRIMARY KEY. */
  | { kind: "alias-conflict"; slug: string; conflicts: { aliasNorm: string; slug: string }[] }
  /** Everything checked out, but the batch's own fence matched zero rows — someone else got there first between the checks and the write. Nothing was written. */
  | { kind: "lost-race"; slug: string };

/** True once `expires_at` has passed or `consumed_at` is stamped. */
function draftIsSpent(draft: RefDraftRow, nowMs: number): boolean {
  return draft.consumed_at !== null || draft.expires_at <= nowMs;
}

/**
 * The approve path. Runs every refusal check before touching anything,
 * then hands the write to src/db/repos.ts commitRefDraft, which fences
 * the same preconditions inside its single `db.batch()` so a race lost
 * *between* the checks and the write commits nothing rather than
 * committing half of it.
 *
 * Callers must have already gated on admin (src/slack/interactions.ts
 * checks it on the click, since the clicker need not be the mentioner).
 */
export async function approveRefDraft(
  deps: RepoDeps,
  draftId: string,
  actorUserId: string,
): Promise<RefDraftOutcome> {
  const draft = await getRefDraft(deps, draftId);
  if (!draft || draftIsSpent(draft, deps.now().getTime())) return { kind: "gone" };

  // Re-parse BEFORE any write: a body the renderer cannot render must
  // never reach product_refs, and a draft can be minutes old — the
  // parser it was validated against at authoring time is not necessarily
  // the one running now.
  let parsed: ProductRef;
  try {
    parsed = parseProductRefMarkdown({ slug: draft.slug, markdown: draft.body_md });
  } catch (error) {
    if (error instanceof RefParseError) return { kind: "unparseable", slug: draft.slug, message: error.message };
    throw error;
  }

  const current = await getProductRefBySlug(deps, draft.slug);
  const currentVersion = current?.version ?? null;
  if (draft.base_version !== currentVersion) {
    return { kind: "stale", slug: draft.slug, baseVersion: draft.base_version, currentVersion };
  }

  // The body — not the draft's own category/product_url columns — is the
  // source of truth for what gets stored: it is what `ref show` prints,
  // what the renderer reads, and what the next edit will be parsed from.
  const aliases = productRefAliasNorms(parsed);
  const conflicts = (await findAliasOwners(deps, aliases)).filter((owner) => owner.slug !== draft.slug);
  if (conflicts.length > 0) return { kind: "alias-conflict", slug: draft.slug, conflicts };

  const result = await commitRefDraft(deps, {
    draftId: draft.id,
    slug: draft.slug,
    expectedVersion: draft.base_version,
    category: DB_CATEGORY_BY_REF_CATEGORY[parsed.category],
    productUrl: parsed.productUrl ?? null,
    bodyMd: draft.body_md,
    aliases,
    actorUserId,
    source: draft.source,
  });
  if (!result.committed) return { kind: "lost-race", slug: draft.slug };
  return { kind: "committed", slug: draft.slug, version: result.version };
}

/** The reject path: stamps `consumed_at` and writes nothing else. Returns the draft when this click is the one that consumed it, null when it was already spent. */
export async function rejectRefDraft(deps: RepoDeps, draftId: string): Promise<RefDraftRow | null> {
  return consumeRefDraft(deps, draftId);
}

/**
 * Japanese operator-facing text for an approval outcome, as mrkdwn.
 *
 * The `unparseable` case quotes the RefParseError, which carries the
 * offending source line — deliberately: naming the line is the whole
 * point of that error, and this goes to the admin in Slack, where `ref
 * show` prints the entire body anyway. What must never carry a body is a
 * LOG (CLAUDE.md), and nothing here is logged.
 */
export function describeRefDraftOutcome(outcome: RefDraftOutcome): string {
  switch (outcome.kind) {
    case "committed":
      return `「${escapeMrkdwn(outcome.slug)}」を承認し、v${outcome.version} として反映しました。`;
    case "gone":
      return "この確認は既に処理済みか、期限切れです。コマンドをもう一度実行してください。";
    case "stale": {
      const base = outcome.baseVersion === null ? "新規作成" : `v${outcome.baseVersion}`;
      const now = outcome.currentVersion === null ? "未登録" : `v${outcome.currentVersion}`;
      return (
        `「${escapeMrkdwn(outcome.slug)}」はこの確認を作成した後に変更されています（${base} → ${now}）。` +
        "何も書き込んでいません。コマンドをもう一度実行してください。"
      );
    }
    case "unparseable":
      return `「${escapeMrkdwn(outcome.slug)}」の本文を解析できませんでした。何も書き込んでいません。\n${escapeMrkdwn(outcome.message)}`;
    case "alias-conflict": {
      const list = outcome.conflicts
        .map((conflict) => `\`${escapeMrkdwn(conflict.aliasNorm)}\`（${escapeMrkdwn(conflict.slug)}）`)
        .join("、 ");
      return (
        `「${escapeMrkdwn(outcome.slug)}」のエイリアスが他の製品と重複しています: ${list}。` +
        "何も書き込んでいません。aliases を修正してからやり直してください。"
      );
    }
    case "lost-race":
      return `「${escapeMrkdwn(outcome.slug)}」は同時に別の変更が反映されたため、何も書き込んでいません。もう一度実行してください。`;
  }
}

/* -------------------------------------------------------------------------
 * ref restore.
 * ---------------------------------------------------------------------- */

async function buildRestorePayload(
  deps: RepoDeps,
  ref: ProductRefRow,
  version: number,
  actorUserId: string,
): Promise<SlackMessagePayload> {
  const target = await getProductRefVersion(deps, ref.slug, version);
  if (!target) {
    const available = await listProductRefVersions(deps, ref.slug);
    const known = available.map((row) => `v${row.version}`).join(", ");
    return textPayload(
      `\`${escapeMrkdwn(ref.slug)}\` に v${version} は存在しません。${known === "" ? "" : `記録されているバージョン: ${escapeMrkdwn(known)}`}`,
      "指定のバージョンがありません。",
    );
  }

  // Validate here as well as at approval time: a historical body that no
  // longer parses is worth surfacing before the operator clicks, not
  // after. The approve path re-checks regardless — this is the friendlier
  // error, not the guard.
  try {
    parseProductRefMarkdown({ slug: ref.slug, markdown: target.body_md });
  } catch (error) {
    if (error instanceof RefParseError) {
      return textPayload(
        `\`${escapeMrkdwn(ref.slug)}\` の v${version} は現在のパーサで解析できないため復元できません。\n${escapeMrkdwn(error.message)}`,
        "そのバージョンは復元できません。",
      );
    }
    throw error;
  }

  const draft = await createRefDraft(deps, {
    slug: ref.slug,
    category: target.category,
    productUrl: target.product_url,
    bodyMd: target.body_md,
    // The version the operator is looking at RIGHT NOW — not the version
    // being restored. This is what makes a stale approval refuse instead
    // of silently overwriting whatever landed in between.
    baseVersion: ref.version,
    createdByUserId: actorUserId,
    expiresAt: deps.now().getTime() + REF_DRAFT_TTL_MS,
    source: "restored",
  });

  const identical = target.body_md === ref.body_md;
  const headline =
    `v${version}（${formatJstTimestamp(target.created_at)}）の内容に戻します。` +
    `現在は v${ref.version} で、承認すると v${ref.version + 1} として記録されます。履歴は削除されません。` +
    (identical ? "\n※ 現在の内容と同一です。" : "");

  return buildRefDraftPreviewPayload({
    draftId: draft.id,
    slug: ref.slug,
    bodyMd: target.body_md,
    headline,
    expiresAt: draft.expires_at,
  });
}

/* -------------------------------------------------------------------------
 * ref new / ref refresh — the LLM-authored half (issue #17).
 * ---------------------------------------------------------------------- */

/**
 * Sources src/refs/authoring.ts could not read, plus the coverage caveat
 * that is true of EVERY candidate — stated on every preview, not only
 * degraded ones.
 *
 * The site exposes no manuals-per-product and no guide-series-per-product
 * endpoint (issue #17): both are server-rendered into the product page
 * only, so the resource list is assembled from `/api/products`,
 * `/api/search` and whatever links that page happened to carry. Coverage
 * is therefore imperfect BY CONSTRUCTION, and the human approving this is
 * the only check on it. Saying so once here is what stops the preview
 * from reading like a verified list.
 */
function authoringCaveats(outcome: Extract<AuthorRefOutcome, { kind: "drafted" }>): string[] {
  const report = outcome.report;
  const notes = [
    "※ マニュアル・ガイドシリーズを製品ごとに引ける API がサイトにないため、" +
      "リンクの拾い漏れがありえます。リンク先と本文を確認してから承認してください。",
  ];

  for (const note of report.degraded) notes.push(`※ ${note}`);
  if (report.contentTruncated) {
    notes.push("※ 取得したページが長かったため、行単位で切り詰めて読み込んでいます。");
  }
  if (report.categoryFromCatalog === null) {
    // The built/kit pair is the only category the catalog can prove.
    // general vs small is a shipping-size judgement, and it picks the
    // ヤマト or ネコポス line in every reply this reference produces.
    notes.push("※ category はカタログから確定できないため、生成結果です。general と small の別は必ず確認してください。");
  }
  if (report.refusedAliases.length > 0) {
    notes.push(
      `※ 他の製品が既に使用しているため除外したエイリアス: ${report.refusedAliases.map((alias) => `\`${escapeMrkdwn(alias)}\``).join("、 ")}`,
    );
  }
  if (report.productUrlChangedFrom !== null) {
    notes.push(`※ product-url がカタログ側で変わっています（旧: ${escapeMrkdwn(report.productUrlChangedFrom)}）。`);
  }
  return notes;
}

/** The one-line "what approving does" statement, plus the caveats. Mirrors buildRestorePayload's headline shape — one sentence, then `※` notes. */
function authoringHeadline(outcome: Extract<AuthorRefOutcome, { kind: "drafted" }>): string {
  const report = outcome.report;
  const lead =
    outcome.baseVersion === null
      ? `新しいリファレンスを作成します（承認すると v1 として登録されます）。リンク ${report.resourceCount} 件。`
      : `既存のリファレンスを更新します（現在 v${outcome.baseVersion} → 承認すると v${outcome.baseVersion + 1}）。` +
        `既存のリンク ${report.preservedCount} 件を維持し、${report.addedCount} 件を追加します。`;
  return [lead, ...authoringCaveats(outcome)].join("\n");
}

/** Japanese for a non-`drafted` outcome. Every one of these wrote nothing at all — say so, since the operator's next move is to re-run the command. */
function authoringProblemPayload(outcome: Exclude<AuthorRefOutcome, { kind: "drafted" }>): SlackMessagePayload {
  switch (outcome.kind) {
    case "no-product": {
      const degraded = outcome.degraded.map((note) => `\n※ ${note}`).join("");
      return textPayload(
        `「${escapeMrkdwn(outcome.query)}」に該当する製品ページがサイトのカタログに見つかりませんでした。` +
          `製品ページのない製品のリファレンスは作成できません。製品名を変えてもう一度試してください。${degraded}`,
        "該当する製品が見つかりませんでした。",
      );
    }
    case "already-exists":
      return textPayload(
        `\`${escapeMrkdwn(outcome.slug)}\` のリファレンスは既に存在します（v${outcome.version}）。` +
          `更新する場合は \`@bot ref refresh ${escapeMrkdwn(outcome.slug)}\` を使ってください。`,
        "そのリファレンスは既に存在します。",
      );
    case "failed":
      // Deliberately no fallback text and no partial draft: there is no
      // deterministic way to invent a reference, and a half-authored one
      // approved by a human who assumed it was checked is the failure
      // this path exists to avoid (src/refs/authoring.ts).
      return textPayload(
        "リファレンスの生成に失敗しました。何も書き込んでいません。もう一度試すか、内容を手で用意してください。\n" +
          `※ 理由: ${escapeMrkdwn(outcome.trip.reason)}（${escapeMrkdwn(outcome.trip.guard)} / ${escapeMrkdwn(outcome.provider)}）` +
          `\n※ 詳細: ${escapeMrkdwn(outcome.trip.detail)}`,
        "リファレンスの生成に失敗しました。",
      );
  }
}

export interface RefCommandOptions {
  /**
   * Outbound HTTP for the authoring path — BOTH the takazudomodular.com
   * reads and the provider call go through it (src/refs/site.ts,
   * src/llm/claude.ts). Defaults to the runtime's own `fetch`, so
   * src/jobs/worker.ts needs no change; a test passes one fake and drives
   * the whole path.
   */
  fetch?: FetchLike;
  /** Overrides src/refs/authoring.ts DEFAULT_AUTHOR_DAILY_CAP. */
  dailyCap?: number;
}

/** Bound so a `fetch` implementation that requires its own receiver keeps it. */
const defaultFetch: FetchLike = (...args) => fetch(...args);

/**
 * Authors a candidate reference and turns it into a draft + preview —
 * `ref new`, `ref refresh`, and the implicit `create_reference` button
 * (issue #17's "first-time purchase gets LLM-generated text" path), which
 * is why this is exported rather than folded into the dispatch below.
 *
 * **Nothing reaches `product_refs` here.** The only write is the
 * `ref_drafts` row; an admin clicking approve is what commits it, through
 * approveRefDraft above, which re-parses the body and re-derives its
 * aliases at that point. Callers must have already gated on admin.
 */
export async function buildAuthoredRefPayload(
  env: Env,
  deps: RepoDeps,
  input: AuthorRefInput,
  actorUserId: string,
  options: RefCommandOptions = {},
): Promise<SlackMessagePayload> {
  const outcome = await authorProductRef(
    {
      env,
      fetch: options.fetch ?? defaultFetch,
      now: deps.now,
      ...(options.dailyCap === undefined ? {} : { dailyCap: options.dailyCap }),
    },
    input,
  );
  if (outcome.kind !== "drafted") return authoringProblemPayload(outcome);

  // Checked before the draft exists rather than at approval time: an
  // alias another product owns would abort commitRefDraft's batch on the
  // `product_ref_aliases.alias_norm` PRIMARY KEY, and finding that out
  // after a human has read and approved the whole document wastes the
  // one scarce thing in this flow. approveRefDraft checks it again on
  // the freshly parsed body — this is the earlier, friendlier one.
  const conflicts = (await findAliasOwners(deps, productRefAliasNorms(outcome.ref))).filter(
    (owner) => owner.slug !== outcome.slug,
  );
  if (conflicts.length > 0) {
    const list = conflicts
      .map((conflict) => `\`${escapeMrkdwn(conflict.aliasNorm)}\`（${escapeMrkdwn(conflict.slug)}）`)
      .join("、 ");
    return textPayload(
      `生成された aliases が他の製品と重複しているため、確認を作成できませんでした: ${list}。何も書き込んでいません。`,
      "エイリアスが重複しています。",
    );
  }

  const draft = await createRefDraft(deps, {
    slug: outcome.slug,
    category: outcome.category,
    productUrl: outcome.productUrl,
    bodyMd: outcome.bodyMd,
    // NULL for a new reference, the version this was authored against for
    // a refresh — the fence that makes a stale approval refuse instead of
    // overwriting whatever landed in between. `source` is omitted on
    // purpose: createRefDraft derives authored/refreshed from exactly this.
    baseVersion: outcome.baseVersion,
    createdByUserId: actorUserId,
    expiresAt: deps.now().getTime() + REF_DRAFT_TTL_MS,
  });

  return buildRefDraftPreviewPayload({
    draftId: draft.id,
    slug: outcome.slug,
    bodyMd: outcome.bodyMd,
    headline: authoringHeadline(outcome),
    expiresAt: draft.expires_at,
  });
}

/* -------------------------------------------------------------------------
 * Dispatch — the entry point src/jobs/worker.ts calls for a `ref` job.
 * ---------------------------------------------------------------------- */

const ADMIN_ONLY_TEXT = "この操作には管理者権限が必要です。";

/**
 * Builds the Slack payload for a `ref` job. Mirrors the `reply` branch's
 * shape in src/jobs/worker.ts: this returns the payload, the worker
 * posts it and owns the job's state transitions.
 *
 * Writes (`restore`, `new`, `refresh`) are admin-gated here on
 * `job.actor_user_id`, and gated a SECOND time on
 * the approval click in src/slack/interactions.ts — the person who
 * clicks is not necessarily the person who typed, and the two can be
 * half an hour apart.
 */
export async function buildRefCommandPayload(
  env: Env,
  deps: RepoDeps,
  job: JobRow,
  options: RefCommandOptions = {},
): Promise<SlackMessagePayload> {
  const parsed = parseCommand(job.raw_text, env.SLACK_BOT_USER_ID);

  if (parsed.kind === "unknown") {
    return textPayload(`${escapeMrkdwn(parsed.reason)}\n\n${USAGE_TEXT}`, "コマンドを解釈できませんでした。");
  }
  if (parsed.kind === "help") {
    return textPayload(USAGE_TEXT, "使い方");
  }
  if (parsed.kind === "reply" || parsed.kind === "polish") {
    // src/slack/events.ts classifyJobKind routes a leading "ref" to
    // job.kind "ref" before this is ever reached, so the two tokenizers
    // disagreeing is a real bug, not a runtime state — same reasoning as
    // buildReplyJobPayload's mirror-image check in src/jobs/worker.ts.
    throw new Error(
      `ref job ${job.id}: parseCommand returned "${parsed.kind}" for a job classified as "ref" ` +
        `— classifyJobKind/parseCommand drift`,
    );
  }

  const isAdmin = isAdminUser(env, job.actor_user_id);

  if (parsed.kind === "ref_new") {
    if (!isAdmin) return textPayload(ADMIN_ONLY_TEXT);
    return buildAuthoredRefPayload(env, deps, { mode: "new", query: parsed.query }, job.actor_user_id, options);
  }

  const target = parsed.slug;
  const resolved = await resolveRefTarget(deps, target);
  if (resolved.kind !== "found") return targetProblemPayload(target, resolved);
  const ref = resolved.ref;

  if (parsed.kind === "ref_show") {
    return buildRefShowPayload(ref);
  }
  if (parsed.kind === "ref_history") {
    return buildRefHistoryPayload(ref.slug, await listProductRefVersions(deps, ref.slug));
  }
  if (parsed.kind === "ref_refresh") {
    if (!isAdmin) return textPayload(ADMIN_ONLY_TEXT);
    return buildAuthoredRefPayload(env, deps, { mode: "refresh", existing: ref }, job.actor_user_id, options);
  }

  // parsed.kind === "ref_restore"
  if (!isAdmin) return textPayload(ADMIN_ONLY_TEXT);
  return buildRestorePayload(deps, ref, parsed.version, job.actor_user_id);
}
