/**
 * The `ref_approve` / `ref_reject` click, end to end through
 * POST /slack/interactions against real D1 (issue #15).
 *
 * Kept out of src/slack/interactions.test.ts on purpose: the paths under
 * test here are the ones that fail *silently* — a stale approval that
 * clobbers a concurrent edit, and a race lost between the handler's
 * checks and its write. Both look like success from Slack's side, so
 * every assertion below checks D1 as well as what was posted.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createRefDraft,
  getProductRefBySlug,
  getRefDraft,
  listProductRefVersions,
  upsertProductRef,
  type RepoDeps,
} from "../db/repos";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import type { Env } from "../env";
import type { FetchLike, WaitUntilFn } from "../types";
import { ACTION_IDS, encodeButtonValue } from "./commands";
import { handleSlackInteractionsWithDeps } from "./interactions";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U0BOT1";
const ADMIN = "U_ADMIN";
const NOBODY = "U_NOT_ADMIN";
const NOW_SECONDS = 1_760_000_000;
const NOW_MS = NOW_SECONDS * 1_000;

const SLUG = "test-widget";
const BODY_V1 = ["# Test Widget", "", "- category: general", "- aliases: test widget", "", "## Notes", "", "v1", ""].join("\n");
const BODY_V2 = ["# Test Widget", "", "- category: general", "- aliases: test widget", "", "## Notes", "", "v2", ""].join("\n");
const BODY_UNPARSEABLE = ["# Test Widget", "", "- category: general", "", "## Notes", "", "Intro text:", ""].join("\n");

const encoder = new TextEncoder();

async function computeSignature(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

async function signedRequest(body: string): Promise<Request> {
  const timestamp = String(NOW_SECONDS);
  return new Request("https://example.com/slack/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": await computeSignature(body, timestamp),
    },
    body,
  });
}

function clickBody(input: { actionId: string; draftId: string; userId: string; actionTs?: string }): string {
  const payload = {
    type: "block_actions",
    user: { id: input.userId },
    container: { channel_id: "C1", message_ts: "200.000" },
    actions: [
      {
        action_id: input.actionId,
        action_ts: input.actionTs ?? "1000.000001",
        value: encodeButtonValue({ v: 1, id: input.draftId }),
      },
    ],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

interface FakeCall {
  url: string;
  body: Record<string, unknown> | null;
}

function createFakeFetch(): { fetch: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    return new Response(JSON.stringify({ ok: true, ts: "999.001" }), { status: 200 });
  }) as FetchLike;
  return { fetch: fetchImpl, calls };
}

function makeWaitUntil(): { waitUntil: WaitUntilFn; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  return { waitUntil: (promise) => void scheduled.push(promise), scheduled };
}

function slackEnv(): Env {
  return {
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_ADMIN_USER_IDS: ADMIN,
  } as Env;
}

/**
 * Wraps a D1 binding so `interfere()` runs once, immediately before the
 * first `batch()` reaches the database. That is precisely the window
 * commitRefDraft's per-statement fences exist for: every check
 * approveRefDraft made has already passed, and the world changes before
 * the write lands. Nothing else about the binding is altered.
 */
function withInterferenceBeforeFirstBatch(db: D1Database, interfere: () => Promise<void>): D1Database {
  let fired = false;
  return {
    prepare: (query: string) => db.prepare(query),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!fired) {
        fired = true;
        await interfere();
      }
      return db.batch(statements);
    },
    exec: (query: string) => db.exec(query),
    dump: () => db.dump(),
    withSession: (constraint?: string) => db.withSession(constraint),
  } as unknown as D1Database;
}

