/**
 * Minimal GitHub REST client for the policy-document PR loop.
 *
 * This is deliberately the only module that writes to GitHub. Every
 * mutation is preceded by a read so an at-least-once job can resume after
 * any completed remote stage without creating another branch, file commit,
 * or pull request.
 */
import type { FetchLike } from "../types";

/** Kept local until the policy contract topic lands; orchestration will unify the import. */
export const POLICY_FILE_PATH = "policy/reply-guidance.md";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "zmod-bot-policy-pr-loop";
const POLICY_BRANCH_PREFIX = "policy-update/";

export interface GithubApiDeps {
  token: string | undefined;
  repo: string | undefined;
  fetch: FetchLike;
}

export interface PolicyFile {
  text: string;
  blobSha: string;
  defaultBranch: string;
}

export interface EnsurePolicyPrInput {
  jobId: string;
  newContent: string;
  title: string;
  body: string;
  /** Testable allowlist boundary. Callers normally omit this exact-path default. */
  path?: string;
}

export type EnsurePolicyPrOutcome =
  | { kind: "created" | "existing"; url: string; number: number }
  | { kind: "conflict"; url: string };

/** Missing or malformed local configuration. Always raised before fetch. */
export class GithubConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubConfigurationError";
  }
}

/** Remote/API failure. The response body is intentionally never retained. */
export class GithubApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub API request failed with status ${status}`);
    this.name = "GithubApiError";
    this.status = status;
  }
}

interface GithubContext {
  baseUrl: string;
  headers: Record<string, string>;
  fetch: FetchLike;
}

interface GithubPull {
  html_url: string;
  number: number;
  head: { ref: string };
}

interface GithubContent {
  sha: string;
  content: string;
  encoding: string;
}

function context(deps: GithubApiDeps): GithubContext {
  if (typeof deps.token !== "string" || deps.token.trim() === "") {
    throw new GithubConfigurationError("GITHUB_TOKEN is not configured");
  }
  if (typeof deps.repo !== "string" || deps.repo.trim() === "") {
    throw new GithubConfigurationError("GITHUB_REPO is not configured");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(deps.repo)) {
    throw new GithubConfigurationError("GITHUB_REPO must use owner/name format");
  }
  return {
    baseUrl: `${GITHUB_API_BASE}/repos/${deps.repo}`,
    fetch: deps.fetch,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${deps.token}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  };
}

function assertPolicyPath(path: string): void {
  if (path !== POLICY_FILE_PATH) {
    throw new GithubConfigurationError(`GitHub writes are restricted to ${POLICY_FILE_PATH}`);
  }
}

function assertJobId(jobId: string): void {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9._-]+$/.test(jobId)) {
    throw new GithubConfigurationError("policy job id is invalid");
  }
}

async function request(
  ctx: GithubContext,
  path: string,
  init?: RequestInit,
  allowedStatuses: readonly number[] = [],
): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.fetch(`${ctx.baseUrl}${path}`, {
      ...init,
      headers: { ...ctx.headers, ...init?.headers },
    });
  } catch {
    throw new GithubApiError(0);
  }
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    // Never read the response body on an error. It may echo a credential or
    // other untrusted upstream data and is not needed for the typed status.
    throw new GithubApiError(response.status);
  }
  return response;
}

async function json<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new GithubApiError(response.status);
  }
}

async function repositoryDefaultBranch(ctx: GithubContext): Promise<string> {
  const payload = await json<{ default_branch?: unknown }>(await request(ctx, ""));
  if (typeof payload.default_branch !== "string" || payload.default_branch === "") {
    throw new GithubApiError(200);
  }
  return payload.default_branch;
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** TextEncoder -> binary string -> base64, safe for Japanese and other non-ASCII text. */
export function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeUtf8Base64(value: string): string {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

async function getContent(ctx: GithubContext, path: string, ref: string): Promise<GithubContent | undefined> {
  const response = await request(
    ctx,
    `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    undefined,
    [404],
  );
  if (response.status === 404) return undefined;
  const payload = await json<Partial<GithubContent>>(response);
  if (typeof payload.sha !== "string" || typeof payload.content !== "string" || payload.encoding !== "base64") {
    throw new GithubApiError(response.status);
  }
  return payload as GithubContent;
}

export async function getPolicyFile(deps: GithubApiDeps, path: string = POLICY_FILE_PATH): Promise<PolicyFile> {
  assertPolicyPath(path);
  const ctx = context(deps);
  const defaultBranch = await repositoryDefaultBranch(ctx);
  const file = await getContent(ctx, path, defaultBranch);
  if (!file) throw new GithubApiError(404);
  let text: string;
  try {
    text = decodeUtf8Base64(file.content);
  } catch {
    throw new GithubApiError(200);
  }
  return { text, blobSha: file.sha, defaultBranch };
}

