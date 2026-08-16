import { describe, expect, it } from "vitest";
import { createMockD1 } from "./test-support";

describe("createMockD1", () => {
  it("records every prepare().bind() call", async () => {
    const db = createMockD1();

    await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(42).first();

    expect(db.calls).toEqual([{ query: "SELECT * FROM jobs WHERE id = ?", bindings: [42] }]);
  });

  it("defaults to an empty, zero-changes result with no onQuery configured", async () => {
    const db = createMockD1();

    const first = await db.prepare("SELECT * FROM jobs").first();
    expect(first).toBeNull();

    const all = await db.prepare("SELECT * FROM jobs").all();
    expect(all.results).toEqual([]);

    const run = await db.prepare("UPDATE jobs SET state = 'done'").run();
    expect(run.meta.changes).toBe(0);
  });

  it("onQuery returns a caller-supplied shape for a matched query", async () => {
    const db = createMockD1({
      onQuery: (call) => {
        if (call.query.includes("slack_event_receipts")) {
          return { meta: { changes: 1 } };
        }
        return null;
      },
    });

    const receipt = await db.prepare("INSERT INTO slack_event_receipts (event_id) VALUES (?)").bind("ev-1").run();
    expect(receipt.meta.changes).toBe(1);

    const other = await db.prepare("SELECT * FROM jobs").run();
    expect(other.meta.changes).toBe(0);
  });

  it("first(colName) returns just that column", async () => {
    const db = createMockD1({
      onQuery: () => ({ results: [{ alias_norm: "2v2", slug: "2v2" }] }),
    });

    const value = await db.prepare("SELECT alias_norm FROM product_ref_aliases").first<string>("alias_norm");
    expect(value).toBe("2v2");
  });

  it("batch() runs every statement and returns per-statement results", async () => {
    const db = createMockD1({
      onQuery: (call) => ({ meta: { changes: call.query.includes("a") ? 1 : 2 } }),
    });

    const results = await db.batch([db.prepare("INSERT a"), db.prepare("INSERT b")]);
    expect(results.map((r) => r.meta.changes)).toEqual([1, 2]);
  });

  it("exposes a Map for tests to seed/inspect table state directly", () => {
    const db = createMockD1();
    db.tables.set("jobs", [{ id: 1, state: "pending" }]);

    expect(db.tables.get("jobs")).toEqual([{ id: 1, state: "pending" }]);
  });
});
