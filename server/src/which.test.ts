import { describe, expect, it } from "vitest";
import { candidateNames } from "./which.js";

describe("finding a command on PATH", () => {
  it("looks for the bare name outside Windows", () => {
    expect(candidateNames("claude", "linux")).toEqual(["claude"]);
  });

  it("tries each PATHEXT extension on Windows", () => {
    expect(candidateNames("claude", "win32", ".EXE;.CMD")).toEqual(["claude", "claude.exe", "claude.cmd"]);
    expect(candidateNames("node", "win32", "")).toEqual(["node", "node.com", "node.exe", "node.bat", "node.cmd"]);
  });
});
