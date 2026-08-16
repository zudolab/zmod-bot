import { describe, expect, it } from "vitest";
import {
  buildApprovalBlocks,
  buildArrivalDateBlocks,
  buildConfirmCancelBlocks,
  buildMissingRefBlocks,
  buildReplyBlocks,
  buildReplyMessagePayload,
  CREATE_REFERENCE_ACTION_ID,
  escapeMrkdwn,
  splitPreformattedText,
} from "./blocks";

describe("escapeMrkdwn", () => {
  it("escapes &, <, > and nothing else", () => {
    expect(escapeMrkdwn("A & B <tag> C")).toBe("A &amp; B &lt;tag&gt; C");
  });
});

describe("splitPreformattedText", () => {
  it("returns the input unchanged as a single chunk when under the budget", () => {
    expect(splitPreformattedText("short text", 100)).toEqual(["short text"]);
  });

  it("splits only at line boundaries, and rejoining reproduces the original byte-for-byte", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}: ${"x".repeat(20)}`);
    const original = lines.join("\n");

    const parts = splitPreformattedText(original, 120);

    expect(parts.length).toBeGreaterThan(1);
    // Never mid-line: every part except possibly the last ends with a
    // newline, i.e. every split point is right after a "\n".
    for (const part of parts.slice(0, -1)) {
      expect(part.endsWith("\n")).toBe(true);
    }
    expect(parts.join("")).toBe(original);
  });

  it("keeps a single line longer than the budget whole rather than truncating it", () => {
    const longLine = "x".repeat(500);

    const parts = splitPreformattedText(longLine, 50);

    expect(parts).toEqual([longLine]);
    expect(parts.join("")).toBe(longLine);
  });

  it("handles a mix of short and one oversized line without losing or truncating any byte", () => {
    const original = `short line\n${"y".repeat(500)}\nanother short line`;

    const parts = splitPreformattedText(original, 50);

    expect(parts.join("")).toBe(original);
  });

  it("round-trips a large multi-paragraph reply exactly", () => {
    const paragraph =
      "こちら、本日ヤマトで発送させていただきました。明日到着予定になります。\n";
    const original = paragraph.repeat(300); // well over MAX_CHARS_PER_PREFORMATTED_BLOCK

    const parts = splitPreformattedText(original, 3000);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(original);
  });
});

describe("buildReplyBlocks", () => {
  it("wraps short text as a single rich_text -> rich_text_preformatted block with literal content", () => {
    const blocks = buildReplyBlocks("hello & <world>") as Array<{
      type: string;
      elements: Array<{ type: string; elements: Array<{ type: string; text: string }> }>;
    }>;

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("rich_text");
    expect(blocks[0]?.elements[0]?.type).toBe("rich_text_preformatted");
    // Literal content: the raw text survives unescaped, unlike mrkdwn.
    expect(blocks[0]?.elements[0]?.elements[0]?.text).toBe("hello & <world>");
  });

  it("splits a long reply into multiple rich_text_preformatted blocks whose text rejoins exactly", () => {
    const line = "line of reply text\n";
    const original = line.repeat(500);

    const blocks = buildReplyBlocks(original) as Array<{
      elements: Array<{ elements: Array<{ text: string }> }>;
    }>;

    expect(blocks.length).toBeGreaterThan(1);
    const rejoined = blocks.map((b) => b.elements[0]?.elements[0]?.text ?? "").join("");
    expect(rejoined).toBe(original);
  });
});

describe("buildReplyMessagePayload", () => {
  it("carries rich_text_preformatted, suppresses unfurling, and sets a non-empty top-level text", () => {
    const payload = buildReplyMessagePayload({
      replyText: "こちら、本日ヤマトで発送させていただきました。",
      summaryText: "返信メッセージを送信しました",
    });

    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
    expect(payload.text).toBe("返信メッセージを送信しました");
    expect(payload.text.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).toContain("rich_text_preformatted");
    // The reply body must never be carried as a mrkdwn section.
    expect(serialized).not.toContain('"type":"mrkdwn"');
  });

  it("never puts the full reply body in the top-level text field", () => {
    const replyText = "x".repeat(5000);
    const payload = buildReplyMessagePayload({ replyText, summaryText: "短い要約" });

    expect(payload.text).toBe("短い要約");
    expect(payload.text).not.toContain(replyText);
  });
});

describe("buildConfirmCancelBlocks / buildApprovalBlocks", () => {
  it("builds an actions block with distinct, stable action_ids and an explicit block_id", () => {
    const blocks = buildConfirmCancelBlocks({
      blockId: "ref_new_block",
      confirmActionId: "ref_new_approve",
      cancelActionId: "ref_new_cancel",
      value: "draft-123",
    }) as Array<{
      type: string;
      block_id: string;
      elements: Array<{ action_id: string; value: string; style?: string }>;
    }>;

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.block_id).toBe("ref_new_block");
    const actionIds = blocks[0]?.elements.map((e) => e.action_id);
    expect(actionIds).toEqual(["ref_new_approve", "ref_new_cancel"]);
    for (const element of blocks[0]?.elements ?? []) {
      expect(element.value).toBe("draft-123");
    }
  });

  it("buildApprovalBlocks derives stable approve/cancel action_ids from actionId", () => {
    const blocks = buildApprovalBlocks({ actionId: "ref_refresh", value: "draft-456" }) as Array<{
      block_id: string;
      elements: Array<{ action_id: string }>;
    }>;

    expect(blocks[0]?.block_id).toBe("ref_refresh_block");
    expect(blocks[0]?.elements.map((e) => e.action_id)).toEqual(["ref_refresh_approve", "ref_refresh_cancel"]);
  });
});

describe("buildMissingRefBlocks", () => {
  it("includes the escaped query in a mrkdwn section and a create-reference button carrying the raw query", () => {
    const blocks = buildMissingRefBlocks("Foo & <Bar>") as [
      { text: { text: string } },
      { elements: Array<{ action_id: string; value: string }> },
    ];

    expect(blocks[0].text.text).toContain("Foo &amp; &lt;Bar&gt;");
    expect(blocks[1].elements[0]?.action_id).toBe(CREATE_REFERENCE_ACTION_ID);
    expect(blocks[1].elements[0]?.value).toBe("Foo & <Bar>");
  });

  it("truncates an overlong query to Slack's 2000-char button value ceiling", () => {
    const longQuery = "q".repeat(3000);

    const blocks = buildMissingRefBlocks(longQuery) as [unknown, { elements: Array<{ value: string }> }];

    expect(blocks[1].elements[0]?.value.length).toBe(2000);
  });
});

describe("buildArrivalDateBlocks", () => {
  it("builds one button per option with stable indexed action_ids and an explicit block_id", () => {
    const blocks = buildArrivalDateBlocks({
      blockId: "arrival_date_block",
      actionId: "arrival_date",
      options: [
        { label: "明日水曜 8/16", value: "8/16" },
        { label: "明後日木曜 8/17", value: "8/17" },
        { label: "明々後日金曜 8/18", value: "8/18" },
        { label: "その他", value: "other" },
      ],
    }) as Array<{
      block_id: string;
      elements: Array<{ action_id: string; value: string; text: { text: string } }>;
    }>;

    expect(blocks[0]?.block_id).toBe("arrival_date_block");
    expect(blocks[0]?.elements.map((e) => e.action_id)).toEqual([
      "arrival_date_0",
      "arrival_date_1",
      "arrival_date_2",
      "arrival_date_3",
    ]);
    expect(blocks[0]?.elements[3]?.value).toBe("other");
    expect(blocks[0]?.elements[0]?.text.text).toBe("明日水曜 8/16");
  });
});
