import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./configDir.js";

// The active color theme's CSS vars, as the client last applied them, so the
// SPA shell and the web app manifest can carry them. The client already
// paints the last theme before first paint from its own localStorage (see
// client/index.html), but a browser that has never opened the app has
// nothing there, and the installed app's splash screen only ever reads the
// manifest. Resolving a theme needs the client's own CSS var mapping
// (client/src/theme.ts), so the client reports the result rather than the
// server resolving settings.colorTheme itself.
const paintPath = path.join(configDir, "theme-paint.json");

// Values end up in an HTML attribute and a JSON manifest, so both sides are
// held to what a theme color actually looks like: #hex, rgb()/rgba(), a
// named color, "transparent".
const NAME_RE = /^--[a-z0-9-]{1,64}$/i;
const VALUE_RE = /^[#a-z0-9 .,%()-]{1,64}$/i;
const MAX_VARS = 512;

export type ThemePaint = Record<string, string>;

export function sanitizeThemePaint(value: unknown): ThemePaint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(
    ([name, v]) => NAME_RE.test(name) && typeof v === "string" && VALUE_RE.test(v),
  ) as [string, string][];
  if (entries.length === 0 || entries.length > MAX_VARS) return null;
  return Object.fromEntries(entries);
}

function load(): ThemePaint | null {
  try {
    return sanitizeThemePaint(JSON.parse(readFileSync(paintPath, "utf8")));
  } catch {
    return null;
  }
}

// Kept in memory: the shell and the manifest are served on every load.
let current = load();

export function readThemePaint(): ThemePaint | null {
  return current;
}

// null clears it - the built-in theme is what the shell's CSS already paints.
export async function writeThemePaint(value: unknown): Promise<void> {
  const next = value === null ? null : sanitizeThemePaint(value);
  if (value !== null && !next) throw new Error("invalid theme paint");
  current = next;
  if (!next) {
    await rm(paintPath, { force: true });
    return;
  }
  await mkdir(configDir, { recursive: true });
  const tmp = `${paintPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next));
  await rename(tmp, paintPath);
}

// The vars go on <html>'s style attribute, the same place the client sets
// them, so the client's applyColorThemeCssVars replaces or clears them like
// its own - a stylesheet rule would outlive a switch back to the built-in
// theme.
export function paintIndexHtml(html: string, paint: ThemePaint | null): string {
  if (!paint) return html;
  const style = Object.entries(paint)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  let out = html.replace(/<html([^>]*)>/, `<html$1 style="${style}">`);
  const titleBar = paint["--titlebar-bg"];
  if (titleBar) {
    out = out.replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${titleBar}$2`);
  }
  return out;
}

export function paintManifest(manifest: Record<string, unknown>, paint: ThemePaint | null): void {
  if (!paint) return;
  if (paint["--titlebar-bg"]) manifest.theme_color = paint["--titlebar-bg"];
  if (paint["--bg"]) manifest.background_color = paint["--bg"];
}
