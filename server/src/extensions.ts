// Extensions live as folders under ~/.config/perch/extensions/<folder>/,
// each with a VS Code-shaped package.json. `contributes.themes` /
// `contributes.iconThemes` are served as-is to the client (which does all
// theme parsing/mapping) — this module only discovers manifests, tracks
// enabled state, handles .perch install/uninstall, and mounts/unmounts
// per-extension server hooks. See README's Extensions section for the
// manifest format.
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type NextFunction, type Request, type Response, type Router } from "express";
import { createExtensionRouter, runExtensionRouter } from "./extensionRouter.js";
import { recordServerDeactivate, runServerDeactivate } from "./extensionLifecycle.js";
import { findTerminalPort, listTerminalPorts } from "./ports.js";
import { expandHome } from "./files.js";
import {
  createSession,
  captureWindow,
  createWindow,
  invalidateSessionsCache,
  killSession,
  listSessionPanes,
  listSessions,
  selectWindow,
  sendTextToSession,
  sendTextToWindow,
  type SessionPane,
  type TerminalSession,
} from "./terminals.js";
import { notifyExtension } from "./push.js";
import { createWorktree, listWorktrees, removeWorktree, type WorktreeListing } from "./gitWorktrees.js";
import { listAiProfiles, runAi, type AiProfileSummary, type AiRunOptions } from "./ai.js";
import {
  DEFAULT_AGENT_ICON,
  dropAgentCompanions,
  parseHookDescriptor,
  parseOneShot,
  registerAgentCompanion,
  type AgentCompanionTransform,
  launchCommand,
  listAgents,
  setContributedAgentsSource,
  type AgentPreset,
  type AgentSummary,
} from "./agents.js";
import { agentForWindow, agentsForSession, type AgentWindow } from "./agentWindows.js";
import {
  dropAgentHookSubscriptions,
  subscribeAgentHooks,
  type AgentHookSubscription,
} from "./agentHooks.js";
import {
  clearExtensionSecrets,
  listExtensionSecretNames,
  readExtensionSecret,
  readSettingsDoc,
  writeExtensionSecret,
} from "./settingsStore.js";
import { configDir } from "./configDir.js";
import { extractZip } from "./zip.js";
import { registerEngine, type EngineRegistration } from "./multiplexer.js";

export const extensionsDir = path.join(configDir, "extensions");
const stateFilePath = path.join(configDir, "extensions-state.json");

// Bundled extensions shipped in the repo (image/markdown/json/csv/media/pdf
// previews, etc.) — discovered alongside user-installed ones. A user-dir
// extension with the same id takes precedence (lets a .perch reinstall
// override or restore an uninstalled builtin) — see discoverExtensions.
const bundledExtensionsDir = path.resolve(import.meta.dirname, "../../extensions");

// Extension ids (publisher.name, or the folder name as a fallback) are used
// as URL path segments (/api/ext/:id, /api/extensions/:id/file/*) — reject
// anything that isn't a plain token so an id can never smuggle a path
// separator or traversal segment into those routes.
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

interface ThemeContribution {
  label: string;
  uiTheme?: string;
  path: string;
}

interface IconThemeContribution {
  id: string;
  label: string;
  path: string;
}

interface FontSrc {
  path: string;
  format: string;
}

// Not a VS Code manifest concept (VS Code's only font contribution is
// icon-theme glyph fonts) — perch's own extension of `contributes`.
// Within a group's `fonts`, entries sharing a `family` register different
// weights/styles of the same font (xterm needs the bold face for bold
// cells); entries with distinct `family` values are separate fonts bundled
// into that one group. A group is the Settings font picker's unit of
// selection: picking "Hello" (a group of a mono font + a Nerd Font symbols
// companion) writes BOTH families into the stack at once. One extension can
// contribute several groups.
interface FontEntry {
  family: string;
  src: FontSrc[];
  weight?: string;
  style?: string;
  // CSS unicode-range descriptor — lets one family/weight/style combo be
  // split across several entries by script (e.g. IBM Plex Mono's
  // latin/cyrillic/vietnamese subsets), each its own FontFace the browser
  // only fetches when a rendered character actually falls in its range.
  unicodeRange?: string;
}

interface FontGroupContribution {
  group: string;
  fonts: FontEntry[];
}

// Not a VS Code manifest concept — perch's own extension of
// `contributes`, declared statically so the client can know which engines
// exist (for the Settings picker, and to resolve which one a session
// actually needs) without running any extension's client code. `id` is the
// same unnamespaced local id the extension's own ctx.registerTerminalEngine
// call uses at activation time (client/src/extensions.ts namespaces both the
// same way: ext.<extensionId>.<id>) — kept in sync by convention, not
// re-derived from the client bundle.
interface TerminalEngineContribution {
  id: string;
  label: string;
}

// contributes.editors — an extension that can open files, git diffs, and/or
// merge conflicts (see the client's editors/index.ts resolution). Declared
// statically here, like terminalEngines, so the Settings picker can list
// every installed editor without running any extension's client code; the
// implementation arrives separately via ctx.registerEditor at activation.
export type EditorCapability = "file" | "diff" | "merge";

interface EditorContribution {
  id: string;
  label: string;
  capabilities: EditorCapability[];
}

const EDITOR_CAPABILITIES: EditorCapability[] = ["file", "diff", "merge"];