async function openPolicyPulls(ctx: GithubContext): Promise<GithubPull[]> {
  const policyPulls: GithubPull[] = [];
  for (let page = 1; ; page++) {
    const response = await request(ctx, `/pulls?state=open&per_page=100&page=${page}`);
    const payload = await json<unknown>(response);
    if (!Array.isArray(payload)) throw new GithubApiError(response.status);
    policyPulls.push(
      ...payload.filter((item): item is GithubPull => {
        if (!item || typeof item !== "object") return false;
        const pull = item as Partial<GithubPull>;
        return (
          typeof pull.html_url === "string" &&
          typeof pull.number === "number" &&
          !!pull.head &&
          typeof pull.head.ref === "string" &&
          pull.head.ref.startsWith(POLICY_BRANCH_PREFIX)
        );
      }),
    );
    if (payload.length < 100) return policyPulls;
  }
}

function existingOrConflict(pulls: readonly GithubPull[], branch: string): EnsurePolicyPrOutcome | undefined {
  const other = pulls.find((pull) => pull.head.ref !== branch);
  if (other) return { kind: "conflict", url: other.html_url };
  const own = pulls.find((pull) => pull.head.ref === branch);
  return own ? { kind: "existing", url: own.html_url, number: own.number } : undefined;
}

async function getRefSha(ctx: GithubContext, branch: string): Promise<string | undefined> {
  const response = await request(ctx, `/git/ref/heads/${encodeRef(branch)}`, undefined, [404]);
  if (response.status === 404) return undefined;
  const payload = await json<{ object?: { sha?: unknown } }>(response);
  if (typeof payload.object?.sha !== "string" || payload.object.sha === "") throw new GithubApiError(response.status);
  return payload.object.sha;
}

async function ensureBranch(ctx: GithubContext, branch: string, defaultBranch: string): Promise<void> {
  if (await getRefSha(ctx, branch)) return;
  const defaultSha = await getRefSha(ctx, defaultBranch);
  if (!defaultSha) throw new GithubApiError(404);
  const response = await request(
    ctx,
    "/git/refs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: defaultSha }),
    },
    [422],
  );
  if (response.status === 422 && !(await getRefSha(ctx, branch))) throw new GithubApiError(422);
}

async function ensureContent(ctx: GithubContext, path: string, branch: string, newContent: string): Promise<void> {
  const current = await getContent(ctx, path, branch);
  if (current) {
    try {
      if (decodeUtf8Base64(current.content) === newContent) return;
    } catch {
      throw new GithubApiError(200);
    }
  }
  const response = await request(
    ctx,
    `/contents/${encodePath(path)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "[policy] update reply guidance",
        content: encodeUtf8Base64(newContent),
        branch,
        ...(current ? { sha: current.sha } : {}),
      }),
    },
    [409, 422],
  );
  if (response.status === 409 || response.status === 422) {
    const raced = await getContent(ctx, path, branch);
    try {
      if (raced && decodeUtf8Base64(raced.content) === newContent) return;
    } catch {
      throw new GithubApiError(response.status);
    }
    throw new GithubApiError(response.status);
  }
}

async function createPull(
  ctx: GithubContext,
  branch: string,
  defaultBranch: string,
  input: EnsurePolicyPrInput,
): Promise<EnsurePolicyPrOutcome> {
  const response = await request(
    ctx,
    "/pulls",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: input.title, body: input.body, head: branch, base: defaultBranch }),
    },
    [422],
  );
  if (response.status === 422) {
    const converged = existingOrConflict(await openPolicyPulls(ctx), branch);
    if (converged) return converged;
    throw new GithubApiError(422);
  }
  const payload = await json<{ html_url?: unknown; number?: unknown }>(response);
  if (typeof payload.html_url !== "string" || typeof payload.number !== "number") {
    throw new GithubApiError(response.status);
  }
  return { kind: "created", url: payload.html_url, number: payload.number };
}

export async function ensurePolicyPr(
  deps: GithubApiDeps,
  input: EnsurePolicyPrInput,
): Promise<EnsurePolicyPrOutcome> {
  const path = input.path ?? POLICY_FILE_PATH;
  assertPolicyPath(path);
  assertJobId(input.jobId);
  const ctx = context(deps);
  const branch = `${POLICY_BRANCH_PREFIX}job-${input.jobId}`;
  const defaultBranch = await repositoryDefaultBranch(ctx);

  const initial = existingOrConflict(await openPolicyPulls(ctx), branch);
  if (initial) return initial;

  await ensureBranch(ctx, branch, defaultBranch);
  await ensureContent(ctx, path, branch, input.newContent);

  // A prior attempt may have created the PR but lost its response, or a
  // different policy PR may have appeared while this attempt was updating.
  const beforeCreate = existingOrConflict(await openPolicyPulls(ctx), branch);
  if (beforeCreate) return beforeCreate;
  return createPull(ctx, branch, defaultBranch, input);
}
