import { describe, expect, it } from "vitest";
import { toClientPath, toClientPaths } from "./clientPaths.js";

describe("paths sent to the browser", () => {
  it("turns Windows drive and home paths into forward-slash form on Windows", () => {
    expect(toClientPath("C:\\Users\\me\\proj", "win32")).toBe("C:/Users/me/proj");
    expect(toClientPath("~\\proj\\src", "win32")).toBe("~/proj/src");
  });

  it("leaves other strings alone, including text that merely contains a backslash", () => {
    expect(toClientPath("echo a\\b", "win32")).toBe("echo a\\b");
    expect(toClientPath("/home/me", "win32")).toBe("/home/me");
  });

  it("does nothing on other platforms", () => {
    expect(toClientPath("C:\\Users\\me", "linux")).toBe("C:\\Users\\me");
  });

  it("converts nested JSON values", () => {
    const body = { path: "C:\\a", windows: [{ cwd: "~\\b", name: "zsh" }], count: 2, ok: true, none: null };
    expect(toClientPaths(body, "win32")).toEqual({ path: "C:/a", windows: [{ cwd: "~/b", name: "zsh" }], count: 2, ok: true, none: null });
  });
});