describe("ref_approve / ref_reject clicks", () => {
  let env: TestEnvHandle | undefined;
  let deps: RepoDeps;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    deps = { db: env.db, now: () => new Date(NOW_MS) };
    await upsertProductRef(deps, {
      slug: SLUG,
      category: "general",
      productUrl: null,
      bodyMd: BODY_V1,
      aliases: ["testwidget"],
      changedByUserId: "seed",
      source: "seed",
    });
  }

  function draft(input: { bodyMd?: string; baseVersion?: number | null; expiresAt?: number } = {}) {
    return createRefDraft(deps, {
      slug: SLUG,
      category: "general",
      productUrl: null,
      bodyMd: input.bodyMd ?? BODY_V2,
      baseVersion: input.baseVersion === undefined ? 1 : input.baseVersion,
      createdByUserId: ADMIN,
      expiresAt: input.expiresAt ?? NOW_MS + 1_800_000,
    });
  }

  async function click(input: { actionId: string; draftId: string; userId: string; actionTs?: string; db?: D1Database }) {
    const { fetch, calls } = createFakeFetch();
    const { waitUntil, scheduled } = makeWaitUntil();
    const request = await signedRequest(clickBody(input));
    const response = await handleSlackInteractionsWithDeps(request, slackEnv(), {
      db: input.db ?? env!.db,
      now: () => new Date(NOW_MS),
      fetch,
      waitUntil,
    });
    await Promise.all(scheduled);
    return {
      status: response.status,
      ephemeral: calls.filter((call) => call.url.endsWith("/chat.postEphemeral")),
      updates: calls.filter((call) => call.url.endsWith("/chat.update")),
    };
  }

  it("an admin approving a current draft commits it and replaces the preview message", async () => {
    await setup();
    const pending = await draft();

    const result = await click({ actionId: ACTION_IDS.refApprove, draftId: pending.id, userId: ADMIN });
    expect(result.status).toBe(200);
    expect(result.ephemeral).toHaveLength(0);
    expect(JSON.stringify(result.updates)).toContain("v2");

    const current = await getProductRefBySlug(deps, SLUG);
    expect(current?.version).toBe(2);
    expect(current?.body_md).toBe(BODY_V2);
    expect((await getRefDraft(deps, pending.id))?.consumed_at).toBe(NOW_MS);
  });

  it("a stale base_version is refused with both version numbers named, and nothing is written", async () => {
    await setup();
    const stale = await draft({ baseVersion: 1 });

    // A concurrent edit lands v2 while the preview sits in the channel.
    await upsertProductRef(deps, {
      slug: SLUG,
      category: "general",
      productUrl: null,
      bodyMd: BODY_V1.replace("v1", "concurrent"),
      changedByUserId: "U_OTHER",
      source: "refreshed",
    });

    const result = await click({ actionId: ACTION_IDS.refApprove, draftId: stale.id, userId: ADMIN });

    const text = JSON.stringify(result.ephemeral);
    expect(result.ephemeral).toHaveLength(1);
    expect(text).toContain("v1");
    expect(text).toContain("v2");
    // The preview message is left alone -- the operator re-runs the command.
    expect(result.updates).toHaveLength(0);

    const current = await getProductRefBySlug(deps, SLUG);
    expect(current?.version).toBe(2);
    expect(current?.body_md).toContain("concurrent"); // the concurrent edit survived
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(2);
    expect((await getRefDraft(deps, stale.id))?.consumed_at).toBeNull();
  });

  it("a race lost between the checks and the batch commits nothing at all", async () => {
    await setup();
    const pending = await draft({ baseVersion: 1 });

    // Every check approveRefDraft makes passes; the world then moves
    // underneath it, in the one window a per-statement fence is for.
    const interfering = withInterferenceBeforeFirstBatch(env!.db, async () => {
      await upsertProductRef(deps, {
        slug: SLUG,
        category: "general",
        productUrl: null,
        bodyMd: BODY_V1.replace("v1", "won the race"),
        changedByUserId: "U_OTHER",
        source: "refreshed",
      });
    });

    const result = await click({
      actionId: ACTION_IDS.refApprove,
      draftId: pending.id,
      userId: ADMIN,
      db: interfering,
    });

    expect(result.ephemeral).toHaveLength(1);
    expect(JSON.stringify(result.ephemeral)).toContain("もう一度");
    expect(result.updates).toHaveLength(0);

    const current = await getProductRefBySlug(deps, SLUG);
    expect(current?.version).toBe(2);
    expect(current?.body_md).toContain("won the race");
    // No third version row, and the draft is still approvable once re-run.
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(2);
    expect((await getRefDraft(deps, pending.id))?.consumed_at).toBeNull();
  });

  it("an expired draft is refused and nothing is written", async () => {
    await setup();
    const expired = await draft({ expiresAt: NOW_MS - 1 });

    const result = await click({ actionId: ACTION_IDS.refApprove, draftId: expired.id, userId: ADMIN });

    expect(result.ephemeral).toHaveLength(1);
    expect(JSON.stringify(result.ephemeral)).toContain("期限切れ");
    expect((await getProductRefBySlug(deps, SLUG))?.version).toBe(1);
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(1);
  });

  it("an unparseable body is refused before any write, and the draft stays approvable", async () => {
    await setup();
    const bad = await draft({ bodyMd: BODY_UNPARSEABLE });

    const result = await click({ actionId: ACTION_IDS.refApprove, draftId: bad.id, userId: ADMIN });

    expect(result.ephemeral).toHaveLength(1);
    expect(JSON.stringify(result.ephemeral)).toContain("Intro text");
    expect((await getProductRefBySlug(deps, SLUG))?.body_md).toBe(BODY_V1);
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(1);
    expect((await getRefDraft(deps, bad.id))?.consumed_at).toBeNull();
  });

  it("rejecting consumes the draft, replaces the preview and writes nothing", async () => {
    await setup();
    const pending = await draft();

    const result = await click({ actionId: ACTION_IDS.refReject, draftId: pending.id, userId: ADMIN });

    expect(result.updates).toHaveLength(1);
    expect(JSON.stringify(result.updates)).toContain("キャンセル");
    expect((await getRefDraft(deps, pending.id))?.consumed_at).toBe(NOW_MS);
    expect((await getProductRefBySlug(deps, SLUG))?.version).toBe(1);
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(1);
  });

  it("a non-admin cannot reject either, and the draft stays pending", async () => {
    await setup();
    const pending = await draft();

    const result = await click({ actionId: ACTION_IDS.refReject, draftId: pending.id, userId: NOBODY });

    expect(result.ephemeral).toHaveLength(1);
    expect(JSON.stringify(result.ephemeral)).toContain("管理者権限");
    expect(result.updates).toHaveLength(0);
    expect((await getRefDraft(deps, pending.id))?.consumed_at).toBeNull();
  });

  it("a second approval click on a committed draft is refused rather than bumping the version again", async () => {
    await setup();
    const pending = await draft();

    await click({ actionId: ACTION_IDS.refApprove, draftId: pending.id, userId: ADMIN });
    // A DISTINCT action_ts, so this is a genuine second click reaching the
    // handler -- not a Slack retry the receipt table swallows before it.
    const second = await click({
      actionId: ACTION_IDS.refApprove,
      draftId: pending.id,
      userId: ADMIN,
      actionTs: "1000.000002",
    });

    expect(second.ephemeral).toHaveLength(1);
    expect(JSON.stringify(second.ephemeral)).toContain("処理済み");
    expect(second.updates).toHaveLength(0);
    expect((await getProductRefBySlug(deps, SLUG))?.version).toBe(2);
    expect(await listProductRefVersions(deps, SLUG)).toHaveLength(2);
  });

  it("the same click delivered twice (identical action_ts) never reaches the handler a second time", async () => {
    await setup();
    const pending = await draft();

    const first = await click({ actionId: ACTION_IDS.refApprove, draftId: pending.id, userId: ADMIN });
    const retry = await click({ actionId: ACTION_IDS.refApprove, draftId: pending.id, userId: ADMIN });

    expect(first.updates).toHaveLength(1);
    expect(retry.updates).toHaveLength(0);
    expect(retry.ephemeral).toHaveLength(0);
    expect((await getProductRefBySlug(deps, SLUG))?.version).toBe(2);
  });
});
