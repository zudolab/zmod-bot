import { defineConfig } from "vitest/config";

// Plain Node environment — no @cloudflare/vitest-pool-workers. Most I/O
// boundaries in this repo are dependency-injected (fetch, sleep, now,
// waitUntil — see CLAUDE.md "Conventions") and tested with plain fakes;
// the D1 layer additionally gets a real emulated binding via Miniflare
// (tests/helpers/test-env.ts) for storage-semantics assertions — see
// src/db/test-support.ts for the two-tier rationale. testTimeout is
// raised because spinning up a Miniflare instance is slower than a
// typical unit test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 10000,
  },
});
