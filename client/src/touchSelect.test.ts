import { describe, expect, it } from "vitest";
import { rangeAt } from "./touchSelect";

describe("rangeAt", () => {
  it("selects a word pressed mid-line", () => {
    const text = "hello world foo";
    const r = rangeAt(text, text.indexOf("world") + 2);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("world");
    expect(r!.candidate).toBeNull();
  });

  it("selects a word pressed at the start of the line", () => {
    const text = "hello world";
    const r = rangeAt(text, 0);
    expect(r!.text).toBe("hello");
    expect(r!.startIdx).toBe(0);
  });

  it("selects a word pressed on its last character", () => {
    const text = "hello world";
    const r = rangeAt(text, text.length - 1);
    expect(r!.text).toBe("world");
    expect(r!.endIdx).toBe(text.length);
  });

  it("prefers a URL candidate over the plain word boundary", () => {
    const text = "see https://example.com/path here";
    const idx = text.indexOf("example");
    const r = rangeAt(text, idx);
    expect(r!.candidate?.kind).toBe("url");
    expect(r!.text).toBe("https://example.com/path");
  });

  it("prefers a path-with-line candidate, excluding trailing punctuation the word-boundary scan would include", () => {
    const text = "check file.ts:42, then run";
    const idx = text.indexOf("file");
    const r = rangeAt(text, idx);
    expect(r!.candidate?.kind).toBe("path");
    expect(r!.candidate?.line).toBe(42);
    expect(r!.text).toBe("file.ts:42");
  });

  it("returns null when the pressed cell is whitespace", () => {
    const text = "hello world";
    const r = rangeAt(text, text.indexOf(" "));
    expect(r).toBeNull();
  });

  it("returns null when idx is out of range", () => {
    const text = "hello";
    expect(rangeAt(text, -1)).toBeNull();
    expect(rangeAt(text, text.length)).toBeNull();
  });
});
