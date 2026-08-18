/**
 * Central policy PR-loop integration gate (issue #40).
 *
 * This deliberately starts at the signed Slack Events API boundary and uses
 * a real Miniflare D1 database. The LLM, GitHub API, and Slack API are fake
 * boundaries, but the event receipt/job write, policy validator, job claim
 * state machine, and delivery orchestration are the production functions.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getJobById } from "../src/db/repos";
import type { Env } from "../src/env";
import { POLICY_CONTENT } from "../src/policy/generated";
import { handleSlackEventsWithDeps } from "../src/slack/events";
import { runDeliveryPass } from "../src/jobs/worker";
import { composeReply } from "../src/reply/compose";
import type { FetchLike, WaitUntilFn } from "../src/types";
import { createTestEnv, type TestEnvHandle } from "./helpers/test-env";

const SIGNING_SECRET = "policy-e2e-signing-secret";
const BOT_USER_ID = "U_POLICY_BOT";
const ADMIN_USER_ID = "U_POLICY_ADMIN";
const CHANNEL_ID = "C_POLICY_E2E";
const REPO = "zudolab/zmod-bot";
const NOW_MS = 1_760_000_000_000;
const POLICY_REQUEST = "追加ガイダンスに簡潔さを加えて";
const POLICY_EDIT = `${POLICY_CONTENT}必要な場合のみ、簡潔な補足を加えます。\n`;
const POLICY_PR_URL = `https://github.com/${REPO}/pull/401`;

const encoder = new TextEncoder();

async function signature(body: string): Promise<string> {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  return `v0=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function signedEvent(eventId: string, userId = ADMIN_USER_ID): Promise<Request> {
  const body = JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    event: {
      type: "app_mention",
      event_ts: "1760000000.000001",
      channel: CHANNEL_ID,
      user: userId,
      text: `<@${BOT_USER_ID}> policy ${POLICY_REQUEST}`,
      ts: "1760000000.000001",
    },
  });
  return new Request("https://example.com/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Slack-Request-Timestamp": String(Math.floor(NOW_MS / 1000)),
      "X-Slack-Signature": await signature(body),
    },
    body,
  });
}

interface GithubCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

class FakePolicyServices {
  readonly githubCalls: GithubCall[] = [];
  readonly slackPosts: Record<string, unknown>[] = [];
  readonly pulls: Array<{ html_url: string; number: number; head: { ref: string } }> = [];
  readonly branches = new Set<string>();
  readonly aiCalls: Array<{ model: string; inputs: Record<string, unknown> }> = [];
  branchContent: string = POLICY_CONTENT;
  failPullCreateOnce = false;

  ai: Ai = {
    run: async (model: string, inputs: Record<string, unknown>) => {
      this.aiCalls.push({ model, inputs });
      return { response: POLICY_EDIT, usage: { prompt_tokens: 37, completion_tokens: 41 } };
    },
  } as unknown as Ai;

  fetch: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "https://slack.com/api/chat.postMessage") {
      this.slackPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, channel: CHANNEL_ID, ts: "1760000000.000100" });
    }

    const parsed = new URL(url);
    if (parsed.origin !== "https://api.github.com") throw new Error(`unexpected fake fetch URL: ${url}`);
    const path = decodeURIComponent(parsed.pathname).replace(`/repos/${REPO}`, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.githubCalls.push({ path, method, ...(body === undefined ? {} : { body }) });

    if (path === "" && method === "GET") return Response.json({ default_branch: "main" });
    if (path === "/pulls" && method === "GET") return Response.json(this.pulls);

    if (path.startsWith("/git/ref/heads/") && method === "GET") {
      const branch = path.slice("/git/ref/heads/".length);
      if (branch === "main") return Response.json({ object: { sha: "main-sha" } });
      return this.branches.has(branch)
        ? Response.json({ object: { sha: `sha-${branch}` } })
        : Response.json({ message: "not found" }, { status: 404 });
    }

    if (path === "/git/refs" && method === "POST") {
      const branch = String(body?.ref).slice("refs/heads/".length);
      this.branches.add(branch);
      return Response.json({ ref: body?.ref }, { status: 201 });
    }

    if (path === "/contents/policy/reply-guidance.md" && method === "GET") {
      const text = parsed.searchParams.get("ref") === "main" ? POLICY_CONTENT : this.branchContent;
      return Response.json({
        sha: `blob-${text === POLICY_CONTENT ? "current" : "edited"}`,
        encoding: "base64",
        content: encodeUtf8Base64(text),
      });
    }

    if (path === "/contents/policy/reply-guidance.md" && method === "PUT") {
      this.branchContent = decodeUtf8Base64(String(body?.content));
      return Response.json({ content: { sha: "blob-edited" } });
    }

    if (path === "/pulls" && method === "POST") {
      const pull = { html_url: POLICY_PR_URL, number: 401, head: { ref: String(body?.head) } };
      this.pulls.push(pull);
      if (this.failPullCreateOnce) {
        this.failPullCreateOnce = false;
        return Response.json({ message: "response lost after mutation" }, { status: 503 });
      }
      return Response.json(pull, { status: 201 });
    }

    throw new Error(`unexpected fake GitHub call: ${method} ${path}`);
  }) as FetchLike;
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function decodeUtf8Base64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function env(db: D1Database, services: FakePolicyServices): Env {
  return {
    DB: db,
    AI: services.ai,
    SLACK_BOT_TOKEN: "xoxb-policy-e2e",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    ANTHROPIC_API_KEY: "unused-in-workers-ai-e2e",
    GITHUB_TOKEN: "github_pat_policy_e2e",
    SLACK_BOT_USER_ID: BOT_USER_ID,
    SLACK_ALLOWED_CHANNEL_IDS: CHANNEL_ID,
    SLACK_ADMIN_USER_IDS: ADMIN_USER_ID,
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    POLICY_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    POLICY_MODEL: "",
    SITE_API_BASE: "https://example.com",
    GITHUB_REPO: REPO,
  };
}

function waitUntilCollector(): { waitUntil: WaitUntilFn; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  return { scheduled, waitUntil: (promise) => void scheduled.push(promise) };
}

async function submitAndAwait(
  db: D1Database,
  runtime: FakePolicyServices,
  eventId: string,
  userId = ADMIN_USER_ID,
): Promise<{ response: Response; jobId: number; scheduled: Promise<unknown>[] }> {
  const envValue = env(db, runtime);
  const collector = waitUntilCollector();
  const response = await handleSlackEventsWithDeps(await signedEvent(eventId, userId), envValue, {
    db,
    now: () => new Date(NOW_MS),
    fetch: runtime.fetch,
    waitUntil: collector.waitUntil,
    sleep: async () => new Promise<void>(() => undefined),
  });
  const job = await db.prepare("SELECT id FROM jobs WHERE event_id = ?").bind(eventId).first<{ id: number }>();
  if (!job) throw new Error(`event ${eventId} did not create a job`);
  await Promise.all(collector.scheduled);
  return { response, jobId: job.id, scheduled: collector.scheduled };
}

describe("policy PR loop from signed Slack ingress", () => {
  let testEnv: TestEnvHandle | undefined;

  afterEach(async () => {
    await testEnv?.dispose();
    testEnv = undefined;
  });

  it("records durable intent, fetches/validates policy, creates a PR, and posts its link", async () => {
    testEnv = await createTestEnv();
    const services = new FakePolicyServices();
    const { response, jobId } = await submitAndAwait(testEnv.db, services, "Ev-policy-e2e-accepted");

    expect(response.status).toBe(200);
    expect(await testEnv.db.prepare("SELECT COUNT(*) AS n FROM slack_event_receipts").first<{ n: number }>()).toEqual({ n: 1 });
    const job = await getJobById({ db: testEnv.db, now: () => new Date(NOW_MS) }, jobId);
    expect(job?.kind).toBe("policy_update");
    expect(job?.state).toBe("done");
    expect(services.aiCalls).toHaveLength(1);
    expect(JSON.stringify(services.aiCalls[0]?.inputs.messages)).toContain(POLICY_REQUEST);
    expect(services.branchContent).toBe(POLICY_EDIT);
    expect(services.pulls).toHaveLength(1);
    expect(services.githubCalls.filter((call) => call.method !== "GET").map((call) => call.method)).toEqual([
      "POST",
      "PUT",
      "POST",
    ]);
    expect(services.slackPosts).toHaveLength(1);
    expect(JSON.stringify(services.slackPosts[0])).toContain(POLICY_PR_URL);
  });

  it("injects the generated policy document into a compose system prompt", async () => {
    testEnv = await createTestEnv();
    const services = new FakePolicyServices();
    const promptInputs: Record<string, unknown>[] = [];
    services.ai = {
      run: async (_model: string, inputs: Record<string, unknown>) => {
        promptInputs.push(inputs);
        return {
          response: "Guide: https://example.com/guide",
          usage: { prompt_tokens: 19, completion_tokens: 23 },
        };
      },
    } as unknown as Ai;

    const result = await composeReply(
      { env: env(testEnv.db, services), fetch: services.fetch, now: () => new Date(NOW_MS) },
      {
        ref: {
          slug: "policy-prompt-ref",
          displayName: "Policy Prompt Ref",
          category: "small",
          aliases: [],
          sections: [
            {
              heading: "Guide",
              gate: "always",
              resources: [{ title: "Guide", url: "https://example.com/guide" }],
              literalBlocks: [],
            },
          ],
        },
        arrivalSchedule: null,
        discord: false,
        direct: false,
      },
    );

    expect(result.usedFallback).toBe(false);
    const messages = promptInputs[0]?.messages as Array<{ role: string; content: string }> | undefined;
    expect(messages?.find((message) => message.role === "system")?.content).toContain(POLICY_CONTENT);
  });

  it("converges after a response loss during PR creation and reposts the same link", async () => {
    testEnv = await createTestEnv();
    const services = new FakePolicyServices();
    services.failPullCreateOnce = true;
    const first = await submitAndAwait(testEnv.db, services, "Ev-policy-e2e-retry");
    const firstJob = await getJobById({ db: testEnv.db, now: () => new Date(NOW_MS) }, first.jobId);
    expect(firstJob?.state).toBe("failed");
    expect(firstJob?.attempts).toBe(1);

    const retryNow = NOW_MS + 3 * 60 * 1_000;
    const retry = await runDeliveryPass({
      env: env(testEnv.db, services),
      fetch: services.fetch,
      now: () => new Date(retryNow),
    });
    const retriedJob = await getJobById({ db: testEnv.db, now: () => new Date(NOW_MS) }, first.jobId);
    expect(retry).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(retriedJob?.state).toBe("done");
    expect(services.pulls).toHaveLength(1);
    expect(services.githubCalls.filter((call) => call.method === "POST" && call.path === "/pulls")).toHaveLength(1);
    // The first attempt fails before it can post; the retry discovers the
    // already-created PR and posts its link exactly once.
    expect(services.slackPosts).toHaveLength(1);
    expect(JSON.stringify(services.slackPosts[0])).toContain(POLICY_PR_URL);
  });

  it("posts a validation refusal for a code-fence edit without any GitHub write", async () => {
    testEnv = await createTestEnv();
    const services = new FakePolicyServices();
    services.ai = {
      run: async () => ({ response: `${POLICY_CONTENT}\n\`\`\`\n禁止\n\`\`\`\n`, usage: { prompt_tokens: 13, completion_tokens: 17 } }),
    } as unknown as Ai;
    const { response } = await submitAndAwait(testEnv.db, services, "Ev-policy-e2e-rejected");

    expect(response.status).toBe(200);
    expect(services.githubCalls.filter((call) => call.method !== "GET")).toHaveLength(0);
    expect(services.pulls).toHaveLength(0);
    expect(services.slackPosts).toHaveLength(1);
    expect(JSON.stringify(services.slackPosts[0])).toContain("code_fence");
  });
});
