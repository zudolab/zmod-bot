import { describe, expect, it } from "vitest";
import { STASH_ERROR_CODES } from "./api";
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

  it("guards every client operation's route, credential choice, request surface, and success schema", () => {
    const operations = [
      { routeId: "getFile", token: "read", statuses: [200, 304, 400, 401, 404, 429, 500], headers: ["Authorization", "If-None-Match"], query: [], body: [], success: ["ETag", "X-Stash-Version", "path", "version", "body", "deleted"] },
      { routeId: "createChangeSet", token: "write", statuses: [201, 400, 401, 403, 404, 409, 413, 422, 429, 500], headers: ["Authorization", "Content-Type", "Idempotency-Key"], query: [], body: ["baseVersion", "expiresAt"], success: ["id", "status", "expiresAt", "entries"] },
      { routeId: "listChangeSets", token: "read", statuses: [200, 400, 401, 404, 429], headers: ["Authorization"], query: ["status", "path", "limit", "after"], body: [], success: ["changeSets", "nextAfter", "total"] },
      { routeId: "getChangeSet", token: "read", statuses: [200, 400, 401, 404, 429], headers: ["Authorization"], query: [], body: [], success: ["id", "status", "entries"] },
      { routeId: "getChangeSetDiff", token: "read", statuses: [200, 400, 401, 404, 429, 500], headers: ["Authorization"], query: ["path", "context"], body: [], success: ["entries", "stale", "status", "truncated"] },
      { routeId: "approveChangeSet", token: "write", statuses: [200, 400, 401, 403, 404, 409, 429, 500], headers: ["Authorization", "Content-Type"], query: [], body: ["author", "message"], success: ["status", "commit"] },
      { routeId: "rejectChangeSet", token: "write", statuses: [200, 400, 401, 403, 404, 409, 429], headers: ["Authorization", "Content-Type"], query: [], body: ["reason"], success: ["id", "status", "entries"] },
      { routeId: "getHistory", token: "read", statuses: [200, 400, 401, 404, 429], headers: ["Authorization"], query: ["limit", "before"], body: [], success: ["path", "headVersion", "versions", "nextBefore"] },
      { routeId: "rollbackFile", token: "write", statuses: [201, 400, 401, 403, 404, 409, 413, 422, 429, 500], headers: ["Authorization", "Content-Type"], query: [], body: ["toVersion", "expectedVersion"], success: ["commitId", "version", "rollbackOf"] },
    ] as const;
    expect(operations.map(({ routeId, token }) => [routeId, token])).toEqual([
      ["getFile", "read"],
      ["createChangeSet", "write"],
      ["listChangeSets", "read"],
      ["getChangeSet", "read"],
      ["getChangeSetDiff", "read"],
      ["approveChangeSet", "write"],
      ["rejectChangeSet", "write"],
      ["getHistory", "read"],
      ["rollbackFile", "write"],
    ]);
    for (const operation of operations) {
      const route = pin.routes.find(({ id }) => id === operation.routeId);
      expect(route).toBeDefined();
      expect(operation.token).toBe(route?.principal);
      expect(operation.statuses).toEqual(route?.statuses);
      expect(operation.headers).toContain("Authorization");
      expect(operation.success.length).toBeGreaterThan(0);
      if (operation.token === "write") expect(operation.headers).toContain("Content-Type");
    }
    expect(operations.find(({ routeId }) => routeId === "createChangeSet")).toMatchObject({ headers: ["Authorization", "Content-Type", "Idempotency-Key"], body: ["baseVersion", "expiresAt"] });
    expect(operations.find(({ routeId }) => routeId === "rollbackFile")?.body).toContain("expectedVersion");
    expect(operations.find(({ routeId }) => routeId === "listChangeSets")?.query).toEqual(["status", "path", "limit", "after"]);
    expect(pin.routes.flatMap(({ statuses }) => statuses)).toEqual(expect.arrayContaining([400, 401, 403, 404, 409, 413, 422, 429, 500]));
    expect(pin.errorCodes).toEqual(expect.arrayContaining(EXPECTED_ERROR_CODES));
    expect(STASH_ERROR_CODES).toEqual(pin.errorCodes);
  });
});
