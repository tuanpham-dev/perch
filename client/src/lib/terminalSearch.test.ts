import { describe, it, expect } from "vitest";
import { findMatches, buildMatcher, stepMatch, matchLabel } from "./terminalSearch";

const lines = [
  "the quick brown fox",
  "jumps over the lazy dog",
  "THE END",
];

describe("buildMatcher", () => {
  it("returns null for an empty query", () => {
    expect(buildMatcher("")).toBeNull();
  });

  it("escapes regex metacharacters in a plain query", () => {
    // Searching for "a.b" must not match "axb".
    expect(findMatches(["axb", "a.b"], "a.b")).toEqual([{ line: 1, column: 0, length: 3 }]);
  });

  it("treats the query as a pattern in regex mode", () => {
    expect(findMatches(["axb"], "a.b", { regex: true })).toHaveLength(1);
  });

  it("returns null for a regex that doesn't compile", () => {
    // Half-typed patterns are the normal state of a search box; throwing would
    // break the UI mid-keystroke.
    expect(buildMatcher("(unclosed", { regex: true })).toBeNull();
    expect(findMatches(["anything"], "(unclosed", { regex: true })).toEqual([]);
  });
});

describe("findMatches", () => {
  it("finds matches across lines, in reading order", () => {
    expect(findMatches(lines, "the")).toEqual([
      { line: 0, column: 0, length: 3 },
      { line: 1, column: 11, length: 3 },
      { line: 2, column: 0, length: 3 },
    ]);
  });

  it("is case-insensitive by default and case-sensitive on request", () => {
    expect(findMatches(lines, "THE")).toHaveLength(3);
    expect(findMatches(lines, "THE", { caseSensitive: true })).toEqual([{ line: 2, column: 0, length: 3 }]);
  });

  it("finds several matches on one line", () => {
    expect(findMatches(["ab ab ab"], "ab")).toHaveLength(3);
  });

  it("matches whole words only when asked", () => {
    expect(findMatches(["fox foxes"], "fox")).toHaveLength(2);
    expect(findMatches(["fox foxes"], "fox", { wholeWord: true })).toEqual([{ line: 0, column: 0, length: 3 }]);
  });

  it("returns nothing for an empty query or empty buffer", () => {
    expect(findMatches(lines, "")).toEqual([]);
    expect(findMatches([], "the")).toEqual([]);
  });

  it("terminates on a pattern that can match nothing", () => {
    // "a*" matches the empty string; without guarding, exec never advances.
    expect(() => findMatches(["bbb"], "a*", { regex: true })).not.toThrow();
    expect(findMatches(["bbb"], "a*", { regex: true })).toEqual([]);
  });

  it("finds overlapping-looking matches the way a regex does", () => {
    // "aa" in "aaaa" is two non-overlapping matches, not three.
    expect(findMatches(["aaaa"], "aa")).toHaveLength(2);
  });
});

describe("stepMatch", () => {
  it("returns -1 when there is nothing to step to", () => {
    expect(stepMatch(-1, 0, 1)).toBe(-1);
    expect(stepMatch(0, 0, -1)).toBe(-1);
  });

  it("starts at the first match going forward and the last going back", () => {
    expect(stepMatch(-1, 5, 1)).toBe(0);
    expect(stepMatch(-1, 5, -1)).toBe(4);
  });

  it("advances and retreats", () => {
    expect(stepMatch(1, 5, 1)).toBe(2);
    expect(stepMatch(1, 5, -1)).toBe(0);
  });

  it("wraps at both ends", () => {
    expect(stepMatch(4, 5, 1)).toBe(0);
    expect(stepMatch(0, 5, -1)).toBe(4);
  });

  it("handles a single match", () => {
    expect(stepMatch(0, 1, 1)).toBe(0);
    expect(stepMatch(0, 1, -1)).toBe(0);
  });
});

describe("matchLabel", () => {
  it("counts from one, the way a person does", () => {
    expect(matchLabel(0, 17)).toBe("1 of 17");
    expect(matchLabel(16, 17)).toBe("17 of 17");
  });

  it("says so when there is nothing, rather than showing nothing", () => {
    expect(matchLabel(-1, 0)).toBe("No results");
  });
});
