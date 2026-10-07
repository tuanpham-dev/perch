import { describe, expect, it } from "vitest";
import { escapeForVimCmdline, vimCommand } from "./editor.js";

const installed = (...bins: string[]) => async (bin: string) => bins.includes(bin);

describe("vimCommand", () => {
  it("prefers nvim, then vim, then the vi every Unix has", async () => {
    expect(await vimCommand(installed("nvim", "vim"), "darwin")).toBe("nvim");
    expect(await vimCommand(installed("vim"), "darwin")).toBe("vim");
    expect(await vimCommand(installed(), "linux")).toBe("vi");
  });

  it("looks past PATH, where a Finder-launched app can't see Homebrew", async () => {
    const seen: (readonly string[])[] = [];
    await vimCommand(async (_bin, extra) => (seen.push(extra), false), "darwin");
    expect(seen[0]).toContain("/opt/homebrew/bin");
  });

  it("stays nvim on Windows, which has no vi", async () => {
    expect(await vimCommand(installed(), "win32")).toBe("nvim");
  });
});

describe("escapeForVimCmdline", () => {
  it("escapes what vim would expand or split, as fnameescape() does", () => {
    expect(escapeForVimCmdline("/w/cost$HOME.txt")).toBe("/w/cost\\$HOME.txt");
    expect(escapeForVimCmdline("/w/b*c?[x]{y}.txt")).toBe("/w/b\\*c\\?\\[x]\\{y}.txt");
    expect(escapeForVimCmdline("/w/my file #1 `x` 'q'.txt")).toBe("/w/my\\ file\\ \\#1\\ \\`x\\`\\ \\'q\\'.txt");
    expect(escapeForVimCmdline("+cmd")).toBe("\\+cmd");
    expect(escapeForVimCmdline("/plain/path.ts")).toBe("/plain/path.ts");
  });
});
