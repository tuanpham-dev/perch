import type { PickItem } from "./pickFilter";

// Every codicon, as rows for the icon picker (ctx.app.pickIcon). The names
// and their descriptive tags come from the installed @vscode/codicons
// package, the same one the app's icon font is built from, so the list
// always matches what <Icon name> can draw. Loaded on first use: it's
// ~100KB of JSON nothing needs at boot.
interface CodiconMeta {
  tags?: string[];
  category?: string;
  description?: string;
}

let cached: Promise<PickItem[]> | null = null;

export function loadCodiconItems(): Promise<PickItem[]> {
  cached ??= import("@vscode/codicons/dist/metadata.json").then((mod) => {
    const meta = (mod.default ?? mod) as Record<string, CodiconMeta>;
    return Object.entries(meta)
      .map(([name, info]) => ({
        id: name,
        label: name,
        icon: name,
        detail: info.description,
        keywords: [...(info.tags ?? []), ...(info.category ? [info.category] : [])],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });
  // A failed load isn't cached, so the next open retries.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
