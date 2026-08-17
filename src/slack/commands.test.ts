/**
 * Table-driven grammar tests for parseCommand, JST arrival-date clock
 * tests (frozen clock, independently verified against Intl's Asia/Tokyo
 * timezone data rather than the same UTC+9 arithmetic under test — see
 * CLAUDE.md "pin ... absence assertions to something outside the code
 * under test"), and the button-value envelope round trip. The corpus
 * button-value length assertion (issue #14 acceptance criteria) lives at
 * tests/slack/commands-corpus.test.ts instead — see the note below.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import {
  ACTION_IDS,
  ARRIVAL_PRESET_ORDER,
  buildMissingRefPayload,
  computeArrivalPresetOptions,
  decodeArrivalOptionArg,
  decodeButtonValue,
  encodeArrivalOptionArg,
  encodeButtonValue,
  isAdminUser,
  MAX_BUTTON_VALUE_CHARS,
  parseCommand,
  type ArrivalPresetKey,
  type ParsedCommand,
} from "./commands";

const BOT = "U0BOT1";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return { SLACK_ADMIN_USER_IDS: "", ...overrides } as Env;
}

/* -------------------------------------------------------------------------
 * parseCommand -- table-driven, every grammar row.
 * ---------------------------------------------------------------------- */

describe("parseCommand", () => {
  const cases: Array<{ name: string; text: string; expected: ParsedCommand }> = [
    {
      name: "bare product query -- reply, arrival unset",
      text: `<@${BOT}> OXI One MK2`,
      expected: { kind: "reply", query: "OXI One MK2", discord: false, direct: false, arrival: null },
    },
    {
      name: "product + 明日 -- reply, arrival preset (tomorrow)",
      text: `<@${BOT}> zudo-rail 明日`,
      expected: { kind: "reply", query: "zudo-rail", discord: false, direct: false, arrival: "tomorrow" },
    },
    {
      name: "product + 明後日 -- reply, arrival preset (day after tomorrow)",
      text: `<@${BOT}> zudo-rail 明後日`,
      expected: { kind: "reply", query: "zudo-rail", discord: false, direct: false, arrival: "day_after_tomorrow" },
    },
    {
      name: "product + 明々後日 -- reply, arrival preset (day after day after tomorrow)",
      text: `<@${BOT}> zudo-rail 明々後日`,
      expected: {
        kind: "reply",
        query: "zudo-rail",
        discord: false,
        direct: false,
        arrival: "day_after_day_after_tomorrow",
      },
    },
    {
      name: "--discord alone",
      text: `<@${BOT}> foo --discord`,
      expected: { kind: "reply", query: "foo", discord: true, direct: false, arrival: null },
    },
    {
      name: "--direct alone",
      text: `<@${BOT}> foo --direct`,
      expected: { kind: "reply", query: "foo", discord: false, direct: true, arrival: null },
    },
    {
      name: "--discord --direct, both, in this order",
      text: `<@${BOT}> foo --discord --direct`,
      expected: { kind: "reply", query: "foo", discord: true, direct: true, arrival: null },
    },
    {
      name: "--direct --discord, both, reverse order (flags are order-independent)",
      text: `<@${BOT}> foo --direct --discord`,
      expected: { kind: "reply", query: "foo", discord: true, direct: true, arrival: null },
    },
    {
      name: "flags interleaved before and after the query",
      text: `<@${BOT}> --discord foo bar --direct`,
      expected: { kind: "reply", query: "foo bar", discord: true, direct: true, arrival: null },
    },
    {
      name: "query + arrival preset + both flags, all interleaved",
      text: `<@${BOT}> --discord foo 明後日 --direct`,
      expected: { kind: "reply", query: "foo", discord: true, direct: true, arrival: "day_after_tomorrow" },
    },
    {
      name: "ref show <slug>",
      text: `<@${BOT}> ref show zudo-rail`,
      expected: { kind: "ref_show", slug: "zudo-rail" },
    },
    {
      name: "ref show <multi-word product name>",
      text: `<@${BOT}> ref show OXI One MK2`,
      expected: { kind: "ref_show", slug: "OXI One MK2" },
    },
    {
      name: "ref history <slug>",
      text: `<@${BOT}> ref history zudo-rail`,
      expected: { kind: "ref_history", slug: "zudo-rail" },
    },
    {
      name: "ref new <query>",
      text: `<@${BOT}> ref new some brand new product`,
      expected: { kind: "ref_new", query: "some brand new product" },
    },
    {
      name: "ref refresh <slug>",
      text: `<@${BOT}> ref refresh zudo-rail`,
      expected: { kind: "ref_refresh", slug: "zudo-rail" },
    },
    {
      name: "ref restore <slug> <version>",
      text: `<@${BOT}> ref restore zudo-rail 3`,
      expected: { kind: "ref_restore", slug: "zudo-rail", version: 3 },
    },
    {
      name: "ref restore <multi-word slug> <version>",
      text: `<@${BOT}> ref restore zudo rail lite 7`,
      expected: { kind: "ref_restore", slug: "zudo rail lite", version: 7 },
    },
    {
      name: "polish + pasted text on the next line",
      text: `<@${BOT}> polish\nこんにちは、これは整えたい文章です。`,
      expected: { kind: "polish", text: "こんにちは、これは整えたい文章です。" },
    },
    {
      name: "polish + multi-line pasted text",
      text: `<@${BOT}> polish\n一行目\n二行目`,
      expected: { kind: "polish", text: "一行目\n二行目" },
    },
    {
      name: "help",
      text: `<@${BOT}> help`,
      expected: { kind: "help" },
    },
    {
      name: "mention-stripping falls back to a generic <@...> token when botUserId doesn't match",
      text: `<@U_SOME_OTHER_BOT> foo`,
      expected: { kind: "reply", query: "foo", discord: false, direct: false, arrival: null },
    },
  ];

  it.each(cases)("$name", ({ text, expected }) => {
    expect(parseCommand(text, BOT)).toEqual(expected);
  });

  it("empty input after the mention is unknown, not a crash", () => {
    const result = parseCommand(`<@${BOT}>    `, BOT);
    expect(result.kind).toBe("unknown");
  });

  it("an unknown flag produces `unknown` with a helpful reason naming the flag, never a stack trace", () => {
    const result = parseCommand(`<@${BOT}> OXI One MK2 --bogus`, BOT);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toContain("--bogus");
      expect(result.raw).toBe(`<@${BOT}> OXI One MK2 --bogus`);
    }
  });

  it("a bare `ref` with no subcommand is unknown", () => {
    expect(parseCommand(`<@${BOT}> ref`, BOT).kind).toBe("unknown");
  });

  it("an unrecognized ref subcommand is unknown", () => {
    expect(parseCommand(`<@${BOT}> ref delete zudo-rail`, BOT).kind).toBe("unknown");
  });

  it("ref restore with a non-numeric version is unknown", () => {
    expect(parseCommand(`<@${BOT}> ref restore zudo-rail latest`, BOT).kind).toBe("unknown");
  });

  it("ref restore with no version at all is unknown", () => {
    expect(parseCommand(`<@${BOT}> ref restore zudo-rail`, BOT).kind).toBe("unknown");
  });

  it("polish with no pasted text after it is unknown", () => {
    expect(parseCommand(`<@${BOT}> polish`, BOT).kind).toBe("unknown");
    expect(parseCommand(`<@${BOT}> polish\n   `, BOT).kind).toBe("unknown");
  });

  it("two conflicting arrival presets in one message is unknown", () => {
    expect(parseCommand(`<@${BOT}> foo 明日 明後日`, BOT).kind).toBe("unknown");
  });

  it("the same arrival preset repeated is not a conflict", () => {
    expect(parseCommand(`<@${BOT}> foo 明日 明日`, BOT)).toEqual({
      kind: "reply",
      query: "foo",
      discord: false,
      direct: false,
      arrival: "tomorrow",
    });
  });

  /**
   * Issue #27's carve-out: modifier-only input is no longer `unknown` —
   * it is its own `reply_modifiers` kind, so src/jobs/worker.ts can offer
   * it the thread's remembered product. The parser stays pure and says
   * nothing about inheritance; it only reports "modifiers, no product".
   */
  it("flags/arrival-only input with no product name parses as reply_modifiers, carrying the modifiers", () => {
    expect(parseCommand(`<@${BOT}> --discord`, BOT)).toEqual({
      kind: "reply_modifiers",
      discord: true,
      direct: false,
      arrival: null,
    });
    expect(parseCommand(`<@${BOT}> 明日`, BOT)).toEqual({
      kind: "reply_modifiers",
      discord: false,
      direct: false,
      arrival: "tomorrow",
    });
    expect(parseCommand(`<@${BOT}> --direct --discord 明後日`, BOT)).toEqual({
      kind: "reply_modifiers",
      discord: true,
      direct: true,
      arrival: "day_after_tomorrow",
    });
  });

  it("the carve-out is narrow: bad input with no product name is still unknown", () => {
    // An unknown flag, an empty mention, and contradictory arrival
    // presets must not be smuggled into reply_modifiers — each one is a
    // typo the operator needs told about, not a follow-up to inherit.
    expect(parseCommand(`<@${BOT}> --bogus`, BOT).kind).toBe("unknown");
    expect(parseCommand(`<@${BOT}> --discord --bogus`, BOT).kind).toBe("unknown");
    expect(parseCommand(`<@${BOT}>`, BOT).kind).toBe("unknown");
    expect(parseCommand(`<@${BOT}>    `, BOT).kind).toBe("unknown");
    expect(parseCommand(`<@${BOT}> 明日 明後日`, BOT).kind).toBe("unknown");
  });

  it("a product name alongside modifiers is still a plain reply, never reply_modifiers", () => {
    expect(parseCommand(`<@${BOT}> foo --discord 明日`, BOT)).toEqual({
      kind: "reply",
      query: "foo",
      discord: true,
      direct: false,
      arrival: "tomorrow",
    });
  });
});