// VS Code's contributes.configuration shape. `type` supports the four
// primitive kinds a plain HTML control can render; `array`/`object`
// properties (and anything else malformed) are dropped during normalization
// — see normalizeConfiguration. enumItemLabels/enumDescriptions mirror VS
// Code: the former is the option's visible label (falls back to the raw
// enum value), the latter its tooltip.
interface ConfigurationProperty {
  type?: "boolean" | "number" | "integer" | "string";
  // Renders a richer control than a plain text box for a string property.
  // "ai-profile": a picker of the AIs configured in Settings → AI Providers; the
  // stored value is a profile id to pass as ctx.ai.run's opts.profileId
  // (empty = whatever the user's default profile is).
  format?: string;
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  enum?: string[];
  enumItemLabels?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
}

interface ConfigurationContribution {
  title?: string;
  properties?: Record<string, ConfigurationProperty>;
}

interface ExtensionManifest {
  name?: string;
  publisher?: string;
  version?: string;
  displayName?: string;
  description?: string;
  // Extension-relative path to an icon image (VS Code manifest field) —
  // served through the same file route as themes/fonts/client entries.
  icon?: string;
  contributes?: {
    themes?: ThemeContribution[];
    iconThemes?: IconThemeContribution[];
    fonts?: FontGroupContribution[];
    // VS Code allows either a single object or an array of them (one per
    // logical group); normalizeConfiguration accepts both and flattens to
    // one ordered property list.
    configuration?: ConfigurationContribution | ConfigurationContribution[];
    terminalEngines?: TerminalEngineContribution[];
    editors?: EditorContribution[];
    // Agents this extension adds to core's registry (Settings → AI Providers), so
    // a plugin can teach the app about an agent core has never heard of
    // without the user defining one by hand. Declared, not activated: the
    // registry reads these from the manifest, so a contributed agent is
    // offered for detection and launching whether or not the extension has
    // a client or server entry.
    agents?: AgentContribution[];
  };
  perch?: {
    client?: string;
    server?: string;
    // Bundled-only: a required builtin can be neither disabled nor
    // uninstalled (the xterm terminal engine — the app's rendering floor).
    // Ignored on user-installed extensions, which could otherwise claim it.
    required?: boolean;
  };
}

// One agent from a manifest's contributes.agents. The same three facts a
// core registry entry carries, plus where to read about it. `id` is
// namespaced with the extension's id when it is merged, so two extensions
// contributing "claude" cannot collide, and a user's own stored entry always
// wins over a contributed one.
export interface AgentContribution {
  id: string;
  label?: string;
  // The foreground command a window running it reports (detection).
  program?: string;
  // The full launch line (launch presets).
  command?: string;
  // The line that resumes it after the terminals restart ("claude --continue").
  resume?: string;
  // Appended for its no-prompts mode.
  skipPermissionsArgs?: string;
  // How core should write this agent's hooks: the file, the shape, and what
  // the CLI calls each event. See AgentHookDescriptor in agents.ts, and
  // docs/EXTENSION_API.md for the manifest form. Absent means core installs
  // no hooks for it.
  hooks?: unknown;
  // How to run this CLI for a single prompt - see AgentOneShot in agents.ts.
  // Declaring it makes this agent available as an AI provider for text jobs;
  // omitting it means the agent only ever runs in a pane.
  oneShot?: unknown;
  docsUrl?: string;
  // An image for the agent's row: an absolute URL, or a path inside this
  // extension (resolved to the extension's own file route, the same way its
  // manifest `icon` is). Falls back to `icon` below when absent.
  iconUrl?: string;
  // Fallback codicon name from the app's own icon set. Anything empty or
  // unknown renders a generic robot.
  icon?: string;
}

// The normalized, ordered form of a manifest's contributes.configuration —
// keys are the full dotted property name exactly as declared (no shared
// prefix is assumed). Sent to the client as-is so Settings can render
// controls without loading any extension code, and consumed server-side by
// getSettings() to know each property's default.
export interface ExtensionConfigurationProperty {
  key: string;
  type: "boolean" | "number" | "integer" | "string";
  // See ConfigurationProperty.format — only "ai-profile" is recognized by
  // the settings UI today; anything else falls back to a text box.
  format?: string;
  default: unknown;
  description: string;
  enum?: string[];
  enumItemLabels?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
}

export interface ExtensionConfigurationSection {
  title?: string;
  properties: ExtensionConfigurationProperty[];
}

const CONFIG_PROPERTY_TYPES = new Set(["boolean", "number", "integer", "string"]);

// Tolerant like the fonts normalization above: a malformed or unsupported
// (array/object type) property is skipped rather than failing the whole
// extension's manifest.
function normalizeConfiguration(
  configuration: ConfigurationContribution | ConfigurationContribution[] | undefined,
): ExtensionConfigurationSection[] {
  if (!configuration) return [];
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  const result: ExtensionConfigurationSection[] = [];
  for (const section of sections) {
    if (!section.properties || typeof section.properties !== "object") continue;
    const properties: ExtensionConfigurationProperty[] = [];
    for (const [key, prop] of Object.entries(section.properties)) {
      if (!prop || typeof prop.type !== "string" || !CONFIG_PROPERTY_TYPES.has(prop.type)) continue;
      properties.push({
        key,
        type: prop.type,
        format: typeof prop.format === "string" ? prop.format : undefined,
        default: prop.default,
        description: prop.description || prop.markdownDescription || "",
        enum: Array.isArray(prop.enum) ? prop.enum : undefined,
        enumItemLabels: Array.isArray(prop.enumItemLabels) ? prop.enumItemLabels : undefined,
        enumDescriptions: Array.isArray(prop.enumDescriptions) ? prop.enumDescriptions : undefined,
        minimum: typeof prop.minimum === "number" ? prop.minimum : undefined,
        maximum: typeof prop.maximum === "number" ? prop.maximum : undefined,
      });
    }
    if (properties.length > 0) result.push({ title: section.title, properties });
  }
  return result;
}

