import { describe, expect, it } from "vitest";
import {
  composeFontStack,
  FALLBACK_ONLY_VALUE,
  NO_SECONDARY_VALUE,
  parseFontStack,
  serializeFontStack,
  splitFontStack,
  type FontStackOption,
} from "./fontStack";

describe("parseFontStack / serializeFontStack round-trip", () => {
  it("splits a plain comma-separated stack and strips whitespace", () => {
    expect(parseFontStack("Menlo, Consolas, monospace")).toEqual(["Menlo", "Consolas", "monospace"]);
  });

  it("strips wrapping quotes", () => {
    expect(parseFontStack("'IBM Plex Mono', Menlo")).toEqual(["IBM Plex Mono", "Menlo"]);
  });

  it("re-quotes a family containing whitespace on serialize", () => {
    expect(serializeFontStack(["IBM Plex Mono", "Menlo"])).toBe("'IBM Plex Mono', Menlo");
  });

  it("round-trips a stack with an embedded escaped quote", () => {
    const stack = serializeFontStack(["Weird'Font", "monospace"]);
    expect(parseFontStack(stack)[0]).toContain("Weird");
  });
});

describe("composeFontStack", () => {
  it("orders primary, secondary, then parsed fallback", () => {
    const result = composeFontStack(["IBM Plex Mono"], ["Fira Code"], "Menlo, monospace");
    expect(parseFontStack(result)).toEqual(["IBM Plex Mono", "Fira Code", "Menlo", "monospace"]);
  });
});

describe("splitFontStack", () => {
  const options: FontStackOption[] = [
    { value: "ibm-plex", families: ["IBM Plex Mono"] },
    { value: "nerd-font-group", families: ["Symbols Nerd Font Mono", "Noto Color Emoji"] },
  ];

  it("falls back to FALLBACK_ONLY_VALUE/NO_SECONDARY_VALUE when nothing matches", () => {
    const result = splitFontStack("Courier, monospace", options);
    expect(result.primaryValue).toBe(FALLBACK_ONLY_VALUE);
    expect(result.secondaryValue).toBe(NO_SECONDARY_VALUE);
    expect(result.fallback).toBe("Courier, monospace");
  });

  it("matches a single-family primary option", () => {
    const result = splitFontStack("IBM Plex Mono, Menlo, monospace", options);
    expect(result.primaryValue).toBe("ibm-plex");
    expect(result.primaryFamilies).toEqual(["IBM Plex Mono"]);
    expect(result.fallback).toBe("Menlo, monospace");
  });

  it("prefers the longest matching prefix for a multi-family group", () => {
    const result = splitFontStack("Symbols Nerd Font Mono, Noto Color Emoji, monospace", options);
    expect(result.primaryValue).toBe("nerd-font-group");
    expect(result.primaryFamilies).toEqual(["Symbols Nerd Font Mono", "Noto Color Emoji"]);
    expect(result.fallback).toBe("monospace");
  });

  it("matches primary and secondary independently, excluding the primary's own option from secondary", () => {
    const result = splitFontStack(
      "IBM Plex Mono, Symbols Nerd Font Mono, Noto Color Emoji, monospace",
      options,
    );
    expect(result.primaryValue).toBe("ibm-plex");
    expect(result.secondaryValue).toBe("nerd-font-group");
    expect(result.secondaryFamilies).toEqual(["Symbols Nerd Font Mono", "Noto Color Emoji"]);
    expect(result.fallback).toBe("monospace");
  });
});
