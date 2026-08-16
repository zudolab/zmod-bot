/**
 * Ambient module declaration for Vite's `?raw` import suffix — vitest's
 * transform is Vite-powered, so `tests/helpers/test-env.ts` can import a
 * migration file's SQL text directly. This project's tsconfig
 * deliberately types only `@cloudflare/workers-types` (no `node`), so
 * `node:fs` isn't typed here; `?raw` keeps this test helper out of that
 * conflict entirely instead of adding a Node types dependency to a
 * Workers-only project.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
