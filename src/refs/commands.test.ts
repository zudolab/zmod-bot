/**
 * `ref show` / `ref history` / `ref restore` and the approve path they
 * feed into.
 *
 * Run against the Miniflare-backed real D1 (tests/helpers/test-env.ts)
 * rather than createMockD1, because almost every assertion here IS a
 * storage semantic: the expected-version fence matching zero rows, the
 * single `db.batch()` either landing four writes or none, and history
 * staying append-only across a restore. A Map-backed stub could agree
 * with itself about all three while production disagreed — see
 * src/db/test-support.ts's two-tier rationale.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createRefDraft,
  getProductRefBySlug,
  getRefDraft,
  listProductRefAliases,
  listProductRefVersions,
  upsertProductRef,
  type RepoDeps,
} from "../db/repos";
import type { JobRow } from "../db/schema";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import type { Env } from "../env";
import { REF_CATEGORY_LABELS } from "./model";
import { parseProductRefMarkdown } from "./parse";
import { normalizeAlias, resolveProductRef } from "./resolve";
import {
  DB_CATEGORY_BY_REF_CATEGORY,
  REF_DRAFT_TTL_MS,
  approveRefDraft,
  buildRefCommandPayload,
  byteSize,
  formatJstTimestamp,
  productRefAliasNorms,
  rejectRefDraft,
} from "./commands";
import { ACTION_IDS, decodeButtonValue } from "../slack/commands";

const BOT_USER_ID = "U0BOT1";
const ADMIN = "U_ADMIN";
const NOBODY = "U_NOT_ADMIN";
const NOW_MS = 1_760_000_000_000;

const SLUG = "test-widget";

/** v1 of the fixture: two aliases, one of which v2 drops. */
const BODY_V1 = [
  "# Test Widget",
  "",
  "- category: general",
  "- product-url: https://takazudomodular.com/products/test-widget/",
  "- aliases: test widget, widget alpha",
  "",
  "## Notes",
  "",
  "original body",
  "",
].join("\n");

/** v2 drops the `widget alpha` alias — the "aliases are replaced, not merged" fixture. */
const BODY_V2 = [
  "# Test Widget",
  "",
  "- category: general",
  "- product-url: https://takazudomodular.com/products/test-widget/",
  "- aliases: test widget",
  "",
  "## Notes",
  "",
  "edited body",
  "",
].join("\n");

/** `Intro text:` with no value — the parser rejects it rather than demoting it to prose (src/refs/parse.ts). */
const BODY_UNPARSEABLE = ["# Test Widget", "", "- category: general", "", "## Notes", "", "Intro text:", ""].join("\n");

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_SIGNING_SECRET: "s",
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_ADMIN_USER_IDS: ADMIN,
    ...overrides,
  } as Env;
}

function refJob(rawText: string, actorUserId = ADMIN): JobRow {
  return {
    id: 1,
    event_id: "ev-1",
    kind: "ref",
    channel_id: "C1",
    thread_ts: "100.000",
    actor_user_id: actorUserId,
    raw_text: `<@${BOT_USER_ID}> ${rawText}`,
    state: "composing",
    attempts: 0,
    claim_token: null,
    claim_expires_at: null,
    last_error: null,
    created_at: NOW_MS,
    updated_at: NOW_MS,
    completed_at: null,
  };
}

/** Every string anywhere in a Block Kit payload, flattened — assertions here care that text is present, not which nesting level Slack puts it at. */
function allText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(allText).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(allText).join("\n");
  return "";
}

function blocksOfType(payload: { blocks: unknown[] }, type: string): Record<string, unknown>[] {
  return payload.blocks.filter(
    (block): block is Record<string, unknown> =>
      typeof block === "object" && block !== null && (block as Record<string, unknown>).type === type,
  );
}

/** The literal content of every rich_text_preformatted element — what a human copies out of Slack. */
function preformattedText(payload: { blocks: unknown[] }): string {
  return blocksOfType(payload, "rich_text")
    .map((block) => {
      const elements = (block.elements ?? []) as Record<string, unknown>[];
      return elements
        .map((element) => ((element.elements ?? []) as Record<string, unknown>[]).map((leaf) => String(leaf.text ?? "")).join(""))
        .join("");
    })
    .join("");
}

