// Chrome-style fixed tab-group palette (client/src/App.tsx's tabGroupState,
// TabBar.tsx's group chips). Pure color math — no state — so it can be
// called directly from render.

export interface GroupColorDef {
  key: string;
  label: string;
  hex: string;
}

// Lighter, pastel variants of Chrome's tab-group palette — recognizable and
// evenly spaced in hue, but softer so the group chips and tab accents read as
// gentle tints rather than heavy saturated fills.
export const GROUP_COLORS: GroupColorDef[] = [
  { key: "grey", label: "Grey", hex: "#9aa0a6" },
  { key: "blue", label: "Blue", hex: "#669df6" },
  { key: "red", label: "Red", hex: "#ee675c" },
  { key: "yellow", label: "Yellow", hex: "#fcc934" },
  { key: "green", label: "Green", hex: "#5bb974" },
  { key: "pink", label: "Pink", hex: "#ff8bcb" },
  { key: "purple", label: "Purple", hex: "#af5cf7" },
  { key: "cyan", label: "Cyan", hex: "#4ecde6" },
];

export function groupColorHex(key: string): string {
  return GROUP_COLORS.find((c) => c.key === key)?.hex ?? GROUP_COLORS[0].hex;
}

// Cycles through the palette by how many groups already have a color
// assigned, so a fresh session's auto-assigned color is stable and spreads
// across all 8 before repeating.
export function nextAutoColor(assignedCount: number): string {
  return GROUP_COLORS[assignedCount % GROUP_COLORS.length].key;
}

type Rgb = [number, number, number];

// Accepts either "#rrggbb" (palette hex) or the "rgb(r, g, b)" / "rgba(r, g,
// b, a)" strings getComputedStyle returns — the two color shapes this module
// ever has to compare against each other.
function parseColor(color: string): Rgb {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const match = color.match(/\d+(\.\d+)?/g);
  if (!match || match.length < 3) return [0, 0, 0];
  return [Number(match[0]), Number(match[1]), Number(match[2])];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

// WCAG relative luminance (0 = black, 1 = white).
function relativeLuminance([r, g, b]: Rgb): number {
  const [rs, gs, bs] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(a: number, b: number): number {
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

// The group-color top line on a tab is a thin decorative accent, not text —
// targets WCAG's 3:1 non-text minimum rather than the 4.5:1 text minimum.
const MIN_CONTRAST = 3;
const MAX_STEPS = 12;
const STEP = 0.15;

// Nudges `color` toward black or white (away from `against`) until it clears
// MIN_CONTRAST against it, without changing which palette color it reads as.
// Used so a fixed palette stays visible against whatever the active color
// theme's tab-bar background happens to be, instead of only ever being tuned
// for the bundled dark theme.
export function adjustForContrast(color: string, against: string): string {
  const bgLum = relativeLuminance(parseColor(against));
  const towardWhite = bgLum < 0.5;
  let rgb = parseColor(color);
  for (let i = 0; i < MAX_STEPS; i++) {
    if (contrastRatio(relativeLuminance(rgb), bgLum) >= MIN_CONTRAST) break;
    rgb = rgb.map((c) => (towardWhite ? c + (255 - c) * STEP : c * (1 - STEP))) as Rgb;
  }
  return toHex(rgb);
}