export interface ExtensionInfo {
  id: string;
  displayName: string;
  version: string;
  description: string;
  // Extension-relative path (see ExtensionManifest.icon), or null if the
  // manifest declares none — resolved by the client via extensionFileUrl,
  // same as clientEntry.
  icon: string | null;
  enabled: boolean;
  themes: { label: string; path: string }[];
  iconThemes: { id: string; label: string; path: string }[];
  fonts: { group: string; fonts: FontEntry[] }[];
  configuration: ExtensionConfigurationSection[];
  // Declared, not activated — lets the client resolve/list available
  // terminal engines (the Settings picker, and which one a session actually
  // needs) without running any extension's client code. See
  // TerminalEngineContribution.
  terminalEngines: { id: string; label: string }[];
  // Declared, not activated — same contract as terminalEngines above, for
  // the Settings editor picker and the client's per-capability resolution.
  // An entry declaring no recognized capability is dropped: it could never
  // be resolved for anything, so listing it would only offer the user a
  // choice that silently falls back to nvim.
  editors: { id: string; label: string; capabilities: EditorCapability[] }[];
  // Extension-relative path to the client ESM entry, or null if this
  // extension has no client contribution — the client dynamic-imports it
  // via extensionFileUrl(id, clientEntry). hasServer stays a plain boolean:
  // the client never needs the server entry's path, only whether calling
  // extensionApiBase(id) is worthwhile.
  clientEntry: string | null;
  hasClient: boolean;
  hasServer: boolean;
  // Shipped from the repo's extensions/ dir rather than user-installed —
  // see bundledExtensionsDir. Uninstalling one tombstones it in the state
  // file instead of deleting repo files (see uninstallExtension).
  builtin: boolean;
  // manifest perch.required, honored only for builtins: the server
  // refuses disable/uninstall and ignores stale state-file entries, and
  // the Extensions UI shows "Required" instead of those actions.
  required: boolean;
  // A builtin whose state entry is "uninstalled" — still listed (so it can
  // be reinstalled), but inactive: enabled is false, so nothing loads it.
  // Only ever true for builtins; a user extension is deleted outright.
  uninstalled: boolean;
}

function resolveId(manifest: ExtensionManifest, folder: string): string {
  if (manifest.publisher && manifest.name) {
    const candidate = `${manifest.publisher}.${manifest.name}`;
    if (isSafeId(candidate)) return candidate;
  }
  return folder;
}

// A builtin's state entry is "uninstalled" (tombstoned — repo files
// untouched, still listed but inactive/reinstallable) rather than deleted
// like a user extension's state key. true/false is the ordinary
// enabled/disabled toggle for either kind.
type ExtensionState = boolean | "uninstalled";

async function readState(): Promise<Record<string, ExtensionState>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFilePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, ExtensionState>)
      : {};
  } catch {
    return {};
  }
}

