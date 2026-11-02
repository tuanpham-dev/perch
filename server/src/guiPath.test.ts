import { describe, expect, it } from "vitest";
import { ensureGuiPath, withExtraBinDirs } from "./guiPath.js";

describe("withExtraBinDirs", () => {
  it("keeps the existing PATH first and appends the missing dirs", () => {
    const out = withExtraBinDirs("/usr/bin:/bin", "/home/u").split(":");
    expect(out.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(out).toContain("/home/u/.local/bin");
    expect(out).toContain("/opt/homebrew/bin");
  });
  it("does not repeat a dir already present", () => {
    const out = withExtraBinDirs("/home/u/.local/bin:/usr/bin", "/home/u").split(":");
    expect(out.filter((d) => d === "/home/u/.local/bin")).toHaveLength(1);
  });
});

describe("ensureGuiPath", () => {
  it("leaves Windows alone", () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
    ensureGuiPath(env, "win32");
    expect(env.PATH).toBe("C:\\Windows");
  });
});
