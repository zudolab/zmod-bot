import { afterEach, describe, expect, it } from "vitest";
import {
  appendUsageLog,
  claimJobs,
  consumeRefDraft,
  createRefDraft,
  findLatestResolvedThreadJob,
  findProductRefByAlias,
  getProductRefBySlug,
  getProductRefVersion,
  listProductRefAliases,
  listProductRefVersions,
  parseResolvedJobContext,
  recordIncomingEvent,
  recordResolvedContext,
  restoreProductRefVersion,
  updateJobState,
  upsertProductRef,
  type RepoDeps,
} from "../../src/db/repos";
import { createTestEnv, type TestEnvHandle } from "../helpers/test-env";

describe("D1 repositories (Miniflare-backed storage semantics)", () => {
  let env: TestEnvHandle | undefined;
  let clockMs = 1_700_000_000_000;
  let deps: RepoDeps;

  function setClock(ms: number) {
    clockMs = ms;
  }

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
  });

  async function setup() {
    env = await createTestEnv();
    deps = { db: env.db, now: () => new Date(clockMs) };
  }

  it("INSERT ... ON CONFLICT DO NOTHING reports meta.changes === 0 on a duplicate", async () => {
    await setup();

    const first = await deps.db
      .prepare("INSERT INTO slack_event_receipts (event_id, event_type, received_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING")
      .bind("ev-dup", "app_mention", clockMs)
      .run();
    expect(first.meta.changes).toBe(1);

    const duplicate = await deps.db
      .prepare("INSERT INTO slack_event_receipts (event_id, event_type, received_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING")
      .bind("ev-dup", "app_mention", clockMs)
      .run();
    expect(duplicate.success).toBe(true);
    expect(duplicate.meta.changes).toBe(0);
  });

  describe("product refs", () => {
    it("getProductRefBySlug returns null for an unknown slug", async () => {
      await setup();
      expect(await getProductRefBySlug(deps, "nope")).toBeNull();
    });

    it("upsertProductRef inserts version 1, then increments on a second call", async () => {
      await setup();

      const v1 = await upsertProductRef(deps, {
        slug: "2v2",
        category: "general",
        productUrl: "https://takazudomodular.com/products/2v2-intro/",
        bodyMd: "# 2V2\n\n- category: general\n",
        aliases: ["2v2", "two vee two"],
        changedByUserId: "seed",
        source: "seed",
      });
      expect(v1.version).toBe(1);

      setClock(clockMs + 1000);
      const v2 = await upsertProductRef(deps, {
        slug: "2v2",
        category: "general",
        productUrl: "https://takazudomodular.com/products/2v2-intro/",
        bodyMd: "# 2V2 (updated)\n",
        changedByUserId: "U123",
        source: "refreshed",
      });
      expect(v2.version).toBe(2);
      expect(v2.body_md).toBe("# 2V2 (updated)\n");

      const stored = await getProductRefBySlug(deps, "2v2");
      expect(stored?.version).toBe(2);

      const versions = await listProductRefVersions(deps, "2v2");
      expect(versions.map((row) => [row.version, row.source])).toEqual([
        [2, "refreshed"],
        [1, "seed"],
      ]);

      // aliases omitted on the second call -> left untouched
      expect(await listProductRefAliases(deps, "2v2")).toEqual(["2v2", "two vee two"].sort());
    });

    it("aliases resolve to the owning ref and are fully replaced when a new set is passed", async () => {
      await setup();
      await upsertProductRef(deps, {
        slug: "oxi-one",
        category: "general",
        productUrl: "https://takazudomodular.com/products/oxi-one-intro/",
        bodyMd: "# OXI ONE\n",
        aliases: ["oxi one", "oxione"],
        changedByUserId: "seed",
        source: "seed",
      });

      expect((await findProductRefByAlias(deps, "oxione"))?.slug).toBe("oxi-one");

      await upsertProductRef(deps, {
        slug: "oxi-one",
        category: "general",
        productUrl: "https://takazudomodular.com/products/oxi-one-intro/",
        bodyMd: "# OXI ONE\n",
        aliases: ["oxi one mk1"],
        changedByUserId: "U1",
        source: "refreshed",
      });

      expect(await findProductRefByAlias(deps, "oxione")).toBeNull();
      expect((await findProductRefByAlias(deps, "oxi one mk1"))?.slug).toBe("oxi-one");
    });

    it("restoreProductRefVersion reverts body/category as a new version, without touching aliases", async () => {
      await setup();
      await upsertProductRef(deps, {
        slug: "wingie2",
        category: "small",
        productUrl: null,
        bodyMd: "# Wingie 2 v1\n",
        aliases: ["wingie"],
        changedByUserId: "seed",
        source: "seed",
      });
      await upsertProductRef(deps, {
        slug: "wingie2",
        category: "small",
        productUrl: null,
        bodyMd: "# Wingie 2 v2 (broken)\n",
        changedByUserId: "U1",
        source: "refreshed",
      });

      const restored = await restoreProductRefVersion(deps, "wingie2", 1, "U2");
      expect(restored.version).toBe(3);
      expect(restored.body_md).toBe("# Wingie 2 v1\n");
      expect(restored.updated_by).toBe("U2");

      const v3 = await getProductRefVersion(deps, "wingie2", 3);
      expect(v3?.source).toBe("restored");
      expect(await listProductRefAliases(deps, "wingie2")).toEqual(["wingie"]);
    });

    it("restoreProductRefVersion throws for a version that was never recorded", async () => {
      await setup();
      await expect(restoreProductRefVersion(deps, "unknown-slug", 1, "U1")).rejects.toThrow();
    });
  });

  describe("ref_drafts", () => {
    it("createRefDraft then consumeRefDraft succeeds once and returns null on a second attempt", async () => {
      await setup();
      const draft = await createRefDraft(deps, {
        slug: "new-product",
        category: "general",
        productUrl: null,
        bodyMd: "# New Product\n",
        baseVersion: null,
        createdByUserId: "U1",
        expiresAt: clockMs + 60_000,
      });
      expect(draft.consumed_at).toBeNull();

      const consumed = await consumeRefDraft(deps, draft.id);
      expect(consumed?.consumed_at).toBe(clockMs);

      const second = await consumeRefDraft(deps, draft.id);
      expect(second).toBeNull();
    });

    it("consumeRefDraft returns null for an expired draft and does not consume it", async () => {
      await setup();
      const draft = await createRefDraft(deps, {
        slug: "new-product",
        category: "general",
        productUrl: null,
        bodyMd: "# New Product\n",
        baseVersion: null,
        createdByUserId: "U1",
        expiresAt: clockMs + 1000,
      });

      setClock(clockMs + 2000);
      expect(await consumeRefDraft(deps, draft.id)).toBeNull();
    });

    it("consumeRefDraft returns null for an unknown id", async () => {
      await setup();
      expect(await consumeRefDraft(deps, "does-not-exist")).toBeNull();
    });

    it("createRefDraft round-trips originJobId, including the null case", async () => {
      await setup();

      const withoutOriginJob = await createRefDraft(deps, {
        slug: "new-product",
        category: "general",
        productUrl: null,
        bodyMd: "# New Product\n",
        baseVersion: null,
        createdByUserId: "U1",
        expiresAt: clockMs + 60_000,
      });
      expect(withoutOriginJob.origin_job_id).toBeNull();
      const storedWithout = await deps.db
        .prepare("SELECT origin_job_id FROM ref_drafts WHERE id = ?")
        .bind(withoutOriginJob.id)
        .first<{ origin_job_id: number | null }>();
      expect(storedWithout?.origin_job_id).toBeNull();

      const job = await recordIncomingEvent(deps, {
        eventId: "ev-origin",
        eventType: "app_mention",
        kind: "reply",
        channelId: "C1",
        threadTs: "t-origin",
        actorUserId: "U1",
        rawText: "2v2",
      });

      const withOriginJob = await createRefDraft(deps, {
        slug: "another-product",
        category: "general",
        productUrl: null,
        bodyMd: "# Another Product\n",
        baseVersion: null,
        createdByUserId: "U1",
        expiresAt: clockMs + 60_000,
        originJobId: job!.id,
      });
      expect(withOriginJob.origin_job_id).toBe(job!.id);
      const storedWith = await deps.db
        .prepare("SELECT origin_job_id FROM ref_drafts WHERE id = ?")
        .bind(withOriginJob.id)
        .first<{ origin_job_id: number | null }>();
      expect(storedWith?.origin_job_id).toBe(job!.id);
    });
  });

  describe("durable intake + jobs", () => {
    it("recordIncomingEvent writes the receipt and the job atomically, and de-dups a replayed event", async () => {
      await setup();

      const job = await recordIncomingEvent(deps, {
        eventId: "ev-1",
        eventType: "app_mention",
        kind: "reply",
        channelId: "C1",
        threadTs: "1700000000.000100",
        actorUserId: "U1",
        rawText: "<@BOT> 2v2",
      });
      expect(job).not.toBeNull();
      expect(job?.state).toBe("pending");
      expect(job?.event_id).toBe("ev-1");

      const replay = await recordIncomingEvent(deps, {
        eventId: "ev-1",
        eventType: "app_mention",
        kind: "reply",
        channelId: "C1",
        threadTs: "1700000000.000100",
        actorUserId: "U1",
        rawText: "<@BOT> 2v2",
      });
      expect(replay).toBeNull();

      const jobs = await deps.db.prepare("SELECT * FROM jobs WHERE event_id = ?").bind("ev-1").all();
      expect(jobs.results).toHaveLength(1);
    });

    it("claimJobs claims up to the limit and excludes jobs with a live claim", async () => {
      await setup();
      await recordIncomingEvent(deps, {
        eventId: "ev-a",
        eventType: "app_mention",
        kind: "reply",
        channelId: "C1",
        threadTs: "t1",
        actorUserId: "U1",
        rawText: "a",
      });
      await recordIncomingEvent(deps, {
        eventId: "ev-b",
        eventType: "app_mention",
        kind: "reply",
        channelId: "C1",
        threadTs: "t2",
        actorUserId: "U1",
        rawText: "b",
      });

      const firstClaim = await claimJobs(deps, { states: ["pending"], limit: 1, claimToken: "tok-1", claimTtlMs: 60_000 });
      expect(firstClaim).toHaveLength(1);

      const secondClaim = await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok-2", claimTtlMs: 60_000 });
      expect(secondClaim).toHaveLength(1);
      expect(secondClaim[0]?.event_id).not.toBe(firstClaim[0]?.event_id);

      // Both jobs are now claimed and unexpired -- nothing left to claim.
      expect(await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok-3", claimTtlMs: 60_000 })).toHaveLength(0);
    });

    it("claimJobs reclaims a job whose previous claim has expired", async () => {
      await setup();
      await recordIncomingEvent(deps, {
        eventId: "ev-c",
        eventType: "app_mention",
        kind: "reply",
        channelId: "C1",
        threadTs: "t3",
        actorUserId: "U1",
        rawText: "c",
      });

      await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok-stale", claimTtlMs: 1000 });
      setClock(clockMs + 5000);

      const reclaimed = await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok-fresh", claimTtlMs: 60_000 });
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.claim_token).toBe("tok-fresh");
    });

    it("updateJobState succeeds only for the claim token that currently holds the job", async () => {
      await setup();
      const job = await recordIncomingEvent(deps, {
        eventId: "ev-d",
        eventType: "app_mention",
        kind: "reply",
        channelId: "C1",
        threadTs: "t4",
        actorUserId: "U1",
        rawText: "d",
      });
      const [claimed] = await claimJobs(deps, { states: ["pending"], limit: 10, claimToken: "tok-owner", claimTtlMs: 60_000 });
      expect(claimed?.id).toBe(job?.id);

      const wrongToken = await updateJobState(deps, {
        id: claimed!.id,
        claimToken: "tok-not-the-owner",
        state: "composing",
      });
      expect(wrongToken).toBe(false);

      const rightToken = await updateJobState(deps, {
        id: claimed!.id,
        claimToken: "tok-owner",
        state: "done",
      });
      expect(rightToken).toBe(true);

      const finalRow = await deps.db.prepare("SELECT state, completed_at FROM jobs WHERE id = ?").bind(claimed!.id).first<{
        state: string;
        completed_at: number | null;
      }>();
      expect(finalRow?.state).toBe("done");
      expect(finalRow?.completed_at).not.toBeNull();
    });

    it("recordResolvedContext round-trips the blob, and overwriting the same job's context is safe", async () => {
      await setup();
      const job = await recordIncomingEvent(deps, {
        eventId: "ev-resolved",
        eventType: "app_mention",
        kind: "reply",
        channelId: "C1",
        threadTs: "t-resolved",
        actorUserId: "U1",
        rawText: "2v2",
      });

      await recordResolvedContext(deps, job!.id, { slug: "2v2", variant: null, arrivalSchedule: "明後日月曜（8/18）到着予定になります。" });
      const first = await deps.db.prepare("SELECT resolved_context FROM jobs WHERE id = ?").bind(job!.id).first<{
        resolved_context: string | null;
      }>();
      expect(parseResolvedJobContext(first?.resolved_context ?? null)).toEqual({
        slug: "2v2",
        variant: null,
        arrivalSchedule: "明後日月曜（8/18）到着予定になります。",
      });

      // Overwriting the same job's context (e.g. a variant clarified after the fact) is a plain UPDATE, not a conflict.
      await recordResolvedContext(deps, job!.id, { slug: "2v2", variant: "kit", arrivalSchedule: null });
      const second = await deps.db.prepare("SELECT resolved_context FROM jobs WHERE id = ?").bind(job!.id).first<{
        resolved_context: string | null;
      }>();
      expect(parseResolvedJobContext(second?.resolved_context ?? null)).toEqual({
        slug: "2v2",
        variant: "kit",
        arrivalSchedule: null,
      });
    });

    describe("parseResolvedJobContext", () => {
      it("returns null for a NULL column", () => {
        expect(parseResolvedJobContext(null)).toBeNull();
      });

      it("returns null for malformed JSON rather than throwing", () => {
        expect(parseResolvedJobContext("{not valid json")).toBeNull();
      });

      it("returns null when the parsed value has no string slug", () => {
        expect(parseResolvedJobContext(JSON.stringify({ variant: "kit" }))).toBeNull();
        expect(parseResolvedJobContext(JSON.stringify({ slug: 42 }))).toBeNull();
        expect(parseResolvedJobContext(JSON.stringify("just a string"))).toBeNull();
      });

      it("coerces a missing/non-string variant or arrivalSchedule to null instead of failing the whole parse", () => {
        expect(parseResolvedJobContext(JSON.stringify({ slug: "2v2" }))).toEqual({
          slug: "2v2",
          variant: null,
          arrivalSchedule: null,
        });
      });
    });

    describe("findLatestResolvedThreadJob", () => {
      it("returns the most recent prior reply job with a non-null resolved_context, ignoring the current job, polish/ref jobs, and unresolved prior jobs", async () => {
        await setup();
        const channelId = "C-thread";
        const threadTs = "t-chain";

        const replyA = await recordIncomingEvent(deps, {
          eventId: "ev-chain-a",
          eventType: "app_mention",
          kind: "reply",
          channelId,
          threadTs,
          actorUserId: "U1",
          rawText: "2v2",
        });
        await recordResolvedContext(deps, replyA!.id, { slug: "2v2", variant: null, arrivalSchedule: null });

        // A polish job never resolves a product -- resolved_context stays NULL, and its kind alone should exclude it anyway.
        setClock(clockMs + 1000);
        await recordIncomingEvent(deps, {
          eventId: "ev-chain-b",
          eventType: "app_mention",
          kind: "polish",
          channelId,
          threadTs,
          actorUserId: "U1",
          rawText: "make it more polite",
        });

        // A reply job that never reached recordResolvedContext -- must be skipped, not treated as the "latest" one.
        setClock(clockMs + 1000);
        await recordIncomingEvent(deps, {
          eventId: "ev-chain-c",
          eventType: "app_mention",
          kind: "reply",
          channelId,
          threadTs,
          actorUserId: "U1",
          rawText: "hmm",
        });

        setClock(clockMs + 1000);
        const replyD = await recordIncomingEvent(deps, {
          eventId: "ev-chain-d",
          eventType: "app_mention",
          kind: "reply",
          channelId,
          threadTs,
          actorUserId: "U1",
          rawText: "wingie2",
        });
        await recordResolvedContext(deps, replyD!.id, { slug: "wingie2", variant: null, arrivalSchedule: null });

        setClock(clockMs + 1000);
        const currentJob = await recordIncomingEvent(deps, {
          eventId: "ev-chain-current",
          eventType: "app_mention",
          kind: "reply",
          channelId,
          threadTs,
          actorUserId: "U1",
          rawText: "same but kit",
        });

        const found = await findLatestResolvedThreadJob(deps, { channelId, threadTs, beforeJobId: currentJob!.id });
        expect(found?.id).toBe(replyD!.id);
        expect(parseResolvedJobContext(found?.resolved_context ?? null)?.slug).toBe("wingie2");
      });

      it("returns null when the thread has no resolved prior reply job", async () => {
        await setup();
        const job = await recordIncomingEvent(deps, {
          eventId: "ev-empty-thread",
          eventType: "app_mention",
          kind: "reply",
          channelId: "C-empty",
          threadTs: "t-empty",
          actorUserId: "U1",
          rawText: "2v2",
        });

        expect(
          await findLatestResolvedThreadJob(deps, {
            channelId: "C-empty",
            threadTs: "t-empty",
            beforeJobId: job!.id,
          }),
        ).toBeNull();
      });

      it("does not cross channel/thread boundaries", async () => {
        await setup();
        const otherThreadJob = await recordIncomingEvent(deps, {
          eventId: "ev-other-thread",
          eventType: "app_mention",
          kind: "reply",
          channelId: "C1",
          threadTs: "t-other",
          actorUserId: "U1",
          rawText: "2v2",
        });
        await recordResolvedContext(deps, otherThreadJob!.id, { slug: "2v2", variant: null, arrivalSchedule: null });

        setClock(clockMs + 1000);
        const thisThreadJob = await recordIncomingEvent(deps, {
          eventId: "ev-this-thread",
          eventType: "app_mention",
          kind: "reply",
          channelId: "C1",
          threadTs: "t-this",
          actorUserId: "U1",
          rawText: "wingie2",
        });

        expect(
          await findLatestResolvedThreadJob(deps, {
            channelId: "C1",
            threadTs: "t-this",
            beforeJobId: thisThreadJob!.id,
          }),
        ).toBeNull();
      });
    });
  });

  describe("usage_log", () => {
    it("appendUsageLog inserts a row", async () => {
      await setup();
      await appendUsageLog(deps, {
        slug: "2v2",
        task: "compose",
        provider: "workers-ai",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        fallback: null,
        tokensIn: 120,
        tokensOut: 80,
      });

      const rows = await deps.db.prepare("SELECT * FROM usage_log").all();
      expect(rows.results).toHaveLength(1);
    });
  });
});
