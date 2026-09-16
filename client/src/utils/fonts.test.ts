import { describe, expect, it } from "vitest";
import type { ExtensionFontEntry } from "../types";
import { entriesForMode } from "./fonts";

const src = [{ path: "./f.woff2", format: "woff2" }];

const regular: ExtensionFontEntry = { family: "F", src };
const regularExt: ExtensionFontEntry = { family: "F", src, unicodeRange: "U+0100-024F" };
const medium: ExtensionFontEntry = { family: "F", src, weight: "500" };
const bold: ExtensionFontEntry = { family: "F", src, weight: "bold" };
const italic: ExtensionFontEntry = { family: "F", src, style: "italic" };
const boldItalic: ExtensionFontEntry = { family: "F", src, weight: "bold", style: "italic" };

describe("entriesForMode", () => {
  it("default mode registers only matchable faces: text range + declared bold", () => {
    const out = entriesForMode(
      [regular, medium, bold, italic, boldItalic],
      { medium: false, boldIsNormal: false },
    );
    // The 500 face can never be looked up (only normal/bold lookups exist),
    // so it isn't registered — and its file is never fetched.
    expect(out.find((o) => o.entry === medium)).toBeUndefined();
    expect(out).toHaveLength(4);
    expect(out.find((o) => o.entry === regular)?.weight).toBe("1 599");
    expect(out.find((o) => o.entry === italic)?.weight).toBe("1 599");
    expect(out.find((o) => o.entry === bold)?.weight).toBe("bold");
    expect(out.find((o) => o.entry === boldItalic)?.weight).toBe("bold");
  });

  it("boldIsNormal: keeps only regular-weight entries per style, spanning all weights", () => {
    const out = entriesForMode(
      [regular, medium, bold, italic, boldItalic],
      { medium: false, boldIsNormal: true },
    );
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.weight === "1 1000")).toBe(true);
    expect(out.map((o) => o.entry.style ?? "normal").sort()).toEqual(["italic", "normal"]);
  });

  it("keeps every unicode-range slice of the chosen text face", () => {
    const out = entriesForMode([regular, regularExt, bold], { medium: false, boldIsNormal: true });
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.entry.unicodeRange)).toEqual([undefined, "U+0100-024F"]);
  });

  it("registers a style as-is when it has no text-face candidate", () => {
    const out = entriesForMode([regular, bold, boldItalic], { medium: false, boldIsNormal: true });
    // normal style collapses to the spanning regular; italic has only a
    // bold face, kept with its declared weight.
    expect(out).toHaveLength(2);
    const italicOut = out.find((o) => o.entry.style === "italic");
    expect(italicOut?.weight).toBe("bold");
  });

  it("medium + real bold: 500 face covers the text range, bold keeps its own", () => {
    const out = entriesForMode(
      [regular, medium, bold],
      { medium: true, boldIsNormal: false },
    );
    // regular is skipped so it can't win the 400 lookup.
    expect(out).toHaveLength(2);
    const text = out.find((o) => o.entry === medium);
    const boldOut = out.find((o) => o.entry === bold);
    expect(text?.weight).toBe("1 599");
    expect(boldOut?.weight).toBe("bold");
  });

  it("medium + boldIsNormal: 500 face spans everything", () => {
    const out = entriesForMode(
      [regular, medium, bold],
      { medium: true, boldIsNormal: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0].entry).toBe(medium);
    expect(out[0].weight).toBe("1 1000");
  });

  it("medium falls back to regular for styles without a 500 face", () => {
    const out = entriesForMode(
      [regular, medium, italic, boldItalic],
      { medium: true, boldIsNormal: false },
    );
    const italicText = out.find((o) => o.entry === italic);
    expect(italicText?.weight).toBe("1 599");
    const normalText = out.find((o) => o.entry === medium);
    expect(normalText?.weight).toBe("1 599");
    expect(out.find((o) => o.entry === regular)).toBeUndefined();
  });
});