describe("ref commands", () => {
  let env: TestEnvHandle | undefined;
  let deps: RepoDeps;
  let slackEnv: Env;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    deps = { db: env.db, now: () => new Date(NOW_MS) };
    slackEnv = baseEnv();
  }

  async function seedV1() {
    const ref = parseProductRefMarkdown({ slug: SLUG, markdown: BODY_V1 });
    await upsertProductRef(deps, {
      slug: SLUG,
      category: DB_CATEGORY_BY_REF_CATEGORY[ref.category],
      productUrl: ref.productUrl ?? null,
      bodyMd: BODY_V1,
      aliases: productRefAliasNorms(ref),
      changedByUserId: "seed",
      source: "seed",
    });
  }

  /** Creates a draft the way issue #17's authoring flow will, then approves it as `actor`. */
  async function draftAndApprove(input: {
    bodyMd: string;
    baseVersion: number | null;
    actor?: string;
    expiresAt?: number;
    slug?: string;
  }) {
    const draft = await createRefDraft(deps, {
      slug: input.slug ?? SLUG,
      category: "general",
      productUrl: null,
      bodyMd: input.bodyMd,
      baseVersion: input.baseVersion,
      createdByUserId: ADMIN,
      expiresAt: input.expiresAt ?? NOW_MS + REF_DRAFT_TTL_MS,
    });
    const outcome = await approveRefDraft(deps, draft.id, input.actor ?? ADMIN);
    return { draft, outcome };
  }

  /* --------------------------------------------------------------- show */

  it("ref show posts the body as literal preformatted text with a slug/category/version/updated context line", async () => {
    await setup();
    await seedV1();

    const payload = await buildRefCommandPayload(slackEnv, deps, refJob(`ref show ${SLUG}`, NOBODY));

    // The body is rich_text_preformatted (literal), never mrkdwn -- the
    // same CLAUDE.md rule the reply body follows.
    expect(preformattedText(payload)).toBe(BODY_V1);

    const context = allText(blocksOfType(payload, "context"));
    expect(context).toContain(SLUG);
    expect(context).toContain("general");
    expect(context).toContain("v1");
    expect(context).toContain(formatJstTimestamp(NOW_MS));
    expect(context).toContain("seed");
  });

  it("ref show resolves a display name, not just an exact slug", async () => {
    await setup();
    await seedV1();

    const payload = await buildRefCommandPayload(slackEnv, deps, refJob("ref show Test Widget", NOBODY));
    expect(preformattedText(payload)).toBe(BODY_V1);
  });

  it("ref show reports a miss instead of dead-ending", async () => {
    await setup();
    await seedV1();

    const payload = await buildRefCommandPayload(slackEnv, deps, refJob("ref show no-such-product", NOBODY));
    expect(preformattedText(payload)).toBe("");
    expect(allText(payload.blocks)).toContain("見つかりませんでした");
  });

  /* ------------------------------------------------------------ history */

  it("ref history lists versions newest-first with created_at, created_by, source, byte size and the first line", async () => {
    await setup();
    await seedV1();
    await draftAndApprove({ bodyMd: BODY_V2, baseVersion: 1 });

    const payload = await buildRefCommandPayload(slackEnv, deps, refJob(`ref history ${SLUG}`, NOBODY));
    const text = allText(payload.blocks);

    expect(text.indexOf("v2")).toBeLessThan(text.indexOf("v1")); // newest first
    expect(text).toContain("seed");
    expect(text).toContain("refreshed");
    expect(text).toContain(ADMIN);
    expect(text).toContain(`${byteSize(BODY_V1)} B`);
    expect(text).toContain(`${byteSize(BODY_V2)} B`);
    expect(text).toContain("# Test Widget");
    // Never the whole body -- a reference body is customer-facing business text.
    expect(text).not.toContain("original body");
  });

  it("ref history caps the listing at 20 and reports the remainder", async () => {
    await setup();
    await seedV1();
    for (let version = 1; version <= 24; version += 1) {
      await draftAndApprove({ bodyMd: BODY_V1.replace("original body", `body ${version}`), baseVersion: version });
    }

    const payload = await buildRefCommandPayload(slackEnv, deps, refJob(`ref history ${SLUG}`, NOBODY));
    const text = allText(payload.blocks);

    expect(text).toContain("v25");
    expect(text).toContain("v6");
    expect(text).not.toMatch(/\bv5\b/);
    expect(text).toContain("他 5 件");
  });

  /* ------------------------------------------------------------ restore */

  it("ref restore is refused for a non-admin and creates no draft", async () => {
    await setup();
    await seedV1();

    const payload = await buildRefCommandPayload(slackEnv, deps, refJob(`ref restore ${SLUG} 1`, NOBODY));
    expect(allText(payload.blocks)).toContain("管理者権限");

    const drafts = await env!.db.prepare("SELECT COUNT(*) AS c FROM ref_drafts").first<{ c: number }>();
    expect(drafts?.c).toBe(0);
  });

  it("ref restore builds a confirmation carrying ref_approve / ref_reject -- never a _cancel id nothing handles", async () => {
    await setup();
    await seedV1();
    await draftAndApprove({ bodyMd: BODY_V2, baseVersion: 1 });

    const payload = await buildRefCommandPayload(slackEnv, deps, refJob(`ref restore ${SLUG} 1`, ADMIN));

    const actions = blocksOfType(payload, "actions");
    expect(actions).toHaveLength(1);
    const elements = (actions[0]!.elements ?? []) as Record<string, unknown>[];
    const actionIds = elements.map((element) => element.action_id);
    expect(actionIds).toEqual([ACTION_IDS.refApprove, ACTION_IDS.refReject]);
    expect(actionIds).not.toContain("ref_cancel");
    expect(actionIds.some((id) => String(id).endsWith("_cancel"))).toBe(false);

    // Both buttons carry only the draft id, in the shared envelope.
    // The edit above left its own consumed draft behind; the pending one is the restore.
    const draftRow = await env!.db
      .prepare("SELECT * FROM ref_drafts WHERE consumed_at IS NULL")
      .first<{ id: string; base_version: number; source: string }>();
    for (const element of elements) {
      const envelope = decodeButtonValue(String(element.value));
      expect(envelope).toEqual({ v: 1, id: draftRow!.id });
    }

    // base_version is what the operator is looking at NOW (v2), not the
    // version being restored -- that is what makes a stale approval refuse.
    expect(draftRow!.base_version).toBe(2);
    expect(draftRow!.source).toBe("restored");
    expect(preformattedText(payload)).toBe(BODY_V1);
    expect(allText(payload.blocks)).toContain("履歴は削除されません");
  });

  it("ref restore of an unknown version names the versions that do exist and writes nothing", async () => {
    await setup();
    await seedV1();

    const payload = await buildRefCommandPayload(slackEnv, deps, refJob(`ref restore ${SLUG} 7`, ADMIN));
    const text = allText(payload.blocks);
    expect(text).toContain("v7 は存在しません");
    expect(text).toContain("v1");

    const drafts = await env!.db.prepare("SELECT COUNT(*) AS c FROM ref_drafts").first<{ c: number }>();
    expect(drafts?.c).toBe(0);
  });

  it("restore appends a new version byte-identical to the chosen one, and deletes nothing from history", async () => {
    await setup();
    await seedV1();
    await draftAndApprove({ bodyMd: BODY_V2, baseVersion: 1 });

    // Take the restore confirmation, then approve it exactly as a click would.
    await buildRefCommandPayload(slackEnv, deps, refJob(`ref restore ${SLUG} 1`, ADMIN));
    const draftRow = await env!.db.prepare("SELECT id FROM ref_drafts WHERE consumed_at IS NULL").first<{ id: string }>();
    const outcome = await approveRefDraft(deps, draftRow!.id, ADMIN);

    expect(outcome).toEqual({ kind: "committed", slug: SLUG, version: 3 });

    const current = await getProductRefBySlug(deps, SLUG);
    expect(current?.version).toBe(3);
    expect(current?.body_md).toBe(BODY_V1); // byte-identical to the restored version

    const versions = await listProductRefVersions(deps, SLUG);
    expect(versions.map((row) => row.version)).toEqual([3, 2, 1]);
    expect(versions.find((row) => row.version === 1)?.body_md).toBe(BODY_V1); // history untouched
    expect(versions.find((row) => row.version === 2)?.body_md).toBe(BODY_V2);
    expect(versions.find((row) => row.version === 3)?.source).toBe("restored");
    expect(versions.find((row) => row.version === 3)?.created_by).toBe(ADMIN);
  });

  /* ------------------------------------------------------------ approve */

  it("aliases are replaced wholesale, so an alias dropped from the body stops resolving", async () => {
    await setup();
    await seedV1();
    expect(await listProductRefAliases(deps, SLUG)).toContain(normalizeAlias("widget alpha"));

    await draftAndApprove({ bodyMd: BODY_V2, baseVersion: 1 });

    const aliases = await listProductRefAliases(deps, SLUG);
    expect(aliases).not.toContain(normalizeAlias("widget alpha"));
    expect(aliases).toContain(normalizeAlias("test widget"));
    expect(await resolveProductRef(deps, "widget alpha")).toEqual({ kind: "miss" });
    expect((await resolveProductRef(deps, "test widget")).kind).toBe("match");
  });

  it("the H1 display name stays registered as an alias across an approved edit", async () => {
    await setup();
    await seedV1();
    await draftAndApprove({ bodyMd: BODY_V2, baseVersion: 1 });

    expect(await listProductRefAliases(deps, SLUG)).toContain(normalizeAlias("Test Widget"));
  });

  it("a stale base_version is refused with both versions named, and nothing is written", async () => {
    await setup();
    await seedV1();

    // Author against v1 ...
    const stale = await createRefDraft(deps, {
      slug: SLUG,
      category: "general",
      productUrl: null,
      bodyMd: BODY_V2,
      baseVersion: 1,
      createdByUserId: ADMIN,
      expiresAt: NOW_MS + REF_DRAFT_TTL_MS,
    });
    // ... then let a concurrent edit land v2 before the click.
    await draftAndApprove({ bodyMd: BODY_V1.replace("original body", "concurrent edit"), baseVersion: 1 });

    const outcome = await approveRefDraft(deps, stale.id, ADMIN);
    expect(outcome).toEqual({ kind: "stale", slug: SLUG, baseVersion: 1, currentVersion: 2 });

    const current = await getProductRefBySlug(deps, SLUG);
    expect(current?.version).toBe(2);
    expect(current?.body_md).toContain("concurrent edit"); // the concurrent edit survived
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(2); // no third version row
    expect((await getRefDraft(deps, stale.id))?.consumed_at).toBeNull(); // refusal wrote nothing at all
  });

  it("a brand-new draft whose slug appeared in the meantime is refused rather than merged into it", async () => {
    await setup();

    const draft = await createRefDraft(deps, {
      slug: SLUG,
      category: "general",
      productUrl: null,
      bodyMd: BODY_V1,
      baseVersion: null,
      createdByUserId: ADMIN,
      expiresAt: NOW_MS + REF_DRAFT_TTL_MS,
    });
    await seedV1(); // someone created it first

    const outcome = await approveRefDraft(deps, draft.id, ADMIN);
    expect(outcome).toEqual({ kind: "stale", slug: SLUG, baseVersion: null, currentVersion: 1 });
    expect((await getProductRefBySlug(deps, SLUG))?.updated_by).toBe("seed");
  });

  it("an expired draft is refused and nothing is written", async () => {
    await setup();
    await seedV1();

    const draft = await createRefDraft(deps, {
      slug: SLUG,
      category: "general",
      productUrl: null,
      bodyMd: BODY_V2,
      baseVersion: 1,
      createdByUserId: ADMIN,
      expiresAt: NOW_MS - 1,
    });

    expect(await approveRefDraft(deps, draft.id, ADMIN)).toEqual({ kind: "gone" });
    expect((await getProductRefBySlug(deps, SLUG))?.version).toBe(1);
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(1);
  });

  it("an unknown draft id is refused (a stale or tampered click), not crashed on", async () => {
    await setup();
    expect(await approveRefDraft(deps, "no-such-draft", ADMIN)).toEqual({ kind: "gone" });
  });

  it("an already-consumed draft cannot be approved twice", async () => {
    await setup();
    await seedV1();

    const { draft, outcome } = await draftAndApprove({ bodyMd: BODY_V2, baseVersion: 1 });
    expect(outcome.kind).toBe("committed");

    expect(await approveRefDraft(deps, draft.id, ADMIN)).toEqual({ kind: "gone" });
    expect((await getProductRefBySlug(deps, SLUG))?.version).toBe(2);
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(2);
  });

  it("an unparseable body is refused before any write", async () => {
    await setup();
    await seedV1();

    const { draft, outcome } = await draftAndApprove({ bodyMd: BODY_UNPARSEABLE, baseVersion: 1 });
    expect(outcome.kind).toBe("unparseable");
    if (outcome.kind === "unparseable") expect(outcome.message).toContain("Intro text");

    expect((await getProductRefBySlug(deps, SLUG))?.body_md).toBe(BODY_V1);
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(1);
    // Not consumed -- the operator can fix the body and re-approve.
    expect((await getRefDraft(deps, draft.id))?.consumed_at).toBeNull();
  });

  it("an alias already owned by another product is refused instead of aborting the batch on the PRIMARY KEY", async () => {
    await setup();
    await seedV1();

    const { outcome } = await draftAndApprove({
      slug: "other-widget",
      bodyMd: BODY_V1.replace("# Test Widget", "# Other Widget").replace(
        "- aliases: test widget, widget alpha",
        "- aliases: widget alpha",
      ),
      baseVersion: null,
    });

    expect(outcome.kind).toBe("alias-conflict");
    if (outcome.kind === "alias-conflict") {
      expect(outcome.conflicts).toEqual([{ aliasNorm: normalizeAlias("widget alpha"), slug: SLUG }]);
    }
    expect(await getProductRefBySlug(deps, "other-widget")).toBeNull();
    expect(await listProductRefAliases(deps, SLUG)).toContain(normalizeAlias("widget alpha"));
  });

  it("the committed category and product_url come from the body, which is what ref show and the renderer read", async () => {
    await setup();

    const body = BODY_V1.replace("- category: general", "- category: small").replace(
      "https://takazudomodular.com/products/test-widget/",
      "https://takazudomodular.com/products/from-the-body/",
    );
    // The draft columns deliberately disagree with the body.
    const draft = await createRefDraft(deps, {
      slug: SLUG,
      category: "general",
      productUrl: "https://takazudomodular.com/products/from-the-column/",
      bodyMd: body,
      baseVersion: null,
      createdByUserId: ADMIN,
      expiresAt: NOW_MS + REF_DRAFT_TTL_MS,
    });
    expect((await approveRefDraft(deps, draft.id, ADMIN)).kind).toBe("committed");

    const current = await getProductRefBySlug(deps, SLUG);
    expect(current?.category).toBe("small");
    expect(current?.product_url).toBe("https://takazudomodular.com/products/from-the-body/");
  });

  /* ------------------------------------------------------------- reject */

  it("reject consumes the draft and writes nothing else", async () => {
    await setup();
    await seedV1();

    const draft = await createRefDraft(deps, {
      slug: SLUG,
      category: "general",
      productUrl: null,
      bodyMd: BODY_V2,
      baseVersion: 1,
      createdByUserId: ADMIN,
      expiresAt: NOW_MS + REF_DRAFT_TTL_MS,
    });

    expect((await rejectRefDraft(deps, draft.id))?.slug).toBe(SLUG);
    expect(await rejectRefDraft(deps, draft.id)).toBeNull(); // once only

    expect((await getProductRefBySlug(deps, SLUG))?.version).toBe(1);
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(1);
    expect(await approveRefDraft(deps, draft.id, ADMIN)).toEqual({ kind: "gone" });
  });

  /* -------------------------------------------------------------- misc */

  it("ref new / ref refresh refuse a non-admin before the authoring path can fetch anything", async () => {
    await setup();
    await seedV1();

    // The gate has to hold BEFORE any I/O: the authoring path reads the
    // live site and calls a paid provider (issue #17), so "refused" and
    // "refused after spending a model call" are different outcomes.
    const fetch = (() => {
      throw new Error("the authoring path must not run for a non-admin");
    }) as unknown as typeof globalThis.fetch;

    expect(
      allText((await buildRefCommandPayload(slackEnv, deps, refJob("ref new Some Product", NOBODY), { fetch })).blocks),
    ).toContain("管理者権限");
    expect(
      allText((await buildRefCommandPayload(slackEnv, deps, refJob(`ref refresh ${SLUG}`, NOBODY), { fetch })).blocks),
    ).toContain("管理者権限");
  });

  it("an unparseable ref command answers with the reason and the usage text", async () => {
    await setup();
    const payload = await buildRefCommandPayload(slackEnv, deps, refJob("ref bogus thing", NOBODY));
    expect(allText(payload.blocks)).toContain("show|history|restore|new|refresh");
  });

  it("DB_CATEGORY_BY_REF_CATEGORY does not drift from REF_CATEGORY_LABELS", async () => {
    // Two spellings of the same three strings, in two files -- the map is
    // typed against ProductCategory and the labels against the markdown
    // source, so neither can check the other at compile time.
    expect(DB_CATEGORY_BY_REF_CATEGORY).toEqual(REF_CATEGORY_LABELS);
  });

  it("productRefAliasNorms registers the H1 alongside the declared aliases, deduped", async () => {
    const ref = parseProductRefMarkdown({ slug: SLUG, markdown: BODY_V1 });
    expect(productRefAliasNorms(ref).sort()).toEqual([normalizeAlias("test widget"), normalizeAlias("widget alpha")].sort());
  });
});
