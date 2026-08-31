import { afterEach, describe, expect, it } from "vitest";
import { createMockD1 } from "../db/test-support";
import { POLICY_DOC_PATH } from "../policy/contract";
import { createTestEnv, type TestEnvHandle } from "../../tests/helpers/test-env";
import { getPolicyLastKnownGood, putPolicyLastKnownGood } from "./policy-store";

const INITIAL_TIME = 1_000;

describe("last-known-good policy store", () => {
  let env: TestEnvHandle | undefined;
  let nowMs = INITIAL_TIME;

  afterEach(async () => {
    await env?.dispose();
    env = undefined;
    nowMs = INITIAL_TIME;
  });

  async function setup() {
    env = await createTestEnv();
    return {
      db: env.db,
      now: () => new Date(nowMs),
    };
  }

  it("maps an injected conditional-write result without evaluating SQL in the mock tier", async () => {
    const rejectedDb = createMockD1({ onQuery: () => ({ meta: { changes: 0 } }) });
    const acceptedDb = createMockD1({ onQuery: () => ({ meta: { changes: 1 } }) });
    const input = { version: 1, document: "document-v1", etag: '"etag-v1"' };

    expect(await putPolicyLastKnownGood({ db: rejectedDb, now: () => new Date(INITIAL_TIME) }, input)).toBe(false);
    expect(await putPolicyLastKnownGood({ db: acceptedDb, now: () => new Date(INITIAL_TIME) }, input)).toBe(true);
  });

  it("starts empty and stores the exact path, document, version, quoted ETag, and confirmation epoch", async () => {
    const deps = await setup();

    expect(await getPolicyLastKnownGood(deps)).toBeNull();
    expect(await putPolicyLastKnownGood(deps, { version: 4, document: "document-v4", etag: '"etag-v4"' })).toBe(true);
    expect(await getPolicyLastKnownGood(deps)).toEqual({
      path: POLICY_DOC_PATH,
      document: "document-v4",
      version: 4,
      etag: '"etag-v4"',
      confirmed_at: INITIAL_TIME,
    });
  });

  it("fences older versions and same-version identity changes with changes === 0", async () => {
    const deps = await setup();

    await putPolicyLastKnownGood(deps, { version: 8, document: "document-v8", etag: '"etag-v8"' });
    nowMs = 2_000;

    const fencedUpdate = await deps.db
      .prepare(
        `UPDATE policy_last_known_good
         SET document = ?, version = ?, etag = ?, confirmed_at = ?
         WHERE path = ? AND version = ?`,
      )
      .bind("document-v99", 99, '"etag-v99"', nowMs, POLICY_DOC_PATH, 99)
      .run();
    expect(fencedUpdate.meta.changes).toBe(0);

    expect(await putPolicyLastKnownGood(deps, { version: 7, document: "older", etag: '"etag-v7"' })).toBe(false);
    expect(await putPolicyLastKnownGood(deps, { version: 8, document: "different", etag: '"etag-v8"' })).toBe(false);
    expect(await putPolicyLastKnownGood(deps, { version: 8, document: "document-v8", etag: '"other-etag"' })).toBe(false);
    expect(await getPolicyLastKnownGood(deps)).toEqual({
      path: POLICY_DOC_PATH,
      document: "document-v8",
      version: 8,
      etag: '"etag-v8"',
      confirmed_at: INITIAL_TIME,
    });
  });

  it("refreshes the confirmation epoch for a matching identity and replaces it for a newer version", async () => {
    const deps = await setup();

    await putPolicyLastKnownGood(deps, { version: 10, document: "document-v10", etag: '"etag-v10"' });
    nowMs = 3_000;
    expect(await putPolicyLastKnownGood(deps, { version: 10, document: "document-v10", etag: '"etag-v10"' })).toBe(true);
    expect(await getPolicyLastKnownGood(deps)).toMatchObject({ version: 10, confirmed_at: 3_000 });

    nowMs = 4_000;
    expect(await putPolicyLastKnownGood(deps, { version: 11, document: "document-v11", etag: '"etag-v11"' })).toBe(true);
    expect(await getPolicyLastKnownGood(deps)).toEqual({
      path: POLICY_DOC_PATH,
      document: "document-v11",
      version: 11,
      etag: '"etag-v11"',
      confirmed_at: 4_000,
    });
  });

  it("rolls back the whole batch when a later statement fails", async () => {
    const deps = await setup();

    await putPolicyLastKnownGood(deps, { version: 20, document: "document-v20", etag: '"etag-v20"' });

    await expect(
      deps.db.batch([
        deps.db
          .prepare(`UPDATE policy_last_known_good SET document = ?, version = ?, etag = ? WHERE path = ?`)
          .bind("document-v21", 21, '"etag-v21"', POLICY_DOC_PATH),
        deps.db.prepare("INSERT INTO table_that_does_not_exist (value) VALUES (?)").bind("fail"),
      ]),
    ).rejects.toThrow();

    expect(await getPolicyLastKnownGood(deps)).toEqual({
      path: POLICY_DOC_PATH,
      document: "document-v20",
      version: 20,
      etag: '"etag-v20"',
      confirmed_at: INITIAL_TIME,
    });
  });
});
