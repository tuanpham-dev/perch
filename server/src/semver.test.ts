import { describe, expect, it } from "vitest";
import { compare, highest, isPrerelease, parse, valid } from "./semver.js";

describe("semver", () => {
  it("parses versions, with or without a v", () => {
    expect(parse("v0.2.0-rc.1")).toEqual({ major: 0, minor: 2, patch: 0, prerelease: ["rc", "1"] });
    expect(parse("1.10.3+build.5")).toEqual({ major: 1, minor: 10, patch: 3, prerelease: [] });
    expect(parse("1.2")).toBeNull();
    expect(parse("01.2.3")).toBeNull();
    expect(valid("0.1.0")).toBe(true);
    expect(isPrerelease("0.2.0-beta.2")).toBe(true);
    expect(isPrerelease("0.2.0")).toBe(false);
  });

  it("orders by SemVer precedence", () => {
    const ordered = ["0.1.0", "0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.beta", "0.2.0-beta.2", "0.2.0-beta.11", "0.2.0-rc.1", "0.2.0", "0.2.1", "0.10.0", "1.0.0"];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compare(ordered[i]!, ordered[i + 1]!)).toBeLessThan(0);
      expect(compare(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
    }
    expect(compare("v1.2.3", "1.2.3")).toBe(0);
  });

  it("picks the highest valid version", () => {
    expect(highest(["v0.1.0", "v0.2.0-rc.1", "junk", "v0.1.5"])).toBe("v0.2.0-rc.1");
    expect(highest(["junk"])).toBeNull();
  });

  it("rejects comparing invalid versions", () => {
    expect(() => compare("1.0", "1.0.0")).toThrow("not a version: 1.0");
  });
});
