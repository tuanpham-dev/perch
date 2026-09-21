// What "an update is available" means, in one place. Both the Extensions
// panel (the updates chip, its filter, and each row's Update button) and the
// sidebar tab's badge read this — they used to compute it separately, and
// the two disagreed: App.tsx counted tombstoned builtins the panel never
// renders an Update button for, so the badge could show a number nothing in
// the panel could act on.
import { compareVersions } from "./version";
import type { ExtensionInfo, RegistrySourceResult } from "../types";

export interface ExtensionUpdate {
  // The registry source carrying this version — what an install is made
  // against, since two sources can offer the same id.
  source: string;
  version: string;
}

/**
 * The installed extensions a configured registry offers a newer version of,
 * keyed by extension id.
 *
 * `effectiveRegistries` is the user's sources with the built-in default
 * prepended — the same list the panel displays. A just-removed source's
 * entries linger in `catalog` until the next refetch, so filtering by it here
 * is what makes a removal read as immediate.
 *
 * A tombstoned builtin (`uninstalled`) is never reported: it lives in the
 * Available section, where the action is Install, not Update.
 */
export function outdatedExtensions(
  extensions: ExtensionInfo[],
  catalog: RegistrySourceResult[],
  effectiveRegistries: string[],
): Map<string, ExtensionUpdate> {
  const sources = new Set(effectiveRegistries);
  const byId = new Map<string, ExtensionInfo>();
  for (const ext of extensions) byId.set(ext.id, ext);

  const out = new Map<string, ExtensionUpdate>();
  for (const src of catalog) {
    if (!sources.has(src.source)) continue;
    for (const entry of src.entries) {
      const installed = byId.get(entry.id);
      if (!installed || installed.uninstalled) continue;
      if (compareVersions(entry.version, installed.version) <= 0) continue;
      // Highest offer wins when several sources carry the same id, matching
      // what the per-row Update button has always done.
      const current = out.get(entry.id);
      if (current && compareVersions(entry.version, current.version) <= 0) continue;
      out.set(entry.id, { source: src.source, version: entry.version });
    }
  }
  return out;
}
