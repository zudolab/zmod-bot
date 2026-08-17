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
  fitSectionText,
  MAX_CHARS_PER_SECTION_TEXT,
  mrkdwnContextBlock,
  mrkdwnSection,
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
  it("includes the escaped query in a mrkdwn section and a create-reference button carrying the caller's value", () => {
    const blocks = buildMissingRefBlocks("Foo & <Bar>", '{"v":1,"id":"7","a":"Foo & <Bar>"}') as [
      { text: { text: string } },
      { elements: Array<{ action_id: string; value: string }> },
    ];

    expect(blocks[0].text.text).toContain("Foo &amp; &lt;Bar&gt;");
    expect(blocks[1].elements[0]?.action_id).toBe(CREATE_REFERENCE_ACTION_ID);
    expect(blocks[1].elements[0]?.value).toBe('{"v":1,"id":"7","a":"Foo & <Bar>"}');
  });

  /**
   * Issue #25: the value is a JSON envelope now. Slicing it to fit
   * Slack's 2000-char ceiling would produce a value that decodes to
   * `null` — i.e. a click that silently loses its origin job — so the
   * fitting happens before encoding, in src/slack/commands.ts
   * buildMissingRefPayload, and this builder must pass the value
   * through byte-for-byte no matter how long it is.
   */
  it("passes an oversized value through untouched rather than slicing a JSON envelope in half", () => {
    const oversized = `{"v":1,"id":"7","a":"${"q".repeat(3000)}"}`;

    const blocks = buildMissingRefBlocks("q", oversized) as [unknown, { elements: Array<{ value: string }> }];

    expect(blocks[1].elements[0]?.value).toBe(oversized);
  });

  /**
   * Issue #31. The section is the *other* half, and it fails the opposite
   * way: Slack rejects an oversized `section.text` with `invalid_blocks`,
   * which kills the whole message — the customer gets no reply at all
   * rather than a shortened one. A mention is unbounded free text, so
   * nothing upstream keeps this under the cap.
   */
  it("truncates a query too long for the section rather than letting Slack reject the whole message", () => {
    const blocks = buildMissingRefBlocks("q".repeat(10_000), "v") as [{ text: { text: string } }, unknown];

    const text = blocks[0].text.text;
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
    expect(text).toContain("…");
    // Still a complete sentence, not a message sliced off mid-chrome.
    expect(text).toMatch(/^「/);
    expect(text).toMatch(/に一致する製品リファレンスが見つかりませんでした。$/);
  });

  it("leaves a query that already fits untouched, marker included", () => {
    const blocks = buildMissingRefBlocks("zt seq", "v") as [{ text: { text: string } }, unknown];

    expect(blocks[0].text.text).toBe("「zt seq」に一致する製品リファレンスが見つかりませんでした。");
    expect(blocks[0].text.text).not.toContain("…");
  });

  /**
   * The budget has to be charged per character *after* escaping, and the
   * bound has to be two-sided. escapeMrkdwn turns one `&` into five
   * characters, so trimming to the raw cap overflows ~5x — but converting
   * that rendered overflow back into a source-length cut over-corrects
   * just as badly, throwing away a query that would have fit. Both
   * mistakes pass a one-sided "is it under the cap" assertion, which is
   * why the headroom is pinned too.
   */
  it("charges each character its escaped cost, filling the budget without overflowing it", () => {
    const blocks = buildMissingRefBlocks("&".repeat(MAX_CHARS_PER_SECTION_TEXT), "v") as [
      { text: { text: string } },
      unknown,
    ];

    const text = blocks[0].text.text;
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
    // Within one 5-char `&amp;` of the cap — i.e. it kept every ampersand that fit.
    expect(text.length).toBeGreaterThan(MAX_CHARS_PER_SECTION_TEXT - 5);
    expect(text).not.toContain("&&");
    expect(text).toContain("&amp;");
  });

  /**
   * Slicing between the two code units of an astral character leaves a
   * lone high surrogate, which is not valid UTF-8 on the wire. A query of
   * nothing but emoji puts a cut on that boundary every other character.
   */
  it("does not leave a half-character at the cut", () => {
    const blocks = buildMissingRefBlocks("🍣".repeat(4_000), "v") as [{ text: { text: string } }, unknown];

    const text = blocks[0].text.text;
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
    // A lone surrogate survives JSON round-tripping as an escape; a paired one does not.
    expect(JSON.stringify(text)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it("truncating the section does not touch the button value", () => {
    const value = '{"v":1,"id":"7","a":"short"}';

    const blocks = buildMissingRefBlocks("q".repeat(10_000), value) as [
      { text: { text: string } },
      { elements: Array<{ value: string }> },
    ];

    expect(blocks[0].text.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
    expect(blocks[1].elements[0]?.value).toBe(value);
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

/**
 * The generic backstop (issue #33). Where fitMissingRefSectionText knows
 * which part of its text is unbounded and bounds that, this one only sees
 * a finished string — every builder whose text can grow with operator
 * input, a stored reference body or an error message routes through it so
 * none of them can post a message Slack will reject outright.
 */
describe("fitSectionText", () => {
  it("returns text that already fits, byte for byte", () => {
    expect(fitSectionText("「zt seq」に一致する製品リファレンスが見つかりませんでした。")).toBe(
      "「zt seq」に一致する製品リファレンスが見つかりませんでした。",
    );
  });

  it("truncates past the cap and marks the cut", () => {
    const fitted = fitSectionText("q".repeat(10_000));

    expect(fitted.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
    expect(fitted.endsWith("…")).toBe(true);
    // Filled the budget rather than over-trimming.
    expect(fitted.length).toBe(MAX_CHARS_PER_SECTION_TEXT);
  });

  /**
   * The input arrives already escaped, so a naive cut can land inside an
   * `&amp;` and leave `&am` — which mrkdwn renders as those literal
   * characters rather than the `&` they stood for.
   */
  it("never leaves half of an mrkdwn escape at the cut", () => {
    // Vary the prefix length so the cut lands at every offset within an escape.
    for (let padding = 0; padding < 8; padding += 1) {
      const fitted = fitSectionText("q".repeat(padding) + escapeMrkdwn("&".repeat(MAX_CHARS_PER_SECTION_TEXT)));

      expect(fitted.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
      const body = fitted.slice(0, -1);
      expect(body.slice(padding)).toBe("&amp;".repeat((body.length - padding) / 5));
    }
  });

  /**
   * The trim above must not fire on a `&` that is simply part of the
   * text: only a cut can dangle an escape, and only one starting in the
   * final few characters. A bare ampersand further back is content.
   */
  it("does not chop back to an ampersand that the cut did not touch", () => {
    const fitted = fitSectionText(`&${"q".repeat(10_000)}`);

    expect(fitted.startsWith("&q")).toBe(true);
    expect(fitted.length).toBe(MAX_CHARS_PER_SECTION_TEXT);
  });

  it("does not leave a half-character at the cut", () => {
    const fitted = fitSectionText("🍣".repeat(4_000));

    expect(fitted.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
    expect(JSON.stringify(fitted)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });
});

describe("mrkdwnSection / mrkdwnContextBlock", () => {
  it("build the block Slack expects and bound the text", () => {
    const section = mrkdwnSection("bot_text", "q".repeat(10_000)) as {
      type: string;
      block_id: string;
      text: { type: string; text: string };
    };

    expect(section.type).toBe("section");
    expect(section.block_id).toBe("bot_text");
    expect(section.text.type).toBe("mrkdwn");
    expect(section.text.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);

    const context = mrkdwnContextBlock("hint", "q".repeat(10_000)) as {
      type: string;
      block_id: string;
      elements: Array<{ type: string; text: string }>;
    };

    expect(context.type).toBe("context");
    expect(context.block_id).toBe("hint");
    expect(context.elements[0]?.type).toBe("mrkdwn");
    expect(context.elements[0]?.text.length).toBeLessThanOrEqual(MAX_CHARS_PER_SECTION_TEXT);
  });
});
