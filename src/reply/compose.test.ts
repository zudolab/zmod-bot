import { describe, expect, it } from "vitest";
import { createMockD1 } from "../db/test-support";
import type { Env } from "../env";
import { POLICY_CONTENT } from "../policy/generated";
import { parseProductRefMarkdown } from "../refs/parse";
import { composeReply } from "./compose";
import { renderResourceSectionDeterministic } from "./render";
import type { FetchLike } from "../types";

const REF = parseProductRefMarkdown({
  slug: "policy-prompt-fixture",
  markdown: `# Policy Prompt Fixture

- category: small
- product-url: https://example.com/product
- aliases: policy prompt fixture

## Guides

- Manual: https://example.com/manual
`,
});

const SECTION = renderResourceSectionDeterministic(REF);

function createEnv(ai: Ai): Env {
  return {
    DB: createMockD1(),
    AI: ai,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    SLACK_BOT_USER_ID: "U000BOT",
    SLACK_ALLOWED_CHANNEL_IDS: "C1",
    SLACK_ADMIN_USER_IDS: "U1",
    COMPOSE_PROVIDER: "workers-ai",
    AUTHOR_PROVIDER: "claude",
    POLISH_PROVIDER: "workers-ai",
    CLAUDE_MODEL: "",
    SITE_API_BASE: "https://example.com",
  };
}

describe("compose policy prompt", () => {
  it("places generated policy content after the immutable engine rails", async () => {
    const calls: Record<string, unknown>[] = [];
    const ai = {
      run: async (_model: string, inputs: Record<string, unknown>) => {
        calls.push(inputs);
        return {
          response: SECTION,
          usage: { prompt_tokens: 32, completion_tokens: 24 },
        };
      },
    } as unknown as Ai;
    const fetch: FetchLike = async () => {
      throw new Error("compose must not reach the network on the workers-ai path");
    };

    await composeReply(
      { env: createEnv(ai), fetch },
      { ref: REF, arrivalSchedule: null, discord: false, direct: false },
    );

    const messages = calls[0]?.messages as Array<{ role: string; content: string }>;
    const systemPrompt = messages.find((message) => message.role === "system")?.content;
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt).toContain("----- BEGIN POLICY -----");
    expect(systemPrompt).toContain(POLICY_CONTENT);
    expect(systemPrompt).toContain("----- END POLICY -----");
    expect(systemPrompt).toContain("Never invent, alter, shorten or drop a URL.");
    expect(systemPrompt).toContain("Reproduce every LITERAL BLOCK character for character, in place.");
    expect(systemPrompt).toContain("GUIDANCE is written to you, not to the customer.");
  });

  it("injects a complete live policy marker that is absent from the compiled document", async () => {
    const calls: Record<string, unknown>[] = [];
    const ai = {
      run: async (_model: string, inputs: Record<string, unknown>) => {
        calls.push(inputs);
        return { response: SECTION, usage: { prompt_tokens: 32, completion_tokens: 24 } };
      },
    } as unknown as Ai;
    const livePolicy = `${POLICY_CONTENT}\nSTASH_LIVE_POLICY_MARKER\n`;
    expect(POLICY_CONTENT).not.toContain("STASH_LIVE_POLICY_MARKER");

    await composeReply(
      {
        env: createEnv(ai),
        fetch: async () => { throw new Error("unused"); },
        readPolicy: async () => ({ document: livePolicy, source: "stash", ageMs: 0 }),
      },
      { ref: REF, arrivalSchedule: null, discord: false, direct: false },
    );

    const messages = calls[0]?.messages as Array<{ role: string; content: string }>;
    const systemPrompt = messages.find((message) => message.role === "system")?.content;
    expect(systemPrompt).toContain("STASH_LIVE_POLICY_MARKER");
  });
});
