/**
 * A minimal Node module-resolution hook so scripts/build-seed-migration.mjs
 * can `import` src/refs/parse.ts (and its src/refs/model.ts dependency)
 * directly — no build step, no new devDependency.
 *
 * The actual TypeScript-to-JS transform is Node's own
 * `--experimental-transform-types` flag (passed to `node` by the
 * `seed:build` script), which — unlike Node's default strip-only TS mode
 * — correctly erases constructor parameter properties (`private readonly
 * file: string`), a construct src/refs/parse.ts's RefDocumentParser uses
 * and that strip-only mode rejects outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
 *
 * What's left after that flag is one gap: Node's ESM resolver requires an
 * explicit extension on relative specifiers, but src/refs/parse.ts
 * imports `from "./model"` (no extension), matching this repo's
 * `moduleResolution: "Bundler"` tsconfig convention. This hook's only job
 * is closing that gap — retry an unresolvable extensionless relative
 * specifier with `.ts` appended.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through — nextResolve below throws its own (clearer) error
      // if the specifier truly doesn't resolve either way.
    }
  }
  return nextResolve(specifier, context);
}
