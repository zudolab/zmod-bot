/**
 * Minimal `import.meta.glob` declaration.
 *
 * The repo has no `@types/node` (tsconfig's `types` is
 * `["@cloudflare/workers-types"]` — the Worker's own ambient globals), so
 * tests that need to read repo files use Vite's raw glob, which vitest
 * inlines at transform time, rather than `node:fs`. Only the one overload
 * the tests use is declared, to keep this from drifting into a
 * hand-maintained copy of `vite/client`.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
