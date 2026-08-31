import { describe, expect, it } from "vitest";
import { createMockD1 } from "../db/test-support";
import type { JobRow } from "../db/schema";
import type { Env } from "../env";
import type { FetchLike } from "../types";
import { createStashApi } from "../stash/api";
import { createFakeStash } from "../stash/test-support";
import {
  buildPolicyPrBody,
  buildPolicyPrTitle,
  runJob,
  type EnsurePolicyPrFn,
  type GetPolicyFileFn,
  type UpdatePolicyFn,
} from "./worker";

const REQUEST = "@alice と #123 を参照し、<重要> を明記\n二行目";
const PR_URL = "https://github.com/zudolab/zmod-bot/pull/123";

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: createMockD1(),
    AI: {} as Ai,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "secret",
    ANTHROPIC_API_KEY: "anthropic-test",
    GITHUB_TOKEN: "github-test",
    SLACK_BOT_USER_ID: "U_BOT",
    SLACK_ALLOWED_CHANNEL_IDS: "",
    SLACK_ADMIN_USER_IDS: "U_ADMIN",
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    SITE_API_BASE: "https://example.com",
    GITHUB_REPO: "zudolab/zmod-bot",
    ...overrides,
  };
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 39,
    event_id: "Ev-policy",
    kind: "policy_update",
    channel_id: "C_POLICY",
    thread_ts: "100.001",
    actor_user_id: "U_ADMIN",
    raw_text: `<@U_BOT> policy ${REQUEST}`,
    state: "pending",
    attempts: 0,
    claim_token: null,
    claim_expires_at: null,
    last_error: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    resolved_context: null,
    ...overrides,
  };
}

function slackFetch(): { fetch: FetchLike; posts: Record<string, unknown>[] } {
  const posts: Record<string, unknown>[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://slack.com/api/chat.postMessage");
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ok: true, channel: "C_POLICY", ts: "200.001" });
  }) as FetchLike;
  return { fetch, posts };
}

function acceptedDeps() {
  const getPolicyFile: GetPolicyFileFn = async () => ({ text: "old", blobSha: "sha", defaultBranch: "main" });
  const updatePolicy: UpdatePolicyFn = async (_deps, input) => {
    expect(input).toEqual({ currentDocument: "old", request: REQUEST });
    return { kind: "accepted", document: "new", provider: "claude", model: "test" };
  };
  return { getPolicyFile, updatePolicy };
}

