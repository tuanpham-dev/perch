import { describe, expect, it } from "vitest";
import { stripTerminalReplies } from "./terminalReplies";

describe("stripTerminalReplies", () => {
  it("drops the answers a terminal gives to replayed queries", () => {
    for (const reply of [
      "\x1b[?1;2c",
      "\x1b[>0;276;0c",
      "\x1b[2;1R",
      "\x1b[0n",
      "\x1b[?2004;1$y",
      "\x1b[8;24;80t",
      "\x1bP>|xterm.js(5.5.0)\x1b\\",
      "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
      "\x1b]10;rgb:ffff/ffff/ffff\x07",
      "\x1b[O",
      "\x1b[I",
    ]) {
      expect(stripTerminalReplies(reply), JSON.stringify(reply)).toBe("");
    }
    expect(stripTerminalReplies("\x1b[?1;2c\x1b[2;1Rclaude --continue\r")).toBe("claude --continue\r");
  });

  it("keeps everything a person types", () => {
    for (const key of ["ls\r", "\x1b[A", "\x1b[1;5D", "\x1bOP", "\x1b[15~", "\x1b[3;2~", "\x03", "\x1b[200~pasted\x1b[201~", "\x1b[<0;10;5M"]) {
      expect(stripTerminalReplies(key), JSON.stringify(key)).toBe(key);
    }
  });
});

