import { describe, expect, it } from "vitest";
import { childPath, isAbsolutePath, isRootPath, parentPath } from "./paths";

describe("client paths", () => {
  it("recognises absolute paths on both kinds of system", () => {
    for (const p of ["/", "/home/me", "~", "~/proj", "C:/", "c:/Users/me"]) expect(isAbsolutePath(p)).toBe(true);
    for (const p of ["proj", "./x", "~me", "C:", "C:relative"]) expect(isAbsolutePath(p)).toBe(false);
  });

  it("knows the roots", () => {
    expect(isRootPath("/")).toBe(true);
    expect(isRootPath("C:/")).toBe(true);
    expect(isRootPath("D:")).toBe(true);
    expect(isRootPath("C:/Users")).toBe(false);
  });

  it("walks up to a drive root with its slash, and stops there", () => {
    expect(parentPath("C:/Users/me")).toBe("C:/Users");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(parentPath("C:/")).toBeNull();
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBeNull();
    expect(parentPath("~/proj")).toBe("~");
  });

  it("joins without doubling a root slash", () => {
    expect(childPath("C:/", "Users")).toBe("C:/Users");
    expect(childPath("/", "home")).toBe("/home");
    expect(childPath("~/proj", "src")).toBe("~/proj/src");
  });
});
