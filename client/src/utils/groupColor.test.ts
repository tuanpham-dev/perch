import { describe, expect, it } from "vitest";
import { adjustForContrast, GROUP_COLORS, groupColorHex, nextAutoColor } from "./groupColor";

describe("nextAutoColor", () => {
  it("cycles through the palette in order", () => {
    expect(nextAutoColor(0)).toBe("grey");
    expect(nextAutoColor(1)).toBe("blue");
    expect(nextAutoColor(7)).toBe("cyan");
  });

  it("wraps around after the palette is exhausted", () => {
    expect(nextAutoColor(8)).toBe("grey");
    expect(nextAutoColor(9)).toBe("blue");
  });
});

describe("groupColorHex", () => {
  it("resolves a known key to its hex value", () => {
    expect(groupColorHex("purple")).toBe(GROUP_COLORS.find((c) => c.key === "purple")!.hex);
  });

  it("falls back to the first palette color for an unknown key", () => {
    expect(groupColorHex("not-a-real-color")).toBe(GROUP_COLORS[0].hex);
  });
});

describe("adjustForContrast", () => {
  it("lightens a mid-tone color against a dark background", () => {
    const adjusted = adjustForContrast("#5f6368", "#21252b");
    expect(adjusted).not.toBe("#5f6368");
    // Lightened means every channel moved up (or stayed at 255).
    const before = [0x5f, 0x63, 0x68];
    const after = [
      parseInt(adjusted.slice(1, 3), 16),
      parseInt(adjusted.slice(3, 5), 16),
      parseInt(adjusted.slice(5, 7), 16),
    ];
    after.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(before[i]));
  });

  it("leaves an already-sufficient color unchanged against a light background", () => {
    expect(adjustForContrast("#5f6368", "#f5f5f0")).toBe("#5f6368");
  });

  it("accepts an rgb() background string (as returned by getComputedStyle)", () => {
    const viaHex = adjustForContrast("#5f6368", "#21252b");
    const viaRgb = adjustForContrast("#5f6368", "rgb(33, 37, 43)");
    expect(viaRgb).toBe(viaHex);
  });

  it("clamps output channels to the valid 0-255 hex range", () => {
    const adjusted = adjustForContrast("#f9ab00", "#000000");
    expect(adjusted).toMatch(/^#[0-9a-f]{6}$/);
  });
});
