import { describe, expect, it } from "vitest";
import type { FetchLike } from "../types";
import {
  ensurePolicyPr,
  getPolicyFile,
  GithubApiError,
  GithubConfigurationError,
  POLICY_FILE_PATH,
} from "./api";

const TOKEN = "github_pat_TEST_TOKEN_123";
const REPO = "zudolab/zmod-bot";
const DEFAULT_BRANCH = "main";
const DEFAULT_SHA = "default-head-sha";
const OLD_CONTENT = "# 返信ポリシー\n\n古い内容です。\n";
const NEW_CONTENT = "# 返信ポリシー\n\n新しい内容です。\n";

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

type FailureStage = "branch" | "contents" | "pr";

class RecordingGithub {
  readonly calls: RecordedCall[] = [];
  readonly branchNames = new Set<string>();
  readonly pulls: Array<{ html_url: string; number: number; head: { ref: string } }> = [];
  branchContent = OLD_CONTENT;
  branchWrites = 0;
  contentWrites = 0;
  prWrites = 0;
  failStage?: FailureStage;
  failureConsumed = false;

  constructor(failStage?: FailureStage) {
    this.failStage = failStage;
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.calls.push({ url, method, headers: new Headers(init?.headers), body });
    const parsed = new URL(url);
    const path = parsed.pathname.replace(`/repos/${REPO}`, "");

    if (path === "" && method === "GET") return response(200, { default_branch: DEFAULT_BRANCH });
    if (path === "/pulls" && method === "GET") return response(200, this.pulls);

    if (path.startsWith("/git/ref/heads/") && method === "GET") {
      const branch = decodeURIComponent(path.slice("/git/ref/heads/".length));
      if (branch === DEFAULT_BRANCH) return response(200, { object: { sha: DEFAULT_SHA } });
      return this.branchNames.has(branch)
        ? response(200, { object: { sha: `head-${branch}` } })
        : response(404, { message: "not found" });
    }

    if (path === "/git/refs" && method === "POST") {
      this.branchWrites++;
      const ref = String(body?.ref);
      const branch = ref.slice("refs/heads/".length);
      this.branchNames.add(branch);
      if (this.consumeFailure("branch")) return response(503, { secret: TOKEN });
      return response(201, { ref });
    }

    if (path === `/contents/${POLICY_FILE_PATH}` && method === "GET") {
      const ref = parsed.searchParams.get("ref");
      const text = ref === DEFAULT_BRANCH ? OLD_CONTENT : this.branchContent;
      return response(200, {
        sha: `blob-${text === OLD_CONTENT ? "old" : "new"}`,
        encoding: "base64",
        content: utf8Base64(text),
      });
    }

    if (path === `/contents/${POLICY_FILE_PATH}` && method === "PUT") {
      this.contentWrites++;
      this.branchContent = decodeUtf8Base64(String(body?.content));
      if (this.consumeFailure("contents")) return response(502, { echoed_token: TOKEN });
      return response(200, { content: { sha: "blob-new" } });
    }

    if (path === "/pulls" && method === "POST") {
      this.prWrites++;
      const number = 40 + this.pulls.length;
      const pull = {
        html_url: `https://github.com/${REPO}/pull/${number}`,
        number,
        head: { ref: String(body?.head) },
      };
      this.pulls.push(pull);
      if (this.consumeFailure("pr")) return response(500, { body: "must not escape" });
      return response(201, pull);
    }

    return response(500, { unexpected: `${method} ${path}` });
  }) as FetchLike;

  private consumeFailure(stage: FailureStage): boolean {
    if (this.failStage !== stage || this.failureConsumed) return false;
    this.failureConsumed = true;
    return true;
  }
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function decodeUtf8Base64(text: string): string {
  return decodeURIComponent(
    Array.from(atob(text), (character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
  );
}

function deps(fake: RecordingGithub) {
  return { token: TOKEN, repo: REPO, fetch: fake.fetch };
}

function input(overrides: Partial<Parameters<typeof ensurePolicyPr>[1]> = {}) {
  return {
    jobId: "job-123",
    newContent: NEW_CONTENT,
    title: "[policy] update guidance",
    body: "Requested from Slack.",
    ...overrides,
  };
}

describe("getPolicyFile", () => {
  it("discovers the default branch and decodes the policy document", async () => {
    const fake = new RecordingGithub();

    await expect(getPolicyFile(deps(fake))).resolves.toEqual({
      text: OLD_CONTENT,
      blobSha: "blob-old",
      defaultBranch: DEFAULT_BRANCH,
    });
    expect(fake.calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/${REPO}`,
      `https://api.github.com/repos/${REPO}/contents/${POLICY_FILE_PATH}?ref=main`,
    ]);
  });
});

describe("ensurePolicyPr", () => {
  it("creates the branch, UTF-8 content commit, and pull request with exact request shapes", async () => {
    const fake = new RecordingGithub();

    await expect(ensurePolicyPr(deps(fake), input())).resolves.toEqual({
      kind: "created",
      url: `https://github.com/${REPO}/pull/40`,
      number: 40,
    });

    const writes = fake.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["POST", `/repos/${REPO}/git/refs`],
      ["PUT", `/repos/${REPO}/contents/${POLICY_FILE_PATH}`],
      ["POST", `/repos/${REPO}/pulls`],
    ]);
    expect(writes[0]?.body).toEqual({ ref: "refs/heads/policy-update/job-job-123", sha: DEFAULT_SHA });
    expect(writes[1]?.body).toMatchObject({ branch: "policy-update/job-job-123", sha: "blob-old" });
    expect(decodeUtf8Base64(String(writes[1]?.body?.content))).toBe(NEW_CONTENT);
    expect(writes[2]?.body).toEqual({
      title: "[policy] update guidance",
      body: "Requested from Slack.",
      head: "policy-update/job-job-123",
      base: DEFAULT_BRANCH,
    });
    for (const call of fake.calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.headers.get("accept")).toBe("application/vnd.github+json");
      expect(call.headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(call.headers.get("user-agent")).toBe("zmod-bot-policy-pr-loop");
    }
  });

  it.each(["branch", "contents", "pr"] as const)(
    "resumes after a response failure following the %s mutation",
    async (stage) => {
      const fake = new RecordingGithub(stage);

      await expect(ensurePolicyPr(deps(fake), input())).rejects.toBeInstanceOf(GithubApiError);
      const outcome = await ensurePolicyPr(deps(fake), input());

      expect(outcome).toMatchObject({
        kind: stage === "pr" ? "existing" : "created",
        url: `https://github.com/${REPO}/pull/40`,
        number: 40,
      });
      expect(fake.branchWrites).toBe(1);
      expect(fake.contentWrites).toBe(1);
      expect(fake.prWrites).toBe(1);
      expect(fake.pulls).toHaveLength(1);
      expect(fake.branchContent).toBe(NEW_CONTENT);
    },
  );

  it("returns the existing PR before touching branch or content state", async () => {
    const fake = new RecordingGithub();
    fake.pulls.push({
      html_url: "https://github.com/zudolab/zmod-bot/pull/77",
      number: 77,
      head: { ref: "policy-update/job-job-123" },
    });

    await expect(ensurePolicyPr(deps(fake), input())).resolves.toEqual({
      kind: "existing",
      url: "https://github.com/zudolab/zmod-bot/pull/77",
      number: 77,
    });
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("returns a single-flight conflict with zero write calls", async () => {
    const fake = new RecordingGithub();
    fake.pulls.push({
      html_url: "https://github.com/zudolab/zmod-bot/pull/71",
      number: 71,
      head: { ref: "policy-update/job-other" },
    });

    await expect(ensurePolicyPr(deps(fake), input())).resolves.toEqual({
      kind: "conflict",
      url: "https://github.com/zudolab/zmod-bot/pull/71",
    });
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("checks every page of open PRs before allowing a write", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const ordinaryPulls = Array.from({ length: 100 }, (_, index) => ({
      html_url: `https://github.com/${REPO}/pull/${index + 1}`,
      number: index + 1,
      head: { ref: `human-branch-${index}` },
    }));
    const fetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const url = String(requestInput);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const parsed = new URL(url);
      if (parsed.pathname === `/repos/${REPO}`) return response(200, { default_branch: DEFAULT_BRANCH });
      if (parsed.pathname === `/repos/${REPO}/pulls` && parsed.searchParams.get("page") === "1") {
        return response(200, ordinaryPulls);
      }
      if (parsed.pathname === `/repos/${REPO}/pulls` && parsed.searchParams.get("page") === "2") {
        return response(200, [
          {
            html_url: `https://github.com/${REPO}/pull/101`,
            number: 101,
            head: { ref: "policy-update/job-other" },
          },
        ]);
      }
      return response(500, { unexpected: url });
    }) as FetchLike;

    await expect(ensurePolicyPr({ token: TOKEN, repo: REPO, fetch }, input())).resolves.toEqual({
      kind: "conflict",
      url: `https://github.com/${REPO}/pull/101`,
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("gives another policy PR conflict precedence even if this job also has an open PR", async () => {
    const fake = new RecordingGithub();
    fake.pulls.push(
      { html_url: "https://github.com/zudolab/zmod-bot/pull/70", number: 70, head: { ref: "policy-update/job-job-123" } },
      { html_url: "https://github.com/zudolab/zmod-bot/pull/71", number: 71, head: { ref: "policy-update/job-other" } },
    );

    await expect(ensurePolicyPr(deps(fake), input())).resolves.toEqual({
      kind: "conflict",
      url: "https://github.com/zudolab/zmod-bot/pull/71",
    });
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects any non-exact policy path before fetch", async () => {
    const fake = new RecordingGithub();
    await expect(ensurePolicyPr(deps(fake), input({ path: "policy/../README.md" }))).rejects.toBeInstanceOf(
      GithubConfigurationError,
    );
    await expect(getPolicyFile(deps(fake), "policy/reply-guidance.md.bak")).rejects.toBeInstanceOf(
      GithubConfigurationError,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("safe failures", () => {
  it.each([
    [{ token: undefined, repo: REPO }, "GITHUB_TOKEN"],
    [{ token: TOKEN, repo: undefined }, "GITHUB_REPO"],
  ])("rejects missing configuration before fetch", async (config, expected) => {
    const fake = new RecordingGithub();
    await expect(ensurePolicyPr({ ...config, fetch: fake.fetch }, input())).rejects.toMatchObject({
      name: "GithubConfigurationError",
      message: expect.stringContaining(expected),
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("exposes only status for a non-2xx and never the response body", async () => {
    const secretBody = "upstream echoed github_pat_DO_NOT_LEAK";
    const fetch = (async () => response(403, { message: secretBody })) as FetchLike;
    let caught: unknown;
    try {
      await getPolicyFile({ token: TOKEN, repo: REPO, fetch });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect(caught).toMatchObject({ status: 403 });
    expect(String((caught as Error).message)).toBe("GitHub API request failed with status 403");
    expect(String(caught)).not.toContain(secretBody);
  });
});
