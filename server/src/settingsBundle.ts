// A settings bundle: the shareable slice of the settings document, plus the
// list of extensions the sharer had installed, as one JSON file someone else
// can import (plans/settings-sync-share-and-cli-install.spec.html).
//
// This lives on the server rather than in the client because a bundle joins
// two server-owned things — the settings document and the extension list with
// each install's recorded source — and because both the browser and the CLI
// consume it. Building it in the client would mean a second copy of
// SHAREABLE_KEYS in the CLI, and that list grows every time a key starts
// syncing.
import { listExtensions, installFromPackageFile } from "./extensions.js";
import { getRegistryCatalog, resolvePackageForInstall } from "./registry.js";
import { mergeSettingsDoc, readSettingsDoc } from "./settingsStore.js";

// Bumped only for a change an older build could not read correctly. An
// importer refuses a bundle from the future rather than silently dropping
// whatever it doesn't understand.
export const BUNDLE_VERSION = 1;
const MARKER = "perchSettingsBundle";

// An ALLOWLIST, deliberately — not "every key except the secrets". The
// document holds aiSecrets and extensionSecrets today, and the day a third
// secret key is added a denylist would leak it by omission. Anything new has
// to be named here to travel, which is the safe direction to fail in.
//
// Deliberately absent: `projects` (absolute paths on the sharer's machine),
// `commandUsage` (personal stats), `pinnedSessions` (the pre-projects form of
// the same), and both secret keys (which the server never serves anyway).
export const SHAREABLE_KEYS = [
  "settings",
  "keybindings",
  "extensionSettings",
  "extensionRegistries",
  "sidebarLayout",
  "statusBarLayout",
  "sidebarPanels",
] as const;

export interface BundleExtension {
  id: string;
  version: string;
  // The registry source it was installed from, or null when none was
  // recorded — an upload, a hand-dropped folder, or an install predating
  // provenance tracking. A null here is why a row can be listed but not
  // installable.
  source: string | null;
}

export interface SettingsBundle {
  [MARKER]: number;
  exportedAt: string;
  extensions: BundleExtension[];
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Builtins are left out: they arrive with any install, so listing them would
// only give an importer rows it can do nothing useful with. A tombstoned
// extension is out for the same reason — the sharer deliberately removed it.
export async function buildBundle(): Promise<SettingsBundle> {
  const doc = await readSettingsDoc();
  const bundle: SettingsBundle = {
    [MARKER]: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    extensions: (await listExtensions())
      .filter((e) => !e.builtin && !e.uninstalled)
      .map((e) => ({ id: e.id, version: e.version, source: e.source })),
  };
  for (const key of SHAREABLE_KEYS) {
    if (key in doc) bundle[key] = doc[key];
  }
  return bundle;
}

export function parseBundle(value: unknown): { bundle: SettingsBundle } | { error: string } {
  if (!isPlainObject(value)) return { error: "not a settings bundle: expected a JSON object" };
  const version = value[MARKER];
  if (typeof version !== "number") {
    return { error: `not a Perch settings bundle: no "${MARKER}" version marker` };
  }
  if (version > BUNDLE_VERSION) {
    return {
      error: `this bundle was written by a newer Perch (format ${version}, this build reads ${BUNDLE_VERSION}) - update Perch and try again`,
    };
  }
  const extensions: BundleExtension[] = [];
  if (Array.isArray(value.extensions)) {
    for (const raw of value.extensions) {
      if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
      extensions.push({
        id: raw.id,
        version: typeof raw.version === "string" ? raw.version : "0.0.0",
        source: typeof raw.source === "string" && raw.source ? raw.source : null,
      });
    }
  }
  return { bundle: { ...value, [MARKER]: version, exportedAt: String(value.exportedAt ?? ""), extensions } };
}

export interface BundleExtensionRow extends BundleExtension {
  installed: boolean;
  // False when there is no source recorded, or the recorded source isn't one
  // this machine can reach. The UI shows the reason rather than guessing at
  // another catalog that happens to carry the same id.
  installable: boolean;
  reason?: string;
}

export interface BundleSummary {
  exportedAt: string;
  // One entry per shareable key the bundle actually carries, with how many
  // things it contributes. Counts of what is IN the bundle, not of what
  // differs — honest without needing a formatter for every setting type.
  categories: { key: string; label: string; count: number }[];
  extensions: BundleExtensionRow[];
}

const CATEGORY_LABELS: Record<string, string> = {
  settings: "Preferences",
  keybindings: "Keybinding overrides",
  extensionSettings: "Extension settings",
  extensionRegistries: "Registry sources",
  sidebarLayout: "Sidebar layout",
  statusBarLayout: "Status bar layout",
  sidebarPanels: "Sidebar panes",
};

// How many things a key contributes: entries for an object, items for an
// array, and 1 for a layout key, which is one arrangement however many ids
// it names.
function countOf(key: string, value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!isPlainObject(value)) return 0;
  if (key === "sidebarLayout" || key === "statusBarLayout" || key === "sidebarPanels") return 1;
  return Object.keys(value).length;
}

