import { describe, expect, it } from "vitest";
import { parseCommaSeparated } from "./env";

describe("parseCommaSeparated", () => {
  it("splits on commas and trims whitespace", () => {
    expect(parseCommaSeparated("C1, C2 ,C3")).toEqual(["C1", "C2", "C3"]);
  });

  it("drops empty entries (leading/trailing/doubled commas)", () => {
    expect(parseCommaSeparated(",C1,,C2,")).toEqual(["C1", "C2"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseCommaSeparated("")).toEqual([]);
  });

  it("returns an empty array for a whitespace-only string", () => {
    expect(parseCommaSeparated("   ")).toEqual([]);
  });

  it("returns a single-entry array for a value with no comma", () => {
    expect(parseCommaSeparated("C1")).toEqual(["C1"]);
  });
});