/* -------------------------------------------------------------------------
 * isAdminUser
 * ---------------------------------------------------------------------- */

describe("isAdminUser", () => {
  it("true for a user id in the comma-separated list", () => {
    expect(isAdminUser(baseEnv({ SLACK_ADMIN_USER_IDS: "U1,U2, U3" }), "U2")).toBe(true);
  });

  it("false for a user id not in the list", () => {
    expect(isAdminUser(baseEnv({ SLACK_ADMIN_USER_IDS: "U1,U2" }), "U9")).toBe(false);
  });

  it("false for every user id when the list is empty", () => {
    expect(isAdminUser(baseEnv({ SLACK_ADMIN_USER_IDS: "" }), "U1")).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Arrival dates -- JST, frozen clock, independently verified via Intl.
 * ---------------------------------------------------------------------- */

/** Independent oracle: ICU's Asia/Tokyo timezone data, not the UTC+9 arithmetic src/slack/commands.ts computeArrivalPresetOptions uses. */
function jstWeekdayKanji(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(date);
}

function jstMonthDay(date: Date): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).formatToParts(
    date,
  );
  const month = Number(parts.find((part) => part.type === "month")!.value);
  const day = Number(parts.find((part) => part.type === "day")!.value);
  return { month, day };
}

function assertOptionsMatchIndependentOracle(nowMs: number): void {
  const options = computeArrivalPresetOptions(() => new Date(nowMs));
  expect(options.map((option) => option.preset)).toEqual(ARRIVAL_PRESET_ORDER);

  const offsetsByPreset: Record<ArrivalPresetKey, number> = {
    tomorrow: 1,
    day_after_tomorrow: 2,
    day_after_day_after_tomorrow: 3,
  };

  for (const option of options) {
    const expectedInstant = new Date(nowMs + offsetsByPreset[option.preset] * 24 * 60 * 60 * 1000);
    const weekday = jstWeekdayKanji(expectedInstant);
    const { month, day } = jstMonthDay(expectedInstant);

    expect(option.month).toBe(month);
    expect(option.day).toBe(day);
    expect(option.dayLabel.endsWith(`${weekday}曜`)).toBe(true);
    expect(option.buttonLabel).toBe(`${option.dayLabel} ${month}/${day}`);
  }
}

describe("computeArrivalPresetOptions (JST, injected clock)", () => {
  it("computes tomorrow/day-after/day-after-day-after labels+dates correctly at an ordinary instant", () => {
    // 2026-08-16T12:00:00Z -> 2026-08-16 21:00 JST -- no boundary crossed.
    assertOptionsMatchIndependentOracle(Date.parse("2026-08-16T12:00:00Z"));
  });

  it("crosses a UTC-midnight boundary correctly (UTC still on the previous JST calendar day)", () => {
    // 2026-08-16T16:30:00Z -> 2026-08-17 01:30 JST -- UTC's calendar date
    // (Aug 16) already disagrees with JST's (Aug 17) at the instant the
    // clock is read.
    assertOptionsMatchIndependentOracle(Date.parse("2026-08-16T16:30:00Z"));
  });

  it("crosses a month boundary correctly (day_after_day_after_tomorrow rolls into the next month)", () => {
    // 2026-08-30T10:00:00Z -> 2026-08-30 19:00 JST; +3 days lands in September.
    assertOptionsMatchIndependentOracle(Date.parse("2026-08-30T10:00:00Z"));
  });

  it("never reads the clock itself -- two calls with the same injected now() agree", () => {
    const fixed = () => new Date("2026-08-16T12:00:00Z");
    expect(computeArrivalPresetOptions(fixed)).toEqual(computeArrivalPresetOptions(fixed));
  });
});

describe("encodeArrivalOptionArg / decodeArrivalOptionArg", () => {
  it("round-trips a resolved option", () => {
    const options = computeArrivalPresetOptions(() => new Date("2026-08-16T12:00:00Z"));
    for (const option of options) {
      const arg = encodeArrivalOptionArg(option);
      expect(decodeArrivalOptionArg(arg)).toEqual({ dayLabel: option.dayLabel, month: option.month, day: option.day });
    }
  });

  it("decode returns null (never throws) for malformed input", () => {
    expect(decodeArrivalOptionArg("not-well-formed")).toBeNull();
    expect(decodeArrivalOptionArg("明後日月曜|not-a-number|18")).toBeNull();
    expect(decodeArrivalOptionArg("")).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Button value envelope.
 * ---------------------------------------------------------------------- */

describe("encodeButtonValue / decodeButtonValue", () => {
  it("round-trips an id-only envelope", () => {
    const raw = encodeButtonValue({ v: 1, id: "42" });
    expect(decodeButtonValue(raw)).toEqual({ v: 1, id: "42" });
  });

  it("round-trips an envelope with an argument", () => {
    const raw = encodeButtonValue({ v: 1, id: "42", a: "kit" });
    expect(decodeButtonValue(raw)).toEqual({ v: 1, id: "42", a: "kit" });
  });

  it("throws when the encoded envelope would exceed Slack's 2000-char button-value cap", () => {
    expect(() => encodeButtonValue({ v: 1, id: "x".repeat(MAX_BUTTON_VALUE_CHARS) })).toThrow();
  });

  it("decode returns null (never throws) for non-JSON, a plain string value (e.g. CREATE_REFERENCE_ACTION_ID's), or a wrong shape", () => {
    expect(decodeButtonValue("not json at all")).toBeNull();
    expect(decodeButtonValue("some raw search query text")).toBeNull();
    expect(decodeButtonValue(JSON.stringify({ v: 2, id: "42" }))).toBeNull();
    expect(decodeButtonValue(JSON.stringify({ id: "42" }))).toBeNull();
    expect(decodeButtonValue(JSON.stringify({ v: 1, id: "" }))).toBeNull();
    expect(decodeButtonValue(JSON.stringify({ v: 1, id: "42", a: 7 }))).toBeNull();
  });
});

// The "no button value exceeds Slack's 2000-char cap for any reference in
// the corpus" acceptance-criteria test lives at
// tests/slack/commands-corpus.test.ts, not here -- src/** may never
// reference data/seed (CLAUDE.md "Non-negotiables": D1 is the runtime
// store; data/seed is an immutable bootstrap fixture), and
// tests/seed-corpus-isolation.test.ts enforces exactly that boundary
// against every file under src/**, this one included.

/* -------------------------------------------------------------------------
 * Action id stability sanity check.
 * ---------------------------------------------------------------------- */

describe("ACTION_IDS", () => {
  it("are the literal strings issue #14 declares stable across redeploys", () => {
    expect(ACTION_IDS).toEqual({
      arrivalPick: "arrival_pick",
      arrivalOther: "arrival_other",
      refApprove: "ref_approve",
      refReject: "ref_reject",
      variantPick: "variant_pick",
      candidatePick: "candidate_pick",
    });
  });
});

/* -------------------------------------------------------------------------
 * The missing-ref offer (issue #25) -- the button whose envelope carries
 * the originating job, so the draft a click produces knows where it came
 * from.
 * ---------------------------------------------------------------------- */

/** The single create_reference button's `value`, as Slack would receive it. */
function missingRefButtonValue(query: string, originJobId: number): string {
  const payload = buildMissingRefPayload({ query, originJobId });
  const actions = payload.blocks[1] as { elements: Array<{ value: string }> };
  return actions.elements[0]!.value;
}

describe("buildMissingRefPayload", () => {
  it("carries the originating job id and the query in one decodable envelope", () => {
    const value = missingRefButtonValue("zt seq", 4242);

    expect(decodeButtonValue(value)).toEqual({ v: 1, id: "4242", a: "zt seq" });
  });

  it("still shows the unabridged query in the message text", () => {
    const payload = buildMissingRefPayload({ query: "Foo & <Bar>", originJobId: 1 });

    expect(JSON.stringify(payload.blocks[0])).toContain("Foo &amp; &lt;Bar&gt;");
  });

  /**
   * The id is what the draft records as `origin_job_id` and what the
   * interaction receipt keys on, so it is the half that must survive
   * intact. encodeButtonValue throws on overflow — an overlong query
   * must not make the button unbuildable.
   */
  it("truncates the query, not the id, when the two cannot both fit under the 2000-char cap", () => {
    const value = missingRefButtonValue("q".repeat(5_000), 4242);

    expect(value.length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_CHARS);
    const decoded = decodeButtonValue(value);
    expect(decoded?.id).toBe("4242");
    expect(decoded?.a).toBe("q".repeat(decoded!.a!.length));
    expect(decoded!.a!.length).toBeGreaterThan(1_900);
  });

  /**
   * A fixed character budget would be wrong here: JSON escaping makes a
   * quote cost two characters and a lone surrogate six, so a query of
   * 1,999 quotes encodes to roughly twice the cap.
   */
  it("fits a query whose every character doubles under JSON escaping", () => {
    const value = missingRefButtonValue('"'.repeat(5_000), 7);

    expect(value.length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_CHARS);
    expect(decodeButtonValue(value)?.id).toBe("7");
  });

  it("fits a query of astral-plane characters without emitting a value that fails to decode", () => {
    const value = missingRefButtonValue("\u{1F600}".repeat(2_000), 7);

    expect(value.length).toBeLessThanOrEqual(MAX_BUTTON_VALUE_CHARS);
    expect(decodeButtonValue(value)?.id).toBe("7");
  });
});
