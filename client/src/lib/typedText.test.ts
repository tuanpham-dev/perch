import { describe, expect, it } from "vitest";
import { newlineModeFor, typedText } from "./typedText";

describe("typedText", () => {
  it("opens lines with Esc+Enter for Claude Code", () => {
    expect(typedText("a\nb\r\nc", "esc-enter")).toBe("a\x1b\rb\x1b\rc");
  });

  it("opens lines with Ctrl+J for Codex", () => {
    expect(typedText("a\nb", "ctrl-j")).toBe("a\nb");
  });

  it("wraps anything else in one bracketed paste", () => {
    expect(typedText("a\nb", "paste")).toBe("\x1b[200~a\nb\x1b[201~");
  });

  it("drops control bytes and stray paste markers, and expands tabs", () => {
    expect(typedText("keep\x03this")).toBe("keepthis");
    expect(typedText("\x1b[200~x\x1b[201~")).toBe("x");
    expect(typedText("a\tb")).toBe("a    b");
  });
});

describe("newlineModeFor", () => {
  it("picks the mode from the agent's program", () => {
    expect(newlineModeFor("claude")).toBe("esc-enter");
    expect(newlineModeFor("/usr/local/bin/codex")).toBe("ctrl-j");
    expect(newlineModeFor("opencode")).toBe("paste");
    expect(newlineModeFor(null)).toBe("paste");
  });
});
