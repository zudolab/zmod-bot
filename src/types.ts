/**
 * Cross-cutting primitives shared by multiple modules. Domain-specific
 * types (ProductRef, JobRow, ParsedCommand, ...) live in the module that
 * owns that domain instead — this file is only for the DI plumbing every
 * layer needs, per CLAUDE.md: "every function that performs I/O takes its
 * dependencies as injected options". This is what lets handler/orchestration
 * logic be tested with plain fakes, no runtime of any kind. The one
 * exception is the D1 layer itself, where storage semantics (not just
 * this module's own logic) are under test — see src/db/test-support.ts
 * and tests/helpers/test-env.ts for that narrower, deliberate use of
 * Miniflare. There is no Playwright in this repo.
 */

/** Injectable fetch, so every outbound HTTP call is replaceable in tests. */
export type FetchLike = typeof fetch;

/** Injectable wall clock. */
export type NowFn = () => Date;

/** Injectable sleep, so retry/backoff logic is testable without real delays. */
export type SleepFn = (ms: number) => Promise<void>;

/** Injectable background-work scheduler — maps to `ExecutionContext#waitUntil`. */
export type WaitUntilFn = (promise: Promise<unknown>) => void;

/** The common bundle of injected I/O dependencies threaded through service functions. */
export interface RuntimeDeps {
  fetch: FetchLike;
  now: NowFn;
  sleep: SleepFn;
  waitUntil: WaitUntilFn;
}

/** Discriminated result type for fallible operations at module boundaries, used instead of throwing across layers. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
