/**
 * Worker bindings and environment — hand-declared here rather than
 * generated via `wrangler types`, so `pnpm typecheck` passes on a clean
 * clone with no `worker-configuration.d.ts` present (see tsconfig.json).
 * Keep this interface in sync with wrangler.jsonc's `d1_databases`, `ai`,
 * `secrets.required` and `vars` — nothing enforces that automatically.
 */

export type ComposeProviderName = "workers-ai" | "claude";

export interface Env {
  // Bindings
  DB: D1Database;
  AI: Ai;

  // Secrets — wrangler.jsonc `secrets.required` lists names only; real
  // values come from `wrangler secret put <NAME>` (deployed) or
  // `.dev.vars` (local, gitignored — see .dev.vars.example).
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ANTHROPIC_API_KEY: string;
  /** Validated at the GitHub client boundary; absent until the policy PR loop is configured. */
  GITHUB_TOKEN?: string;

  // Vars
  SLACK_BOT_USER_ID: string;
  /** Comma-separated Slack channel ids — see parseCommaSeparated. */
  SLACK_ALLOWED_CHANNEL_IDS: string;
  /** Comma-separated Slack user ids — see parseCommaSeparated. */
  SLACK_ADMIN_USER_IDS: string;
  COMPOSE_PROVIDER: ComposeProviderName;
  AUTHOR_PROVIDER: ComposeProviderName;
  POLISH_PROVIDER: ComposeProviderName;
  /**
   * Policy editor provider. Blank or absent defaults to Claude because
   * document-editing quality matters. This selects an adapter, not a
   * model tier: POLICY_PROVIDER=claude alone does not guarantee a strong
   * editor.
   */
  POLICY_PROVIDER?: ComposeProviderName | "";
  /**
   * Anthropic model id for the Claude adapter. Blank means "use
   * src/llm/claude.ts DEFAULT_CLAUDE_MODEL" — this var exists so the
   * tier can be raised (e.g. to claude-sonnet-5) without a code change.
   */
  CLAUDE_MODEL: string;
  /**
   * Model for Claude policy edits. Blank or absent falls back to
   * CLAUDE_MODEL, which may itself name a cheap tier; if both are blank,
   * src/llm/claude.ts's adapter default is used.
   */
  POLICY_MODEL?: string;
  SITE_API_BASE: string;
  /** Repository targeted by policy PRs, in owner/name form. */
  GITHUB_REPO?: string;
}

/**
 * Splits a comma-separated `vars` entry (SLACK_ALLOWED_CHANNEL_IDS,
 * SLACK_ADMIN_USER_IDS) into trimmed, non-empty ids. Shared here rather
 * than duplicated between src/slack/events.ts (channel allow-list) and
 * src/slack/commands.ts (admin gate), which both need the exact same
 * parsing rule.
 */
export function parseCommaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
