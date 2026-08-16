/**
 * commitRefDraft — the single `db.batch()` every approved reference edit
 * goes through (issue #15).
 *
 * Storage-semantics territory by definition, so this runs against the
 * Miniflare-backed real D1 (see src/db/test-support.ts's two-tier
 * rationale): the assertions ARE `meta.changes === 0` on a fenced
 * conditional write and D1's rollback of a batch whose later statement
 * violates a constraint. A hand-rolled shim reproducing those by hand
 * could agree with itself while production silently half-applied an
 * edit — which, for a store with no `git revert`, is unrecoverable.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  commitRefDraft,
  createRefDraft,
  getProductRefBySlug,
  getRefDraft,
  listProductRefAliases,
  listProductRefVersions,
  upsertProductRef,
  type RepoDeps,
} from "../../src/db/repos";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

const NOW_MS = 1_760_000_000_000;
const ADMIN = "U_ADMIN";

describe("commitRefDraft", () => {
  let env: TestEnvHandle | undefined;
  let deps: RepoDeps;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    deps = { db: env.db, now: () => new Date(NOW_MS) };
  }

  async function seedRef(slug: string, aliases: string[], bodyMd = `body of ${slug}`) {
    await upsertProductRef(deps, {
      slug,
      category: "general",
      productUrl: null,
      bodyMd,
      aliases,
      changedByUserId: "seed",
      source: "seed",
    });
  }

  function makeDraft(slug: string, baseVersion: number | null, expiresAt = NOW_MS + 60_000) {
    return createRefDraft(deps, {
      slug,
      category: "general",
      productUrl: null,
      bodyMd: `new body of ${slug}`,
      baseVersion,
      createdByUserId: ADMIN,
      expiresAt,
    });
  }

  it("lands the bump, the version row, the replaced aliases and consumed_at together", async () => {
    await setup();
    await seedRef("widget", ["widget", "oldalias"]);
    const draft = await makeDraft("widget", 1);

    const result = await commitRefDraft(deps, {
      draftId: draft.id,
      slug: "widget",
      expectedVersion: 1,
      category: "small",
      productUrl: "https://takazudomodular.com/products/widget/",
      bodyMd: "new body of widget",
      aliases: ["widget", "newalias"],
      actorUserId: ADMIN,
      source: "refreshed",
    });

    expect(result).toEqual({ committed: true, version: 2 });

    const current = await getProductRefBySlug(deps, "widget");
    expect(current).toMatchObject({
      version: 2,
      category: "small",
      body_md: "new body of widget",
      updated_by: ADMIN,
      updated_at: NOW_MS,
    });
    expect(await listProductRefVersions(deps, "widget")).toMatchObject([{ version: 2, source: "refreshed" }, { version: 1 }]);
    expect(await listProductRefAliases(deps, "widget")).toEqual(["newalias", "widget"]); // replaced, not merged
    expect((await getRefDraft(deps, draft.id))?.consumed_at).toBe(NOW_MS);
  });

  it("creates a brand-new reference at v1 when expectedVersion is null", async () => {
    await setup();
    const draft = await makeDraft("fresh", null);

    const result = await commitRefDraft(deps, {
      draftId: draft.id,
      slug: "fresh",
      expectedVersion: null,
      category: "general",
      productUrl: null,
      bodyMd: "new body of fresh",
      aliases: ["fresh"],
      actorUserId: ADMIN,
      source: "authored",
    });

    expect(result).toEqual({ committed: true, version: 1 });
    expect((await getProductRefBySlug(deps, "fresh"))?.version).toBe(1);
    expect(await listProductRefVersions(deps, "fresh")).toHaveLength(1);
  });

  /* ---------------------------------------------------------------------
   * Lost races. `committed: false` is not an error — but it MUST also mean
   * that not one of the four statements landed, which is the part a naive
   * "conditional first statement, unconditional rest" batch gets wrong.
   * ------------------------------------------------------------------ */

  it("writes nothing when the reference has moved off expectedVersion", async () => {
    await setup();
    await seedRef("widget", ["widget", "oldalias"]);
    const draft = await makeDraft("widget", 1);

    // A concurrent edit lands v2 first.
    await upsertProductRef(deps, {
      slug: "widget",
      category: "general",
      productUrl: null,
      bodyMd: "concurrent body",
      changedByUserId: "U_OTHER",
      source: "refreshed",
    });

    const result = await commitRefDraft(deps, {
      draftId: draft.id,
      slug: "widget",
      expectedVersion: 1,
      category: "general",
      productUrl: null,
      bodyMd: "new body of widget",
      aliases: ["widget", "newalias"],
      actorUserId: ADMIN,
      source: "refreshed",
    });

    expect(result.committed).toBe(false);
    const current = await getProductRefBySlug(deps, "widget");
    expect(current?.version).toBe(2);
    expect(current?.body_md).toBe("concurrent body"); // the concurrent edit survived intact
    expect(await listProductRefVersions(deps, "widget")).toHaveLength(2); // no orphaned v2 duplicate
    expect(await listProductRefAliases(deps, "widget")).toEqual(["oldalias", "widget"]); // aliases untouched
    expect((await getRefDraft(deps, draft.id))?.consumed_at).toBeNull();
  });

  it("writes nothing when the draft was already consumed", async () => {
    await setup();
    await seedRef("widget", ["widget"]);
    const draft = await makeDraft("widget", 1);
    await env!.db.prepare("UPDATE ref_drafts SET consumed_at = ? WHERE id = ?").bind(NOW_MS - 1, draft.id).run();

    const result = await commitRefDraft(deps, {
      draftId: draft.id,
      slug: "widget",
      expectedVersion: 1,
      category: "general",
      productUrl: null,
      bodyMd: "new body of widget",
      aliases: ["widget"],
      actorUserId: ADMIN,
      source: "refreshed",
    });

    expect(result.committed).toBe(false);
    expect((await getProductRefBySlug(deps, "widget"))?.version).toBe(1);
    expect(await listProductRefVersions(deps, "widget")).toHaveLength(1);
  });

  it("writes nothing when the draft has expired", async () => {
    await setup();
    await seedRef("widget", ["widget"]);
    const draft = await makeDraft("widget", 1, NOW_MS - 1);

    const result = await commitRefDraft(deps, {
      draftId: draft.id,
      slug: "widget",
      expectedVersion: 1,
      category: "general",
      productUrl: null,
      bodyMd: "new body of widget",
      aliases: ["widget"],
      actorUserId: ADMIN,
      source: "refreshed",
    });

    expect(result.committed).toBe(false);
    expect((await getProductRefBySlug(deps, "widget"))?.body_md).toBe("body of widget");
    expect(await listProductRefVersions(deps, "widget")).toHaveLength(1);
  });

  it("writes nothing when a brand-new slug turns out to already exist", async () => {
    await setup();
    const draft = await makeDraft("widget", null);
    await seedRef("widget", ["widget"]); // someone created it in between

    const result = await commitRefDraft(deps, {
      draftId: draft.id,
      slug: "widget",
      expectedVersion: null,
      category: "small",
      productUrl: null,
      bodyMd: "new body of widget",
      aliases: ["widget", "newalias"],
      actorUserId: ADMIN,
      source: "authored",
    });

    expect(result.committed).toBe(false);
    expect(await getProductRefBySlug(deps, "widget")).toMatchObject({ version: 1, updated_by: "seed", category: "general" });
    expect(await listProductRefAliases(deps, "widget")).toEqual(["widget"]);
    expect((await getRefDraft(deps, draft.id))?.consumed_at).toBeNull();
  });

  /* ---------------------------------------------------------------------
   * Atomicity: a statement failing part-way through must take the whole
   * batch with it.
   * ------------------------------------------------------------------ */

  it("rolls the whole batch back when a later statement fails, leaving no partial version row and no orphaned aliases", async () => {
    await setup();
    await seedRef("widget", ["widget", "keepme"]);
    await seedRef("other", ["other", "ownedbyother"]);
    const draft = await makeDraft("widget", 1);

    // `ownedbyother` belongs to a different product, and
    // product_ref_aliases.alias_norm is a PRIMARY KEY -- the alias INSERT
    // fires AFTER the product_refs bump, the version-row insert and the
    // alias DELETE have already run inside the same transaction.
    await expect(
      commitRefDraft(deps, {
        draftId: draft.id,
        slug: "widget",
        expectedVersion: 1,
        category: "general",
        productUrl: null,
        bodyMd: "new body of widget",
        aliases: ["widget", "ownedbyother"],
        actorUserId: ADMIN,
        source: "refreshed",
      }),
    ).rejects.toThrow();

    const current = await getProductRefBySlug(deps, "widget");
    expect(current?.version).toBe(1);
    expect(current?.body_md).toBe("body of widget");
    expect(await listProductRefVersions(deps, "widget")).toHaveLength(1); // no partial v2 row
    expect(await listProductRefAliases(deps, "widget")).toEqual(["keepme", "widget"]); // the DELETE rolled back too
    expect(await listProductRefAliases(deps, "other")).toEqual(["other", "ownedbyother"]);
    expect((await getRefDraft(deps, draft.id))?.consumed_at).toBeNull();
  });

  it("rolls back a brand-new reference entirely when its alias set collides", async () => {
    await setup();
    await seedRef("other", ["other", "ownedbyother"]);
    const draft = await makeDraft("fresh", null);

    await expect(
      commitRefDraft(deps, {
        draftId: draft.id,
        slug: "fresh",
        expectedVersion: null,
        category: "general",
        productUrl: null,
        bodyMd: "new body of fresh",
        aliases: ["fresh", "ownedbyother"],
        actorUserId: ADMIN,
        source: "authored",
      }),
    ).rejects.toThrow();

    expect(await getProductRefBySlug(deps, "fresh")).toBeNull();
    expect(await listProductRefVersions(deps, "fresh")).toHaveLength(0);
    expect(await listProductRefAliases(deps, "fresh")).toEqual([]);
    expect((await getRefDraft(deps, draft.id))?.consumed_at).toBeNull();
  });

  it("handles an empty alias set without deleting anything else", async () => {
    await setup();
    await seedRef("widget", ["widget"]);
    await seedRef("other", ["other"]);
    const draft = await makeDraft("widget", 1);

    const result = await commitRefDraft(deps, {
      draftId: draft.id,
      slug: "widget",
      expectedVersion: 1,
      category: "general",
      productUrl: null,
      bodyMd: "new body of widget",
      aliases: [],
      actorUserId: ADMIN,
      source: "refreshed",
    });

    expect(result.committed).toBe(true);
    expect(await listProductRefAliases(deps, "widget")).toEqual([]);
    expect(await listProductRefAliases(deps, "other")).toEqual(["other"]);
  });
});
