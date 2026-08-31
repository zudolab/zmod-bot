import { describe, expect, it } from "vitest";
import pin from "./contract-pin.json";

const EXPECTED_ROUTES = [
  ["me", "GET", "/v1/me", "any"],
  ["getFile", "GET", "/v1/stashes/:stash/files/*path", "read"],
  ["createChangeSet", "POST", "/v1/stashes/:stash/change-sets", "write"],
  ["listChangeSets", "GET", "/v1/stashes/:stash/change-sets", "read"],
  ["getChangeSet", "GET", "/v1/stashes/:stash/change-sets/:id", "read"],
  ["getChangeSetDiff", "GET", "/v1/stashes/:stash/change-sets/:id/diff", "read"],
  ["approveChangeSet", "POST", "/v1/stashes/:stash/change-sets/:id/approve", "write"],
  ["rejectChangeSet", "POST", "/v1/stashes/:stash/change-sets/:id/reject", "write"],
  ["getHistory", "GET", "/v1/stashes/:stash/history/*path", "read"],
  ["rollbackFile", "POST", "/v1/stashes/:stash/rollback/*path", "write"],
] as const;

const EXPECTED_ERROR_CODES = [
  "validation", "invalid-path", "body-not-well-formed", "unauthorized", "scope", "not-found",
  "file-deleted", "version-not-found", "stale", "exists", "already-deleted", "gc-busy",
  "already-rotated", "token-expired", "commit-conflict", "change-set-expired", "change-set-closed",
  "rate-limited", "payload-too-large", "idempotency-key-reused", "rollback-target-tombstone",
  "unsupported-representation", "upload-session-not-open", "upload-session-expired", "upload-size-mismatch",
  "upload-hash-mismatch", "range-not-satisfiable", "internal",
];

describe("stash contract pin", () => {
  it("pins the reviewed pre-release commit and explicitly disclaims behavioral coverage", () => {
    expect(pin.stashCommit).toBe("89f72efb79fc7890597aa32b632939ae9e4fb46c");
    expect(pin.behavioralCoverage).toBe("structure-only; blind to actual Worker behavior");
    expect(pin.sources).toEqual({
      routes: "packages/core/src/routes.ts:14-139",
      limits: "packages/core/src/limits.ts:1-36",
      errorCodes: "packages/core/src/errors.ts:3-32",
    });
  });

  it("contains every used route once with its exact method, template, principal, and unique statuses", () => {
    expect(pin.routes.map(({ id, method, template, principal }) => [id, method, template, principal])).toEqual(EXPECTED_ROUTES);
    expect(new Set(pin.routes.map(({ id }) => id)).size).toBe(EXPECTED_ROUTES.length);
    for (const route of pin.routes) {
      expect(route.statuses).toEqual([...new Set(route.statuses)].sort((a, b) => a - b));
      expect(route.statuses.some((status) => status >= 200 && status < 400)).toBe(true);
      expect(route.statuses).toContain(401);
    }
  });

  it("pins all 33 limit constants with independently asserted sentinel relationships", () => {
    expect(Object.keys(pin.limits)).toHaveLength(33);
    expect(pin.limits).toMatchObject({
      MAX_BODY_BYTES: 5_000_000,
      JSON_INLINE_MAX_BYTES: 5_000_000,
      LIST_LIMIT_DEFAULT: 50,
      LIST_LIMIT_MAX: 200,
      IDEMPOTENCY_KEY_MAX_CHARS: 200,
      MAX_COMMIT_ENTRIES: 20,
      COMMIT_DIFF_INLINE_ENTRIES: 8,
    });
    expect(pin.limits.JSON_INLINE_MAX_BYTES).toBe(pin.limits.MAX_BODY_BYTES);
    expect(pin.limits.R2_SPILL_BYTES).toBe(pin.limits.DIFF_MAX_BYTES);
    expect(pin.limits.BODY_LIMIT_BYTES).toBe(pin.limits.SINGLE_UPLOAD_MAX_BYTES);
  });

  it("pins the complete ordered 28-member ErrorCode list", () => {
    expect(pin.errorCodes).toEqual(EXPECTED_ERROR_CODES);
    expect(pin.errorCodes).toHaveLength(28);
    expect(new Set(pin.errorCodes).size).toBe(28);
    expect(pin.errorCodes).not.toContain("not-implemented");
  });
});
