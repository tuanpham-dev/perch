import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// Finds the picture a project already carries for itself, so its avatar
// doesn't need to be picked by hand. Looks in the folders projects usually
// keep branding in, matches names case-insensitively (Logo.SVG, app-icon.png,
// logo-512.png), and prefers a square app icon over a wide wordmark.

const EXT_RANK: Record<string, number> = { ".svg": 0, ".png": 1, ".webp": 2, ".jpg": 3, ".jpeg": 3, ".ico": 4 };

// Earlier = better. A name matches when it equals the pattern or starts with it
// followed by a separator/digit (icon-512, logo_dark, favicon32x32).
const NAME_ORDER = ["app-icon", "appicon", "icon", "apple-touch-icon", "favicon", "logo", "mark", "brand"];

// Folders searched, best first. "" is the project root.
const DIRS = [
  "",
  "assets",
  "assets/images",
  "assets/icons",
  "public",
  "static",
  "resources",
  "images",
  "img",
  "icons",
  "media",
  "branding",
  "docs",
  "doc",
  ".github",
  "build",
  "src/assets",
  "client/public",
  "web/public",
  "app/public",
  "frontend/public",
];

const MAX_BYTES = 2 * 1024 * 1024;

function nameRank(base: string): number {
  const lower = base.toLowerCase();
  for (let i = 0; i < NAME_ORDER.length; i++) {
    const n = NAME_ORDER[i];
    if (lower === n) return i * 2;
    if (lower.startsWith(n) && /^[-_.\d@x]/.test(lower.slice(n.length))) return i * 2 + 1;
  }
  return -1;
}

// <link rel="icon" href="..."> in an index.html is the one place a project
// points at its icon explicitly — the fallback when no conventional name hit.
async function iconFromHtml(dir: string): Promise<string | null> {
  for (const rel of ["index.html", "public/index.html", "client/index.html", "src/index.html"]) {
    let html: string;
    try {
      html = await readFile(path.join(dir, rel), "utf8");
    } catch {
      continue;
    }
    const m = html.match(/<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*\bhref=["']([^"'#?]+)/i)
      ?? html.match(/<link\b[^>]*\bhref=["']([^"'#?]+)["'][^>]*\brel=["'](?:shortcut )?icon["']/i);
    const href = m?.[1];
    if (!href || /^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith("data:")) continue;
    // A root-relative href ("/favicon.svg") is served from public/ by most
    // bundlers, or from the page's own folder by a plain static site.
    const pageDir = path.join(dir, path.dirname(rel));
    for (const candidate of [path.join(pageDir, href), path.join(dir, "public", href), path.join(dir, href)]) {
      if (await usable(candidate, dir)) return candidate;
    }
  }
  return null;
}

async function usable(file: string, root: string): Promise<boolean> {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return false;
  if (!(path.extname(resolved).toLowerCase() in EXT_RANK)) return false;
  try {
    const s = await stat(resolved);
    return s.isFile() && s.size > 0 && s.size <= MAX_BYTES;
  } catch {
    return false;
  }
}

export async function findProjectIcon(cwd: string): Promise<string | null> {
  let best: { file: string; score: number } | null = null;
  for (let d = 0; d < DIRS.length; d++) {
    const dir = path.join(cwd, DIRS[d]);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      const extRank = EXT_RANK[ext];
      if (extRank === undefined) continue;
      const rank = nameRank(path.basename(entry, path.extname(entry)));
      if (rank < 0) continue;
      const file = path.join(dir, entry);
      if (!(await usable(file, cwd))) continue;
      // Name matters most, then folder depth, then format. An .ico is only a
      // last resort: browsers render it, but it is often a multi-size blob.
      const score = rank * 1000 + d * 10 + extRank;
      if (!best || score < best.score) best = { file, score };
    }
  }
  if (best) return best.file;
  return iconFromHtml(cwd);
}
