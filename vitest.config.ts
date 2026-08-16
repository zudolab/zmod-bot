import { defineConfig } from "vitest/config";

// Plain Node environment — no @cloudflare/vitest-pool-workers, no
// Miniflare. Every I/O boundary in this repo is dependency-injected
// (fetch, sleep, now, waitUntil — see CLAUDE.md "Conventions"), so tests
// exercise real logic against fakes instead of a Workers runtime.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
