import { describe, expect, it } from "vitest";
import { normalizeCarryOverPath } from "./carryOverPaths";

describe("normalizing a carry-over path", () => {
  it("cleans up a path relative to the repository root", () => {
    expect(normalizeCarryOverPath("  .env ")).toBe(".env");
    expect(normalizeCarryOverPath("./node_modules/")).toBe("node_modules");
    expect(normalizeCarryOverPath("client\\node_modules")).toBe("client/node_modules");
  });

  it("refuses paths that leave the repository, and empty input", () => {
    for (const raw of ["/etc/hosts", "C:/x", "../x", "a/../b", "", "  ", "./"]) {
      expect(normalizeCarryOverPath(raw), raw).toBeNull();
    }
  });
});
