// Extension registries: user-configured sources (an http(s) URL or a local
// directory path) each serving an index.json catalog — see
// plans/extension-registry-and-extensions-tab.md. This module owns catalog
// loading/caching and resolving a catalog entry's .perch/README/icon down to
// bytes, for the routes in api.ts to serve. It never trusts a source or path
// supplied directly by a request: every resolution re-checks the source
// against the settings doc's current extensionRegistries list, and every
// relative file path is confirmed to stay under that source's own directory
// (local) or URL prefix (remote) before being read/fetched.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isSafeId } from "./extensions.js";
import { readSettingsDoc } from "./settingsStore.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface InternalEntry {
  id: string;
  displayName: string;
  publisher?: string;
  version: string;
  description: string;
  file: string;
  readme?: string;
  icon?: string;
}

export interface RegistryCatalogEntry {
  id: string;
  displayName: string;
  publisher?: string;
  version: string;
  description: string;
  hasReadme: boolean;
  hasIcon: boolean;
}

export interface RegistrySourceResult {
  source: string;
  error?: string;
  entries: RegistryCatalogEntry[];
}

interface SourceCatalog {
  source: string;
  error?: string;
  entries: InternalEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The built-in registry the app ships with — served from GitHub Pages (see
// the perch-extensions repo's Pages workflow) so extensions are
// discoverable out of the box without the user adding a source. Overridable
// via the EXTENSION_REGISTRY env var, read at call time (same pattern as
// ALLOWED_HOSTS/APP_NAME elsewhere).
const GITHUB_PAGES_REGISTRY = "https://tuanpham-dev.github.io/perch-extensions/";

// null = no default (env var explicitly set to empty, i.e. disabled). Unset
// env falls back to the shipped GitHub Pages catalog; a non-empty value
// overrides it (a different URL, or a local directory path).
export function getDefaultRegistry(): string | null {
  const env = process.env.EXTENSION_REGISTRY;
  if (env === undefined) return GITHUB_PAGES_REGISTRY;
  const trimmed = env.trim();
  return trimmed === "" ? null : trimmed;
}

// Prepends the default registry (if any) to a source list unless it's already
// present — so the built-in catalog is always active for every consumer
// (assertConfiguredSource, catalog fetch, install/readme/icon), whether the
// sources come from the persisted doc or a client-supplied override.
function withDefault(sources: string[]): string[] {
  const def = getDefaultRegistry();
  if (!def || sources.includes(def)) return sources;
  return [def, ...sources];
}

async function getConfiguredSources(): Promise<string[]> {
  const doc = await readSettingsDoc();
  const raw = (doc as { extensionRegistries?: unknown }).extensionRegistries;
  const configured = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  return withDefault(configured);
}

async function assertConfiguredSource(source: string): Promise<void> {
  const sources = await getConfiguredSources();
  if (!sources.includes(source)) throw new Error("unknown registry source");
}

function isUrlSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

// The directory-like base a relative file/readme/icon path in an index.json
// entry resolves against — either the URL's own directory (source names the
// index.json file itself) or the source with a trailing slash appended
// (source names the directory containing it).
function urlBaseDir(source: string): string {
  if (source.toLowerCase().endsWith(".json")) {
    return source.slice(0, source.lastIndexOf("/") + 1);
  }
  return `${source.replace(/\/+$/, "")}/`;
}

// Resolves rel against base and confirms the result never escapes base's
// origin+path prefix — rejects both `../` traversal above it and an entry
// smuggling an absolute http(s) URL to a different host in a "relative"
// field.
function resolveWithinUrlBase(base: string, rel: string): URL | null {
  let resolved: URL;
  try {
    resolved = new URL(rel, base);
  } catch {
    return null;
  }
  return resolved.href.startsWith(base) ? resolved : null;
}

// Local-dir counterpart to resolveWithinUrlBase — mirrors
// extensions.ts's resolveExtensionFile traversal guard.
function resolveWithinDir(dir: string, relPath: string): string | null {
  if (path.isAbsolute(relPath)) return null;
  const resolved = path.resolve(dir, relPath);
  const base = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function normalizeEntry(raw: unknown): InternalEntry | null {
  if (!isPlainObject(raw)) return null;
  const name = raw.name;
  const file = raw.file;
  if (typeof name !== "string" || !name) return null;
  if (typeof file !== "string" || !file) return null;
  const publisher = typeof raw.publisher === "string" ? raw.publisher : undefined;
  const id = publisher ? `${publisher}.${name}` : name;
  if (!isSafeId(id)) return null;
  return {
    id,
    publisher,
    displayName: typeof raw.displayName === "string" && raw.displayName ? raw.displayName : name,
    description: typeof raw.description === "string" ? raw.description : "",
    version: typeof raw.version === "string" && raw.version ? raw.version : "0.0.0",
    file,
    readme: typeof raw.readme === "string" ? raw.readme : undefined,
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
  };
}

function parseIndexEntries(raw: string): InternalEntry[] {
  const parsed: unknown = JSON.parse(raw);
  const list = isPlainObject(parsed) && Array.isArray(parsed.extensions) ? parsed.extensions : [];
  const entries: InternalEntry[] = [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function loadLocalSource(source: string): Promise<SourceCatalog> {
  if (!path.isAbsolute(source)) {
    return { source, error: "local registry sources must be an absolute directory path", entries: [] };
  }
  let raw: string;
  try {
    raw = await readFile(path.join(source, "index.json"), "utf8");
  } catch {
    return {
      source,
      error: `no index.json found in ${source} - generate one with the registry repo's "npm run pack" script`,
      entries: [],
    };
  }
  try {
    return { source, entries: parseIndexEntries(raw) };
  } catch {
    return { source, error: `${source}/index.json is not valid JSON`, entries: [] };
  }
}

async function loadUrlSource(source: string): Promise<SourceCatalog> {
  const indexUrl = source.toLowerCase().endsWith(".json") ? source : `${urlBaseDir(source)}index.json`;
  let res: Response;
  try {
    res = await fetch(indexUrl, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return {
      source,
      error: `failed to fetch ${indexUrl}: ${err instanceof Error ? err.message : String(err)}`,
      entries: [],
    };
  }
  if (!res.ok) return { source, error: `${indexUrl} responded ${res.status}`, entries: [] };
  const raw = await res.text();
  try {
    return { source, entries: parseIndexEntries(raw) };
  } catch {
    return { source, error: `${indexUrl} is not valid JSON`, entries: [] };
  }
}

const cache = new Map<string, { fetchedAt: number; catalog: SourceCatalog }>();

async function loadSource(source: string, refresh: boolean): Promise<SourceCatalog> {
  if (!refresh) {
    const cached = cache.get(source);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.catalog;
  }
  const catalog = isUrlSource(source) ? await loadUrlSource(source) : await loadLocalSource(source);
  // Errors aren't cached — a transient network blip or a not-yet-packed
  // directory should be retried on the very next load, not held for the
  // full TTL.
  if (!catalog.error) cache.set(source, { fetchedAt: Date.now(), catalog });
  return catalog;
}

function toPublic(catalog: SourceCatalog): RegistrySourceResult {
  return {
    source: catalog.source,
    error: catalog.error,
    entries: catalog.entries.map((e) => ({
      id: e.id,
      displayName: e.displayName,
      publisher: e.publisher,
      version: e.version,
      description: e.description,
      hasReadme: Boolean(e.readme),
      hasIcon: Boolean(e.icon),
    })),
  };
}

// sourcesOverride lets a caller that just changed its registry list pass the
// list it's about to persist, rather than reading the settings doc — the
// doc write is debounced client-side (useSettingsSync, ~400ms), so a catalog
// fetch immediately following an add/remove would otherwise race the write
// and silently see the pre-edit list. Falls back to the persisted doc for
// every other case (page load, the plain refresh button).
export async function getRegistryCatalog(refresh: boolean, sourcesOverride?: string[]): Promise<RegistrySourceResult[]> {
  const sources = sourcesOverride ? withDefault(sourcesOverride) : await getConfiguredSources();
  const results: RegistrySourceResult[] = [];
  for (const source of sources) {
    results.push(toPublic(await loadSource(source, refresh)));
  }
  return results;
}

async function findEntry(source: string, id: string): Promise<InternalEntry> {
  await assertConfiguredSource(source);
  const catalog = await loadSource(source, false);
  if (catalog.error) throw new Error(catalog.error);
  const entry = catalog.entries.find((e) => e.id === id);
  if (!entry) throw new Error("extension not found in registry source");
  return entry;
}

async function downloadToTemp(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`failed to download ${url}: ${res.status}`);
  const tempPath = path.join(tmpdir(), `perch-registry-${randomUUID()}.perch`);
  await writeFile(tempPath, Buffer.from(await res.arrayBuffer()));
  return tempPath;
}

async function copyToTemp(filePath: string): Promise<string> {
  const tempPath = path.join(tmpdir(), `perch-registry-${randomUUID()}.perch`);
  await copyFile(filePath, tempPath);
  return tempPath;
}

// Returns a temp file path ready for extensions.ts's installFromPackageFile,
// which consumes (reads then deletes) whatever path it's given — a local
// source's own .perch is therefore always copied first, never handed over
// directly.
export async function resolvePackageForInstall(source: string, id: string): Promise<string> {
  const entry = await findEntry(source, id);
  if (isUrlSource(source)) {
    const fileUrl = resolveWithinUrlBase(urlBaseDir(source), entry.file);
    if (!fileUrl) throw new Error("invalid file path in registry entry");
    return downloadToTemp(fileUrl.href);
  }
  const filePath = resolveWithinDir(source, entry.file);
  if (!filePath) throw new Error("invalid file path in registry entry");
  return copyToTemp(filePath);
}

export async function getRegistryReadme(source: string, id: string): Promise<string> {
  const entry = await findEntry(source, id);
  if (!entry.readme) throw new Error("this extension has no README");
  if (isUrlSource(source)) {
    const readmeUrl = resolveWithinUrlBase(urlBaseDir(source), entry.readme);
    if (!readmeUrl) throw new Error("invalid README path in registry entry");
    const res = await fetch(readmeUrl.href, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`failed to fetch README: ${res.status}`);
    return res.text();
  }
  const readmePath = resolveWithinDir(source, entry.readme);
  if (!readmePath) throw new Error("invalid README path in registry entry");
  return readFile(readmePath, "utf8");
}

const ICON_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function getRegistryIcon(source: string, id: string): Promise<{ data: Buffer; contentType: string }> {
  const entry = await findEntry(source, id);
  if (!entry.icon) throw new Error("this extension has no icon");
  const contentType = ICON_CONTENT_TYPES[path.extname(entry.icon).toLowerCase()] || "application/octet-stream";
  if (isUrlSource(source)) {
    const iconUrl = resolveWithinUrlBase(urlBaseDir(source), entry.icon);
    if (!iconUrl) throw new Error("invalid icon path in registry entry");
    const res = await fetch(iconUrl.href, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`failed to fetch icon: ${res.status}`);
    return { data: Buffer.from(await res.arrayBuffer()), contentType };
  }
  const iconPath = resolveWithinDir(source, entry.icon);
  if (!iconPath) throw new Error("invalid icon path in registry entry");
  return { data: await readFile(iconPath), contentType };
}