export async function summarizeBundle(bundle: SettingsBundle): Promise<BundleSummary> {
  const categories: BundleSummary["categories"] = [];
  for (const key of SHAREABLE_KEYS) {
    const count = countOf(key, bundle[key]);
    if (count > 0) categories.push({ key, label: CATEGORY_LABELS[key] ?? key, count });
  }

  const installedIds = new Set((await listExtensions()).filter((e) => !e.uninstalled).map((e) => e.id));
  // The sources this machine can actually install from: the configured ones
  // plus the built-in default. A bundle's own extensionRegistries are offered
  // to the importer as a category, but they are not trusted as install
  // sources until the merge has actually added them.
  const reachable = new Set((await getRegistryCatalog(false)).map((s) => s.source));

  const extensions: BundleExtensionRow[] = bundle.extensions.map((ext) => {
    const installed = installedIds.has(ext.id);
    if (!ext.source) {
      return {
        ...ext,
        installed,
        installable: false,
        reason: "no registry source recorded - install it by hand",
      };
    }
    if (!reachable.has(ext.source)) {
      return {
        ...ext,
        installed,
        installable: false,
        reason: `its source is not configured here (${ext.source})`,
      };
    }
    return { ...ext, installed, installable: true };
  });

  return { exportedAt: bundle.exportedAt, categories, extensions };
}

export interface BundleInstallResult {
  id: string;
  ok: boolean;
  error?: string;
}

// Merges the bundle's shareable keys over the stored document, then installs
// the requested extensions. The merge lands first and stays landed even if an
// install fails: the two are independent, and re-running an install is easy
// while re-doing a merge is not.
//
// One install failing never throws — the caller reports per extension, so a
// single unreachable source can't cost the user the rest of the import.
export async function applyBundle(
  bundle: SettingsBundle,
  extensionIds: readonly string[],
): Promise<BundleInstallResult[]> {
  const patch: Record<string, unknown> = {};
  for (const key of SHAREABLE_KEYS) {
    if (key in bundle) patch[key] = bundle[key];
  }
  // mergeSettingsDoc deep-merges, so a key the bundle doesn't mention keeps
  // its current value, and writeSettingsDoc restores both server-owned secret
  // keys from disk regardless of what any caller sends.
  if (Object.keys(patch).length > 0) await mergeSettingsDoc(patch);

  // Recomputed AFTER the merge, so a source the bundle just added counts as
  // reachable — otherwise sharing a registry and its extensions in one file
  // could never work in a single import.
  const rows = new Map((await summarizeBundle(bundle)).extensions.map((r) => [r.id, r]));

  const results: BundleInstallResult[] = [];
  for (const id of extensionIds) {
    const row = rows.get(id);
    if (!row) {
      results.push({ id, ok: false, error: "not listed in this bundle" });
      continue;
    }
    if (!row.installable || !row.source) {
      results.push({ id, ok: false, error: row.reason ?? "not installable" });
      continue;
    }
    try {
      const packagePath = await resolvePackageForInstall(row.source, id);
      await installFromPackageFile(packagePath, row.source);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
