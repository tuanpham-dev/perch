import { describe, expect, it } from "vitest";
import { contrastRatio, ensureContrastRatio, relativeLuminance } from "./contrast";

describe("relativeLuminance", () => {
  it("matches the WCAG reference points", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    // sRGB mid gray
    expect(relativeLuminance([128, 128, 128])).toBeCloseTo(0.2158, 3);
  });
});

describe("contrastRatio", () => {
  it("is 21 for black/white and symmetric", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
  });

  it("is 1 for identical colors", () => {
    expect(contrastRatio([37, 99, 41], [37, 99, 41])).toBe(1);
  });
});

describe("ensureContrastRatio", () => {
  it("returns undefined when the pair already meets the ratio", () => {
    expect(ensureContrastRatio([255, 255, 255], [0, 0, 0], 4.5)).toBeUndefined();
  });

  it("lightens dark-on-dark up to the ratio", () => {
    const adjusted = ensureContrastRatio([60, 60, 60], [30, 30, 30], 4.5);
    expect(adjusted).toBeDefined();
    expect(contrastRatio(adjusted!, [30, 30, 30])).toBeGreaterThanOrEqual(4.5);
    // Polarity preserved: fg was lighter than bg, stays lighter.
    expect(relativeLuminance(adjusted!)).toBeGreaterThan(relativeLuminance([30, 30, 30]));
  });

  it("darkens light-on-light up to the ratio", () => {
    const adjusted = ensureContrastRatio([200, 200, 200], [230, 230, 230], 4.5);
    expect(adjusted).toBeDefined();
    expect(contrastRatio(adjusted!, [230, 230, 230])).toBeGreaterThanOrEqual(4.5);
    expect(relativeLuminance(adjusted!)).toBeLessThan(relativeLuminance([230, 230, 230]));
  });

  it("falls back to the opposite direction when the preferred one can't reach", () => {
    // fg darker than bg prefers darkening, but bg is already near black —
    // only lightening can reach 4.5.
    const adjusted = ensureContrastRatio([20, 20, 20], [10, 10, 10], 4.5);
    expect(adjusted).toBeDefined();
    expect(contrastRatio(adjusted!, [10, 10, 10])).toBeGreaterThanOrEqual(4.5);
  });

  it("survives the impossible ask (mid gray at ratio 21) by returning an extreme", () => {
    const adjusted = ensureContrastRatio([128, 128, 128], [128, 128, 128], 21);
    expect(adjusted).toBeDefined();
    const sum = adjusted![0] + adjusted![1] + adjusted![2];
    expect(sum === 0 || sum === 765).toBe(true);
  });
});