async function writeState(state: Record<string, ExtensionState>): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const tmp = `${stateFilePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, stateFilePath);
}

async function readManifest(folderPath: string): Promise<ExtensionManifest | null> {
  try {
    const raw = await readFile(path.join(folderPath, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as ExtensionManifest) : null;
  } catch {
    return null;
  }
}

async function listFoldersIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface DiscoveredExtension {
  folderPath: string;
  manifest: ExtensionManifest;
  builtin: boolean;
}

// Bundled extensions first, then user-installed ones layered on top by id —
// a user-dir extension always wins over a builtin with the same id, which
// is how installing a .perch restores or overrides a tombstoned builtin.
async function discoverExtensions(): Promise<Map<string, DiscoveredExtension>> {
  const found = new Map<string, DiscoveredExtension>();
  for (const folder of await listFoldersIn(bundledExtensionsDir)) {
    const folderPath = path.join(bundledExtensionsDir, folder);
    const manifest = await readManifest(folderPath);
    if (!manifest) continue;
    found.set(resolveId(manifest, folder), { folderPath, manifest, builtin: true });
  }
  for (const folder of await listFoldersIn(extensionsDir)) {
    const folderPath = path.join(extensionsDir, folder);
    const manifest = await readManifest(folderPath);
    if (!manifest) continue;
    found.set(resolveId(manifest, folder), { folderPath, manifest, builtin: false });
  }
  return found;
}

function isRequired(manifest: ExtensionManifest, builtin: boolean): boolean {
  return builtin && manifest.perch?.required === true;
}

function toInfo(
  manifest: ExtensionManifest,
  id: string,
  enabled: boolean,
  builtin: boolean,
  uninstalled = false,
): ExtensionInfo {
  return {
    id,
    displayName: manifest.displayName || manifest.name || id,
    version: manifest.version || "0.0.0",
    description: manifest.description || "",
    icon: typeof manifest.icon === "string" ? manifest.icon : null,
    enabled,
    themes: (manifest.contributes?.themes ?? []).map((t) => ({ label: t.label, path: t.path })),
    iconThemes: (manifest.contributes?.iconThemes ?? []).map((t) => ({
      id: t.id,
      label: t.label,
      path: t.path,
    })),
    fonts: (manifest.contributes?.fonts ?? [])
      .filter((g) => typeof g.group === "string" && g.group && Array.isArray(g.fonts))
      .map((g) => ({
        group: g.group,
        fonts: g.fonts
          .filter((f) => typeof f.family === "string" && f.family && Array.isArray(f.src) && f.src.length > 0)
          .map((f) => ({
            family: f.family,
            src: f.src,
            weight: f.weight,
            style: f.style,
            unicodeRange: f.unicodeRange,
          })),
      }))
      .filter((g) => g.fonts.length > 0),
    configuration: normalizeConfiguration(manifest.contributes?.configuration),
    terminalEngines: (manifest.contributes?.terminalEngines ?? [])
      .filter((e) => typeof e.id === "string" && e.id && typeof e.label === "string" && e.label)
      .map((e) => ({ id: e.id, label: e.label })),
    editors: (manifest.contributes?.editors ?? [])
      .filter((e) => typeof e.id === "string" && e.id && typeof e.label === "string" && e.label)
      .map((e) => ({
        id: e.id,
        label: e.label,
        capabilities: (Array.isArray(e.capabilities) ? e.capabilities : []).filter((c): c is EditorCapability =>
          EDITOR_CAPABILITIES.includes(c),
        ),
      }))
      .filter((e) => e.capabilities.length > 0),
    clientEntry: manifest.perch?.client ?? null,
    hasClient: Boolean(manifest.perch?.client),
    hasServer: Boolean(manifest.perch?.server),
    builtin,
    required: isRequired(manifest, builtin),
    uninstalled,
  };
}

export async function listExtensions(): Promise<ExtensionInfo[]> {
  const state = await readState();
  const results: ExtensionInfo[] = [];
  for (const [id, { manifest, builtin }] of await discoverExtensions()) {
    // A required builtin ignores whatever the state file says (a stale
    // tombstone or `false` from before the flag existed must not ship the
    // app without its rendering floor) — always listed, always enabled.
    if (isRequired(manifest, builtin)) {
      results.push(toInfo(manifest, id, true, builtin));
      continue;
    }
    // A tombstoned builtin stays in the list (so it can be reinstalled) but
    // inactive: enabled=false keeps everything that keys off `enabled`
    // (client activation, server hooks, theme/font loading) from touching it,
    // while `uninstalled` drives the UI's Reinstall action.
    if (builtin && state[id] === "uninstalled") {
      results.push(toInfo(manifest, id, false, builtin, true));
      continue;
    }
    // A freshly dropped-in or installed extension is active by default;
    // only an explicit `false` in the state file turns it off.
    results.push(toInfo(manifest, id, state[id] !== false, builtin));
  }
  return results;
}

async function findExtensionFolder(id: string): Promise<DiscoveredExtension | null> {
  return (await discoverExtensions()).get(id) ?? null;
}

// Resolves an extension-relative path (theme JSON, icon font, client/server
// entry) to an absolute path, rejecting traversal outside the extension's
// own folder.
export async function resolveExtensionFile(id: string, relPath: string): Promise<string | null> {
  const found = await findExtensionFolder(id);
  if (!found) return null;
  if (path.isAbsolute(relPath)) return null;
  const resolved = path.resolve(found.folderPath, relPath);
  const base = path.resolve(found.folderPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// packagePath is a temp file (already written by the caller); this consumes
// and removes it either way.
export async function installFromPackageFile(packagePath: string): Promise<ExtensionInfo> {
  const workDir = path.join(tmpdir(), `perch-ext-${randomUUID()}`);
  try {
    await mkdir(workDir, { recursive: true });
    await extractZip(packagePath, workDir);
    // A .perch is a zip with the extension's actual contents under extension/.
    const extractedRoot = path.join(workDir, "extension");
    const manifest = await readManifest(extractedRoot);
    if (!manifest) throw new Error("invalid extension: missing extension/package.json");
    if (!manifest.name) throw new Error('invalid extension: package.json is missing "name"');

    const folder = isSafeId(manifest.name) ? manifest.name : `ext-${randomUUID().slice(0, 8)}`;
    await mkdir(extensionsDir, { recursive: true });
    const dest = path.join(extensionsDir, folder);
    await rm(dest, { recursive: true, force: true });
    // Not a rename: the OS temp dir and ~/.config commonly live on
    // different filesystems/devices (containers, separate /tmp mounts), and
    // fs.rename() across devices fails with EXDEV. cp() copies across any
    // boundary; the whole workDir (including extractedRoot) is removed in
    // the finally block below either way.
    await cp(extractedRoot, dest, { recursive: true });

    const id = resolveId(manifest, folder);
    const state = await readState();
    state[id] = true;
    await writeState(state);

    // Install enables the extension (state[id] = true above), so its server
    // hook must mount now too — before this, an installed extension's
    // routes 404'd until a disable/enable round trip or a server restart
    // (unnoticed until ai-command, the first .perch with a server entry).
    // Re-installing over an already-mounted version keeps the OLD hook (the
    // imported module can't be re-imported anyway — see unmountServerHook's
    // module comment) — a restart picks up the new server.js, same as any
    // server-side code change.
    await mountServerHookIfNeeded(id, dest, manifest);

    const info = (await listExtensions()).find((e) => e.id === id);
    if (!info) throw new Error("extension installed but could not be read back");
    return info;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(packagePath, { force: true }).catch(() => {});
  }
}

export async function uninstallExtension(id: string): Promise<void> {
  const found = await findExtensionFolder(id);
  if (!found) throw new Error("extension not found");
  if (isRequired(found.manifest, found.builtin)) {
    throw new Error("this extension is required and cannot be uninstalled");
  }
  unmountServerHook(id);
  const state = await readState();
  if (found.builtin) {
    // Tombstone rather than delete repo files — a future .perch install with
    // the same id overrides this entry (discoverExtensions layers user-dir
    // extensions on top of builtins) and restores it.
    state[id] = "uninstalled";
  } else {
    await rm(found.folderPath, { recursive: true, force: true });
    delete state[id];
    // Only on this branch. A builtin's "uninstall" above is a reversible
    // tombstone — its files never leave and the UI offers Reinstall — so
    // wiping its credentials would make an undoable action partly
    // un-undoable. Here the folder is actually gone, and leaving a live
    // credential behind for it has no upside.
    await clearExtensionSecrets(id);
  }
  await writeState(state);
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionInfo> {
  const found = await findExtensionFolder(id);
  if (!found) throw new Error("extension not found");
  if (isRequired(found.manifest, found.builtin) && !enabled) {
    throw new Error("this extension is required and cannot be disabled");
  }
  const state = await readState();
  state[id] = enabled;
  await writeState(state);

  if (enabled) {
    await mountServerHookIfNeeded(id, found.folderPath, found.manifest);
  } else {
    unmountServerHook(id);
  }

  return toInfo(found.manifest, id, enabled, found.builtin);
}

// ---- Server hooks ----
// Mounted routers, keyed by extension id — present only while the
// extension's server hook is active. Disabling/uninstalling deletes the
// entry so requests 404 immediately; the imported module itself stays
// resident in the process until restart (ESM has no unload).
const serverHooks = new Map<string, Router>();

// host.events.onApiMutation subscriptions, keyed by extension id so
// unmountServerHook can drop exactly this extension's callbacks — the
// module itself stays resident (no ESM unload), so without this a disabled
// extension's listener would keep firing into dead code.
const apiMutationListeners = new Map<string, Set<() => void>>();

// Terminal engines an extension registered, undone when its hook unmounts.
const engineRegistrations = new Map<string, Set<() => void>>();

// Fired by api.ts's post-mutation middleware after any non-GET/HEAD core
// API call finishes — the extension-facing generalization of the same
// "something on disk probably changed" signal the core git cache used to
// consume via invalidateGitCache.
export function emitApiMutation(): void {
  for (const set of apiMutationListeners.values()) {
    for (const cb of set) {
      try {
        cb();
      } catch (err) {
        console.error("extension onApiMutation listener threw:", err);
      }
    }
  }
}

// Curated core services handed to extension server entries — the only
// sanctioned way an extension reaches core state (never by importing core
// modules, which would bypass enable/disable and version accounting).
export interface ExtensionHostApi {
  ports: {
    // See ports.ts — listening ports attributed to terminals (the tunnel security
    // gate's own data source, shared rather than re-scanned).
    list: typeof listTerminalPorts;
    find: typeof findTerminalPort;
  };
  events: {
    // Fires after any mutating (non-GET/HEAD) core API call completes.
    // Returns an unsubscribe; all of an extension's subscriptions are also
    // dropped when its server hook unmounts.
    onApiMutation(cb: () => void): () => void;
  };
  // The agent registry (agents.ts) — the one list of AI agents the user has
  // configured, so an extension that needs to find an agent pane or offer an
  // agent to launch stops carrying its own copy of "what is an agent". Each
  // entry's `program` is the window's foreground command while it runs
  // (detection) and `command` is the line that starts it (launch presets).
  // Enabled entries only, in the user's own order.
  agents: {
    list(): Promise<AgentSummary[]>;
    // Which agent is running in a terminal, and which process it is:
    // matched by the window's foreground command, else by a descendant
    // process named after an agent's `program`, so an agent behind a
    // wrapper (or under a shell prompt) is still found. Works whichever
    // terminal backend runs the window. `agentPid` is for reading the files
    // an agent keeps about itself, never for signalling it; it is null only
    // when the host reports no process list. null / an empty array for a
    // session that isn't there.
    forWindow(session: string, windowIndex: number): Promise<AgentWindow | null>;
    forSession(session: string): Promise<AgentWindow[]>;
    // The line that starts one enabled agent (ids are `<extensionId>.<agentId>`),
    // with the user's global Yolo/Manual choice (Settings → AI Providers)
    // already applied: `skipPermissionsArgs` is appended only under Yolo. The
    // same rule the client-side launch presets apply, kept in core so a
    // launcher with no browser connected never has to re-derive it. null for
    // an unknown or disabled id, or an agent with no launch command.
    launchCommand(id: string): Promise<string | null>;
  };
  // Terminal sessions (terminals.ts) - the same functions behind core's /api/sessions
  // routes, so a server hook can start and drive a session from a timer with
  // no client connected. Nothing here asks for confirmation: kill() kills.
  // Incoming `cwd` may be `~`-shortened and is expanded here; session paths
  // on the way out are `~`-shortened, exactly as GET /api/sessions returns
  // them.
  sessions: {
    list(): Promise<TerminalSession[]>;
    // Named after its folder when `name` is omitted. Starts at the git root
    // containing `cwd` unless `exactCwd`.
    create(name?: string, cwd?: string, exactCwd?: boolean): Promise<TerminalSession>;
    // Returns the new window's index. Without `cwd`, the session's own path.
    // A `name` is kept as given; without one the window is named after what
    // runs in it.
    createWindow(session: string, cwd?: string, name?: string): Promise<number>;
    // Makes a window the session's current one.
    selectWindow(session: string, index: number): Promise<void>;
    // Types `text` literally into the session's window, then Enter when
    // `submit`. Without `windowIndex` it targets the session's current window,
    // which is whichever last had focus.
    sendText(session: string, text: string, submit: boolean, windowIndex?: number): Promise<void>;
    // The same, addressed by window id ($PERCH_WINDOW inside the window,
    // or a pane's `id` from listPanes) — stable across renumbering.
    sendTextToWindow(windowId: string, text: string, submit: boolean): Promise<void>;
    // Idempotent: a session that is already gone is not an error.
    kill(name: string): Promise<void>;
    // One entry per window (a window is one terminal), with its stable window
    // id as `id` and what's running in it as `command`.
    listPanes(session: string): Promise<SessionPane[]>;
    // The window's screen as plain text: its visible rows, plus
    // `opts.scrollback` history lines above them. One string per row joined
    // with "\n", trailing blank rows dropped. Rejects when the window is gone
    // or the terminal backend cannot read screens.
    capture(windowId: string, opts?: { scrollback?: number; styles?: boolean }): Promise<string>;
  };
  // Web push to every browser that subscribed in Settings (push.ts). Rate
  // limited per window: a second push for the same window within a few
  // seconds is dropped. Resolves quietly when no browser ever subscribed.
  notifications: {
    push(notification: { title: string; body: string; windowId: string }): Promise<void>;
  };
  // git worktrees (gitWorktrees.ts), the functions behind core's
  // /api/git/worktrees routes. `cwd`/`path` may be `~`-shortened and are
  // expanded here; paths on the way out are absolute. create/remove reject
  // with an error carrying a `status` (400/404/409) for refusals.
  worktrees: {
    list(dir: string, opts?: { dirty?: boolean; branches?: boolean }): Promise<WorktreeListing>;
    // mode "new" branches off `base` (default HEAD); `location` is a template
    // over {repo} and {branch}, default "{repo}/.worktrees/{branch}".
    create(opts: {
      cwd: string;
      branch: string;
      base?: string;
      mode: "new" | "existing";
      location?: string;
    }): Promise<{ path: string; branch: string }>;
    // Removes the checkout, keeping the branch. Never the main worktree.
    remove(opts: { cwd: string; path: string; force?: boolean }): Promise<{ removed: string }>;
  };
  // Core's agent-hook pipeline (agentHooks.ts): an AI agent's own hooks
  // report to one core endpoint, and core normalizes each event and fans it
  // out here. An extension no longer ships a snippet, a schema or a route of
  // its own — all three are core's, surfaced in Settings → AI Providers.
  //
  // Events are named in core's own vocabulary ("stop", "permission", …) so a
  // subscriber never learns which CLI it is talking to. `paneId` is the
  // correlation key — it is the one identifier every agent's hook can supply
  // — and `sessionName` is core's resolution of it. An event core cannot map
  // arrives with `event: null` and its `rawEvent` intact rather than being
  // guessed at or dropped.
  //
  // tool-start / tool-end only arrive once the user has turned on
  // per-tool-call hooks in Settings → AI Providers; a subscriber that wants them
  // must keep working without them.
  agentHooks: {
    // Returns an unsubscribe. All of an extension's subscriptions are also
    // dropped when its server hook unmounts.
    subscribe(sub: AgentHookSubscription): () => void;
    // For an agent THIS extension contributed whose descriptor names a
    // `companion` file: a transform run after core writes that agent's hooks,
    // taking the companion file's current text and returning what it should
    // become. Core does the reading and the writing, under the same backup and
    // temp-then-rename rules as the hook file.
    //
    // `agentId` is the bare id from the manifest; core namespaces it. A
    // transform that throws, hangs or returns something too large is logged
    // and skipped - the hooks are already installed by then, so it never
    // fails the install. Registering one for an agent this extension did not
    // contribute does nothing.
    provideCompanion(agentId: string, transform: AgentCompanionTransform): void;
  };
  // The app's shared AI backend (ai.ts) — prompt in, text out, using whatever
  // provider is configured in Settings → AI Providers. An extension supplies the prompt
  // and never sees a provider, a binary or an API key. Rejects with an AiError
  // whose `code` distinguishes "not configured yet" from "the provider broke",
  // so an extension can surface the first as guidance.
  ai: {
    // opts.profileId names one of listProfiles()'s entries; omitted, the
    // user's default profile answers.
    run(prompt: string, opts?: AiRunOptions): Promise<string>;
    // The AIs the user has configured and enabled, so an extension can let
    // them choose one for its own feature. Prefer declaring a manifest
    // property with "format": "ai-profile" — the settings UI renders the
    // picker for it — and pass the stored id as opts.profileId.
    listProfiles(): Promise<AiProfileSummary[]>;
  };
  // Terminal engines: another implementation of the multiplexer interface
  // (server/src/multiplexer.ts) the user can pick in Settings -> Terminal.
  // The choice takes effect on the next server start; `create` runs the first
  // time the engine is needed. An engine is dropped when the extension's hook
  // unmounts, and a server on it falls back to the bundled daemon then.
  terminalEngines: {
    register(engine: EngineRegistration): () => void;
  };
  // This extension's own credential store (settingsStore.ts's
  // extensionSecrets), scoped to its id. A manifest configuration property is
  // the wrong home for a credential: it lands in the settings document, which
  // the client GETs, merges and PUTs back whole. These values are stripped
  // from GET /api/settings and no document write can reach them, so they
  // never leave the server. Core deliberately serves no route for them — an
  // extension that wants a browser-facing field defines its own route on its
  // own router and calls set() from there.
  secrets: {
    // The stored value, or null when there is none.
    get(name: string): Promise<string | null>;
    // A null or blank value clears the name.
    set(name: string, value: string | null): Promise<void>;
    // Names only, never values — the shape a "set"/"not set" UI needs, and
    // the one that is safe to forward to a client.
    list(): Promise<string[]>;
  };
}

function makeHostApi(id: string): ExtensionHostApi {
  return {
    ports: { list: listTerminalPorts, find: findTerminalPort },
    agents: {
      list: () => listAgents(),
      launchCommand: (agentId) => launchCommand(agentId),
      forWindow: (session, windowIndex) => agentForWindow(session, windowIndex),
      forSession: (session) => agentsForSession(session),
    },
    sessions: {
      list: () => listSessions(),
      // Core's own routes drop the ≤500ms session-listing cache after any
      // mutating request; a call from a timer has no request, so do it here.
      create: async (name, cwd, exactCwd = false) => {
        try {
          return await createSession(name, cwd ? expandHome(cwd) : undefined, exactCwd);
        } finally {
          invalidateSessionsCache();
        }
      },
      createWindow: async (session, cwd, name) => {
        try {
          return await createWindow(session, cwd ? expandHome(cwd) : undefined, name);
        } finally {
          invalidateSessionsCache();
        }
      },
      selectWindow: (session, index) => selectWindow(session, index),
      sendText: (session, text, submit, windowIndex) => sendTextToSession(session, text, submit, windowIndex),
      sendTextToWindow: (windowId, text, submit) => sendTextToWindow(windowId, text, submit),
      kill: async (name) => {
        try {
          await killSession(name);
        } finally {
          invalidateSessionsCache();
        }
      },
      listPanes: (session) => listSessionPanes(session),
      capture: (windowId, opts) => captureWindow(windowId, opts?.scrollback ?? 0, opts?.styles === true),
    },
    notifications: {
      push: ({ title, body, windowId }) => notifyExtension(String(windowId), String(title), String(body)),
    },
    worktrees: {
      list: (dir, opts) => listWorktrees(expandHome(dir), opts),
      create: (opts) => createWorktree({ ...opts, cwd: expandHome(opts.cwd) }),
      remove: (opts) => removeWorktree({ ...opts, cwd: expandHome(opts.cwd), path: expandHome(opts.path) }),
    },
    agentHooks: {
      subscribe: (sub) => subscribeAgentHooks(id, sub),
      provideCompanion: (agentId, transform) => registerAgentCompanion(`${id}.${agentId}`, transform),
    },
    ai: { run: (prompt, opts) => runAi(prompt, opts), listProfiles: () => listAiProfiles() },
    secrets: {
      get: (name) => readExtensionSecret(id, name),
      set: (name, value) => writeExtensionSecret(id, name, value),
      list: () => listExtensionSecretNames(id),
    },
    terminalEngines: {
      register(engine) {
        const undo = registerEngine(engine);
        let set = engineRegistrations.get(id);
        if (!set) {
          set = new Set();
          engineRegistrations.set(id, set);
        }
        set.add(undo);
        return () => {
          set.delete(undo);
          undo();
        };
      },
    },
    events: {
      onApiMutation(cb) {
        let set = apiMutationListeners.get(id);
        if (!set) {
          set = new Set();
          apiMutationListeners.set(id, set);
        }
        set.add(cb);
        return () => set.delete(cb);
      },
    },
  };
}

// contributes.agents from every ENABLED extension, in the shape the registry
// wants. Disabled extensions contribute nothing, for the same reason their
// settings are not in effect. Ids are namespaced with the contributing
// extension so two extensions cannot collide on "claude", and a hook flavour
// outside the three core knows is dropped to null rather than trusted.
// An absolute URL is used as given; anything else is read as a path inside
// the contributing extension and served through its own file route.
function contributedIconUrl(extensionId: string, raw: string): string {
  if (!raw) return "";
  if (/^https?:\/\//.test(raw) || raw.startsWith("data:")) return raw;
  const relative = raw.replace(/^\.?\//, "");
  return `/api/extensions/${encodeURIComponent(extensionId)}/file/${relative}`;
}

async function contributedAgents(): Promise<AgentPreset[]> {
  const out: AgentPreset[] = [];
  for (const ext of await listExtensions()) {
    if (!ext.enabled) continue;
    const found = await findExtensionFolder(ext.id);
    const declared = found?.manifest.contributes?.agents;
    if (!Array.isArray(declared)) continue;
    for (const raw of declared) {
      const id = typeof raw?.id === "string" ? raw.id.trim() : "";
      const program = typeof raw?.program === "string" ? raw.program.trim() : "";
      const command = typeof raw?.command === "string" ? raw.command.trim() : "";
      // Same floor the settings document's own entries have to clear: an
      // entry that can neither be detected nor launched is not an agent.
      if (!id || (!program && !command)) continue;
      // A descriptor core can act on, or null. Parsed by agents.ts because
      // it is agents.ts that writes the file it names — including the check
      // that the path stays inside $HOME. A malformed one costs the agent its
      // hooks, not its row: it is still a usable detection and launch preset.
      const hooks = parseHookDescriptor(raw?.hooks);
      if (raw?.hooks !== undefined && hooks === null) {
        console.warn(`extension ${ext.id}: agent "${id}" has an unusable hooks descriptor - ignoring it`);
      }
      out.push({
        id: `${ext.id}.${id}`,
        label: (typeof raw?.label === "string" && raw.label.trim()) || program || command,
        program,
        command,
        skipPermissionsArgs:
          typeof raw?.skipPermissionsArgs === "string" ? raw.skipPermissionsArgs.trim() : "",
        resume: typeof raw?.resume === "string" ? raw.resume.trim() : "",
        hooks,
        // How to run this CLI for one-shot text (ai.ts). Absent means this
        // agent is not offered as a text provider at all.
        oneShot: parseOneShot(raw?.oneShot),
        docsUrl: typeof raw?.docsUrl === "string" ? raw.docsUrl.trim() : "",
        // An extension-relative path becomes a URL here rather than in the
        // client: whoever renders a row should not have to know which
        // extension an agent came from to find its picture.
        iconUrl: contributedIconUrl(ext.id, typeof raw?.iconUrl === "string" ? raw.iconUrl.trim() : ""),
        icon: (typeof raw?.icon === "string" && raw.icon.trim()) || DEFAULT_AGENT_ICON,
        enabled: true,
        contributedBy: ext.id,
      });
    }
  }
  return out;
}

// Installed once, at import: agents.ts owns the registry but cannot import
// this module (the host API here already depends on it), so it takes its
// contributed entries through this hook instead.
setContributedAgentsSource(contributedAgents);

export function getServerHookRouter(id: string): Router | undefined {
  return serverHooks.get(id);
}

export function extensionHookMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = req.params.extId;
  const router = serverHooks.get(id);
  if (!router) {
    res.status(404).json({ error: "extension not found or has no active server hook" });
    return;
  }
  runExtensionRouter(id, router, req, res, next);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Manifest defaults (from contributes.configuration) overridden by the
// user's stored extensionSettings[id], scoped to this extension only — see
// the client-side ExtensionSettingsValues shape in client/src/settings.ts,
// which this mirrors. Read fresh on every call rather than cached: the file
// read is cheap and avoids cache-invalidation plumbing for a value that only
// changes when the user edits Settings.
async function getExtensionSettings(id: string, manifest: ExtensionManifest): Promise<Record<string, unknown>> {
  const defaults: Record<string, unknown> = {};
  for (const section of normalizeConfiguration(manifest.contributes?.configuration)) {
    for (const prop of section.properties) defaults[prop.key] = prop.default;
  }
  const doc = await readSettingsDoc();
  const allOverrides = doc.extensionSettings;
  const overrides =
    isPlainObject(allOverrides) && isPlainObject(allOverrides[id])
      ? (allOverrides[id] as Record<string, unknown>)
      : {};
  return { ...defaults, ...overrides };
}

export async function mountServerHookIfNeeded(
  id: string,
  folderPath: string,
  manifest: ExtensionManifest,
): Promise<void> {
  if (serverHooks.has(id)) return;
  const serverEntry = manifest.perch?.server;
  if (!serverEntry) return;
  try {
    const entryPath = path.resolve(folderPath, serverEntry);
    const mod: unknown = await import(pathToFileURL(entryPath).href);
    const activate = (mod as { activate?: unknown }).activate;
    if (typeof activate !== "function") {
      console.error(`extension ${id}: server entry has no activate() export`);
      return;
    }
    const router = createExtensionRouter();
    const host = makeHostApi(id);
    activate({
      router,
      log: (...args: unknown[]) => console.log(`[ext:${id}]`, ...args),
      getSettings: () => getExtensionSettings(id, manifest),
      // Also on `host`, but lifted to the top level because it is the one
      // capability most extensions reach for by name — activate({ ai }).
      ai: {
        run: (prompt: string, opts?: AiRunOptions) => runAi(prompt, opts),
        listProfiles: (): Promise<AiProfileSummary[]> => listAiProfiles(),
      },
      // Lifted for the same reason as `ai` — an extension holding a
      // credential reaches for it by name: activate({ secrets }).
      secrets: host.secrets,
      host,
    });
    serverHooks.set(id, router);
    // Only after activate() returned - see extensionLifecycle.ts.
    recordServerDeactivate(id, mod);
  } catch (err) {
    console.error(`extension ${id}: failed to load server hook:`, err);
  }
}

export function unmountServerHook(id: string): void {
  serverHooks.delete(id);
  apiMutationListeners.delete(id);
  for (const undo of engineRegistrations.get(id) ?? []) undo();
  engineRegistrations.delete(id);
  dropAgentHookSubscriptions(id);
  dropAgentCompanions(id);
  // Last, so the extension tears down after its routes and subscriptions are
  // already gone and nothing new can reach it mid-teardown.
  runServerDeactivate(id);
}

export async function loadEnabledServerHooks(): Promise<void> {
  for (const ext of await listExtensions()) {
    if (!ext.enabled || !ext.hasServer) continue;
    const found = await findExtensionFolder(ext.id);
    if (found) await mountServerHookIfNeeded(ext.id, found.folderPath, found.manifest);
  }
}
