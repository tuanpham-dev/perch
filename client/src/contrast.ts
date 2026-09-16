// WCAG contrast math for the terminal's minimum-contrast-ratio setting,
// mirroring xterm.js's color.ts ensureContrastRatio behavior: when a
// foreground/background pair falls below the configured ratio, move the
// foreground toward black or white — whichever direction can actually reach
// the ratio — and return the adjusted color. Pure functions; the per-cell
// caching lives in the ghostty-engine extension's renderer shims, which
// consume this via the @perch/engine-support shim.

export type Rgb = readonly [number, number, number];

// WCAG relative luminance (sRGB).
export function relativeLuminance(rgb: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return l1 > l2 ? (l1 + 0.05) / (l2 + 0.05) : (l2 + 0.05) / (l1 + 0.05);
}

// Step the color toward black (factor < 1) or white until the pair meets
// `ratio` or the extreme is reached. 10% steps match xterm's reduce/increase
// luminance loops closely enough to be indistinguishable on screen.
function stepToward(fg: Rgb, bg: Rgb, ratio: number, lighten: boolean): Rgb {
  let [r, g, b] = fg;
  for (let i = 0; i < 30 && contrastRatio([r, g, b], bg) < ratio; i++) {
    if (lighten) {
      r = Math.min(255, r + Math.max(1, Math.ceil((255 - r) * 0.1)));
      g = Math.min(255, g + Math.max(1, Math.ceil((255 - g) * 0.1)));
      b = Math.min(255, b + Math.max(1, Math.ceil((255 - b) * 0.1)));
    } else {
      r = Math.max(0, r - Math.max(1, Math.ceil(r * 0.1)));
      g = Math.max(0, g - Math.max(1, Math.ceil(g * 0.1)));
      b = Math.max(0, b - Math.max(1, Math.ceil(b * 0.1)));
    }
    if (lighten ? r + g + b === 765 : r + g + b === 0) break;
  }
  return [r, g, b];
}

// Returns the adjusted foreground, or undefined when the pair already meets
// the ratio (callers can skip the write-back).
export function ensureContrastRatio(fg: Rgb, bg: Rgb, ratio: number): Rgb | undefined {
  if (contrastRatio(fg, bg) >= ratio) return undefined;
  // Move away from the background's luminance: a fg darker than its bg goes
  // darker still, a lighter one goes lighter — matching xterm, which
  // preserves the pair's polarity. If that direction can't reach the ratio
  // (e.g. dark-on-black), fall back to the opposite one.
  const preferLighten = relativeLuminance(fg) >= relativeLuminance(bg);
  const preferred = stepToward(fg, bg, ratio, preferLighten);
  if (contrastRatio(preferred, bg) >= ratio) return preferred;
  const opposite = stepToward(fg, bg, ratio, !preferLighten);
  return contrastRatio(opposite, bg) >= contrastRatio(preferred, bg) ? opposite : preferred;
}