describe("policy_update job orchestration", () => {
  it("routes policy history through stash and never invokes the GitHub policy seams", async () => {
    const { fetch, posts } = slackFetch();
    const now = () => new Date("2026-08-31T00:00:00.000Z");
    const fake = createFakeStash({
      now,
      readToken: `zhs_${"r".repeat(43)}`,
      writeToken: `zhs_${"w".repeat(43)}`,
    });
    const stash = createStashApi({
      baseUrl: "https://stash.example",
      stash: "policy",
      readToken: `zhs_${"r".repeat(43)}`,
      writeToken: `zhs_${"w".repeat(43)}`,
      fetch: fake.fetch,
    });
    let githubCalls = 0;

    await runJob(
      env({
        STASH_BASE_URL: "https://stash.example",
        STASH_NAME: "policy",
        STASH_READ_TOKEN: `zhs_${"r".repeat(43)}`,
        STASH_WRITE_TOKEN: `zhs_${"w".repeat(43)}`,
      }),
      job({ raw_text: "<@U_BOT> policy history" }),
      {
        fetch,
        now,
        stashApi: stash,
        getPolicyFile: async () => {
          githubCalls += 1;
          throw new Error("GitHub must not be called");
        },
      },
    );

    expect(githubCalls).toBe(0);
    expect(fake.calls.some(({ url }) => url.includes("/history/policy/reply-guidance.md"))).toBe(true);
    expect(JSON.stringify(posts[0])).toContain("ポリシー履歴");
    expect(JSON.stringify(posts[0])).toContain("v1");
    expect(JSON.stringify(posts[0])).not.toContain("Seeded reply guidance");
  });

  it("refuses stash-only rollback when write routing is absent instead of using GitHub", async () => {
    const { fetch, posts } = slackFetch();
    let githubCalls = 0;

    await runJob(env(), job({ raw_text: "<@U_BOT> policy rollback 1" }), {
      fetch,
      now: () => new Date(1),
      getPolicyFile: async () => {
        githubCalls += 1;
        throw new Error("GitHub must not be called");
      },
    });

    expect(githubCalls).toBe(0);
    expect(JSON.stringify(posts[0])).toContain("Stashの設定が不足");
  });

  it("routes rollback without the removed history-head recovery heuristic", async () => {
    const { fetch } = slackFetch();
    const now = () => new Date("2026-08-31T00:00:00.000Z");
    const readToken = `zhs_${"r".repeat(43)}`;
    const writeToken = `zhs_${"w".repeat(43)}`;
    const fake = createFakeStash({ now, readToken, writeToken });
    const stash = createStashApi({ baseUrl: "https://stash.example", stash: "policy", readToken, writeToken, fetch: fake.fetch });
    const db = createMockD1({
      onQuery: ({ query, bindings }) => query.includes("INSERT INTO policy_rollback_attempts")
        ? { results: [{
            job_id: bindings[0],
            path: bindings[1],
            target_version: bindings[2],
            expected_version: bindings[3],
            created_at: bindings[4],
            updated_at: bindings[5],
          }], meta: { changes: 1 } }
        : undefined,
    });

    await runJob(
      env({ DB: db, STASH_BASE_URL: "https://stash.example", STASH_NAME: "policy", STASH_READ_TOKEN: readToken, STASH_WRITE_TOKEN: writeToken }),
      job({ raw_text: "<@U_BOT> policy rollback 1" }),
      { fetch, now, stashApi: stash },
    );

    expect(fake.calls.some(({ url }) => url.includes("/history/policy/reply-guidance.md"))).toBe(false);
    expect(fake.calls.filter(({ url }) => url.includes("/rollback/policy/reply-guidance.md"))).toHaveLength(1);
  });

  it("calls each policy seam once and posts one escaped in-thread PR reply", async () => {
    const { fetch, posts } = slackFetch();
    const { getPolicyFile, updatePolicy } = acceptedDeps();
    const ensureInputs: Parameters<EnsurePolicyPrFn>[1][] = [];
    const ensurePolicyPr: EnsurePolicyPrFn = async (_deps, input) => {
      ensureInputs.push(input);
      return { kind: "created", url: PR_URL, number: 123 };
    };

    await runJob(env(), job(), {
      fetch,
      now: () => new Date(1),
      getPolicyFile,
      updatePolicy,
      ensurePolicyPr,
    });

    expect(ensureInputs).toHaveLength(1);
    expect(ensureInputs[0]).toMatchObject({ jobId: "39", newContent: "new" });
    expect(ensureInputs[0]?.title.length).toBeLessThanOrEqual(60);
    expect(ensureInputs[0]?.body).not.toContain("@alice");
    expect(ensureInputs[0]?.body).not.toContain("#123");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C_POLICY", thread_ts: "100.001" });
    const rendered = JSON.stringify(posts[0]);
    expect(rendered).toContain(PR_URL);
    expect(rendered).toContain("&lt;重要&gt;");
    expect(rendered).not.toContain("\n二行目");
  });

  it("a retry converges on the same PR URL and does not create a second PR", async () => {
    const { fetch, posts } = slackFetch();
    const { getPolicyFile, updatePolicy } = acceptedDeps();
    let existingUrl: string | undefined;
    let creations = 0;
    const ensurePolicyPr: EnsurePolicyPrFn = async () => {
      if (existingUrl) return { kind: "existing", url: existingUrl, number: 123 };
      creations++;
      existingUrl = PR_URL;
      return { kind: "created", url: existingUrl, number: 123 };
    };
    const deps = { fetch, now: () => new Date(1), getPolicyFile, updatePolicy, ensurePolicyPr };

    await runJob(env(), job(), deps);
    await runJob(env(), job({ state: "failed", attempts: 1 }), deps);

    expect(creations).toBe(1);
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[0])).toContain(PR_URL);
    expect(JSON.stringify(posts[1])).toContain(PR_URL);
  });

  it.each([
    ["no_change", { kind: "no_change", provider: "claude", model: "test" } as const, "変更なしと判断しました"],
    ["rejected", { kind: "rejected", reason: "fixed_clause" } as const, "更新案の検証に失敗しました（fixed_clause）"],
  ])("%s posts the matching reply without calling ensurePolicyPr", async (_name, outcome, expected) => {
    const { fetch, posts } = slackFetch();
    let ensures = 0;
    await runJob(env(), job(), {
      fetch,
      now: () => new Date(1),
      getPolicyFile: async () => ({ text: "old", blobSha: "sha", defaultBranch: "main" }),
      updatePolicy: async () => outcome,
      ensurePolicyPr: async () => {
        ensures++;
        return { kind: "created", url: PR_URL, number: 123 };
      },
    });
    expect(ensures).toBe(0);
    expect(JSON.stringify(posts[0])).toContain(expected);
  });

  it("conflict posts the existing PR and performs no mutation", async () => {
    const { fetch, posts } = slackFetch();
    const { getPolicyFile, updatePolicy } = acceptedDeps();
    let ensureCalls = 0;
    const ensurePolicyPr: EnsurePolicyPrFn = async () => {
      ensureCalls++;
      // The real GitHub client discovers this conflict from its read-only
      // open-PR scan; no branch/content/PR mutation is needed.
      return { kind: "conflict", url: PR_URL };
    };

    await runJob(env(), job(), { fetch, now: () => new Date(1), getPolicyFile, updatePolicy, ensurePolicyPr });

    expect(ensureCalls).toBe(1);
    expect(JSON.stringify(posts[0])).toContain(`既存のポリシーPRがオープン中です: ${PR_URL}`);
  });

  it("defense-in-depth refuses a non-admin row before policy or GitHub calls", async () => {
    const { fetch, posts } = slackFetch();
    let calls = 0;
    await runJob(env(), job({ actor_user_id: "U_OTHER" }), {
      fetch,
      now: () => new Date(1),
      getPolicyFile: async () => {
        calls++;
        return { text: "old", blobSha: "sha", defaultBranch: "main" };
      },
    });
    expect(calls).toBe(0);
    expect(JSON.stringify(posts[0])).toContain("管理者権限");
  });
});

describe("policy PR metadata hygiene", () => {
  it("bounds the title to 60 code points and removes line breaks", () => {
    const title = buildPolicyPrTitle(`  ${"あ".repeat(80)}\nsecond  `);
    expect(Array.from(title)).toHaveLength(60);
    expect(title.startsWith("[policy] ")).toBe(true);
    expect(title).not.toContain("\n");
  });

  it("quotes the request, neutralizes @/#, identifies the requester, and includes the production-copy warning", () => {
    const body = buildPolicyPrBody("@alice please see #123\nnext", "U_ADMIN");
    expect(body).toContain("> @\u200dalice please see #\u200d123\n> next");
    expect(body).toContain("`U_ADMIN`");
    expect(body).toContain("this text is injected into the compose system prompt — review as production copy");
  });
});
