import type {
  ExtensionInfo,
  FsFilesListing,
  FsGitRoot,
  FsListing,
  RegistrySourceResult,
  TerminalSession,
  WorktreeLookup,
} from "./types";
import { formatMb } from "./formatSize";

// Carries the HTTP status alongside the server's error message so a caller
// can distinguish a specific failure (e.g. 404 "the window is already gone")
// from any other — see openWindowTab's use of this for a vanished window.
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new ApiError(message, res.status);
  }
  // Check the body itself, not just status === 204: any success response can
  // legitimately have an empty body (e.g. a plain res.end()), and res.json()
  // throws a SyntaxError on empty text that silently aborts the caller.
  const text = await res.text();
  return text ? JSON.parse(text) : (undefined as T);
}

export function fetchSessions(): Promise<TerminalSession[]> {
  return request("/api/sessions");
}

export function createSession(name?: string, cwd?: string, exactCwd?: boolean): Promise<TerminalSession> {
  return request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, cwd: cwd || undefined, exactCwd: exactCwd || undefined }),
  });
}

// The server-persisted settings document (~/.config/perch/settings.json).
// Schema is client-owned: settings.ts fields + keybindings.ts overrides +
// extensionSettings.ts overrides. The index signature lets a save preserve
// any top-level key this client build doesn't know about yet (see App.tsx's
// read-merge-write save) — the server itself stays schema-oblivious.
export interface SettingsDoc {
  settings?: unknown;
  // unknown, not KeybindingOverrides: an older client may have written the
  // pre-multi-binding shape (command id → single combo string) — the reader
  // runs it through migrateKeybindingOverrides before trusting the shape.
  keybindings?: unknown;
  extensionSettings?: unknown;
  pinnedSessions?: unknown;
  [key: string]: unknown;
}

export function fetchSettingsDoc(): Promise<SettingsDoc> {
  return request("/api/settings");
}

export function putSettingsDoc(doc: SettingsDoc): Promise<void> {
  return request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
}

// The agent registry as the server resolves it: enabled entries only, in the
// user's own order, seeded with the defaults for a profile that has never
// stored the list (server/src/agents.ts). The same list extensions read
// through GET /api/agents or host.agents.list(), so anything asking core
// "which agents are there" gets one answer.
//
// Settings → AI Providers edits the list through the settings document like any
// other core setting, not through this call — there is no write route.
export interface AgentSummaryDto {
  id: string;
  label: string;
  // the foreground command a window running this agent reports (detection).
  program: string;
  // The full launch line (launch presets).
  command: string;
  // Which hook schema the CLI speaks, or null for one core cannot hook.
  hooks: "claude" | "codex" | "agy" | null;
  // The agent's own mark, resolved to a loadable URL, with a codicon name as
  // the fallback.
  iconUrl: string;
  icon: string;
}

export function fetchAgents(): Promise<{ agents: AgentSummaryDto[] }> {
  return request("/api/agents");
}

// Which agent runs in which terminal window — see server/src/agentWindows.ts.
// Backs ctx.app.agentForWindow/agentForSession for extensions with no server
// hook of their own.
export interface AgentWindowDto {
  agentId: string;
  label: string;
  program: string;
  // The agent's own mark: a URL a client can load, with a codicon name as
  // the fallback.
  iconUrl: string;
  icon: string;
  windowIndex: number;
  windowId: string;
  windowPid: number;
  agentPid: number | null;
  cwd: string | null;
  matchedBy: "foreground" | "descendant";
}

export function fetchAgentWindows(session: string, windowIndex?: number): Promise<{ windows: AgentWindowDto[] }> {
  const window = windowIndex === undefined ? "" : `&window=${windowIndex}`;
  return request(`/api/agents/windows?session=${encodeURIComponent(session)}${window}`);
}

// Agent hooks: what core would install for each agent, what is actually in
// that agent's own config file right now, and which extensions asked for it.
// Settings → AI Providers shows all of it, so "why does this say stale" is
// answerable there (see server/src/agents.ts's writer).
export interface AgentHookSnippetDto {
  // Absolute path of the file the snippet belongs in.
  file: string;
  // "merged" - the file holds other things and core only adds its own part.
  // "whole-file" - the snippet IS the file, so pasting it over an existing
  // one would discard what was there.
  ownership: "merged" | "whole-file";
  text: string;
  rawEvents: string[];
}

export interface AgentHookStateDto {
  agentId: string;
  label: string;
  // The launch line, shown under the agent's name the way a terminal would
  // spell it.
  command: string;
  skipPermissionsArgs: string;
  // Where to read about this agent, or how to install it. Empty hides the
  // row's external link.
  docsUrl: string;
  // An image for the row, already resolved to a URL this client can load
  // (the app's own, or a contributing extension's file route). Empty falls
  // back to `icon`.
  iconUrl: string;
  // Fallback codicon name; a generic robot when unknown.
  icon: string;
  enabled: boolean;
  // The extension that contributed this agent, or "" for one the app ships
  // or the user wrote. A contributed agent is not editable here.
  contributedBy: string;
  // Whether its CLI is on the machine. A row that is not installed is dimmed
  // and its Enabled control disabled - the link is the only useful action.
  installed: boolean;
  state: "unsupported" | "not-installed" | "installed" | "stale";
  file: string | null;
  ownership: "merged" | "whole-file" | null;
  // Event names as the agent itself spells them (SessionStart, Stop).
  installedEvents: string[];
  wantedEvents: string[];
  // One sentence the user can act on, when state is "stale".
  staleReason: string | null;
  // The config file exists but could not be read as JSON: nothing has been
  // written to it and nothing will be until it is fixed.
  error: string | null;
  snippet: AgentHookSnippetDto | null;
}

export interface AgentHooksDto {
  // The normalized events core would install right now: the union of what
  // enabled extensions asked for, minus the per-tool-call ones while that
  // setting is off.
  events: string[];
  subscribers: { extensionId: string; events: string[] }[];
  agents: AgentHookStateDto[];
}

export function fetchAgentHooks(): Promise<AgentHooksDto> {
  return request("/api/agent-hooks");
}

export interface AgentHookWriteResult {
  state: AgentHookStateDto;
  // Where the previous contents were kept, when there were any.
  backup: string | null;
}

// Both write into a file core does not own, so both are only ever called
// from a button the user pressed.
export function installAgentHooks(agentId: string): Promise<AgentHookWriteResult> {
  return request("/api/agent-hooks/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
}

export function uninstallAgentHooks(agentId: string): Promise<AgentHookWriteResult> {
  return request("/api/agent-hooks/uninstall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
}

// AI provider keys. Deliberately not part of the settings document: the
// server never hands a key back, so the client can only learn WHICH
// providers have one (getAiKeyStatus) and set or clear one (setAiKey).
// See server/src/settingsStore.ts's module comment.
export interface AiKeyStatus {
  // Pre-profiles provider-keyed entries, still read at call time.
  anthropic: boolean;
  openai: boolean;
  // Every id that has a stored key — profile ids and those two alike.
  has?: Record<string, boolean>;
}

export function getAiKeyStatus(): Promise<AiKeyStatus> {
  return request("/api/ai-key");
}

export interface AiModelOption {
  id: string;
  label?: string;
}

// The models a profile's own endpoint offers (Anthropic's or OpenAI's
// /models route, against whatever base URL the profile points at). Rejects
// with an ApiError whose message is already user-facing — including "this
// provider is a command, not an API".
export function getAiModels(profileId: string): Promise<{ models: AiModelOption[] }> {
  return request(`/api/ai-models?profileId=${encodeURIComponent(profileId)}`);
}

// provider id → whether that CLI is on the server's PATH. Settings → AI Providers
// greys out the ones that aren't, so a provider that could only fail isn't
// offered as if it would work.
export function getAiCliStatus(): Promise<Record<string, boolean>> {
  return request("/api/ai-cli");
}

// The agents offered when starting something in a new session - the New
// Worktree form's picker. The app's own Yolo/Manual choice is applied here so
// the caller launches `command` as given: the same rule the shared extension
// helper follows, so a worktree started from the form and one started from a
// "Start work" button run the same line.
export interface AgentLaunchOption {
  name: string;
  command: string;
}

export async function fetchAgentLaunchOptions(): Promise<AgentLaunchOption[]> {
  const body = await request<{
    agents?: { label?: string; command?: string; skipPermissionsArgs?: string }[];
    skipPermissions?: boolean;
  }>("/api/agents");
  const skip = body.skipPermissions === true;
  return (body.agents ?? [])
    .filter((a) => (a.command ?? "") !== "")
    .map((a) => {
      const command = a.command as string;
      const args = a.skipPermissionsArgs ?? "";
      return {
        name: a.label || command,
        command: skip && args ? `${command} ${args}` : command,
      };
    });
}

// Every AI a job may be pointed at: the stored API providers plus one per
// agent that can answer a single prompt. The settings document holds only the
// first kind, so this is the one place the full list exists.
export interface AiProfileOption {
  id: string;
  label: string;
  // One of the API kinds, or the id of the agent this profile runs. Only used
  // to decide whether a model list can be fetched for it.
  provider: string;
  model: string;
  // The binary a CLI one runs ("codex"), which is not its provider id
  // ("perch.agents.codex"). Empty for an API provider.
  program: string;
  // Which one answers when a caller names no profile at all.
  isDefault: boolean;
}

// Where terminals run: the bundled daemon or an engine an extension provides
// (the tmux backend, say). `selected` is the saved choice, `active` the one this server runs on;
// they differ until the server restarts, or when the chosen one is missing.
export interface TerminalBackendOption {
  id: string;
  label: string;
  description: string;
  selected: boolean;
  active: boolean;
}

export async function fetchTerminalBackends(): Promise<TerminalBackendOption[]> {
  const body = await request<{ engines?: TerminalBackendOption[] }>("/api/terminal-engines");
  return body.engines ?? [];
}

export async function fetchAiProfiles(): Promise<AiProfileOption[]> {
  const body = await request<{ profiles?: AiProfileOption[] }>("/api/ai-profiles");
  return body.profiles ?? [];
}

// An empty `key` clears the stored one. `profileId` is an AI profile's id
// (Settings → AI Providers).
export function setAiKey(profileId: string, key: string): Promise<void> {
  return request("/api/ai-key", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId, key }),
  });
}

// Deep-merges `patch` over the server's on-disk document instead of
// replacing it outright (see server/src/settingsStore.ts's mergeSettingsDoc)
// — for a caller that wants to write just the keys it's changing without
// first fetching and reassembling the whole document itself.
export function patchSettingsDoc(patch: SettingsDoc): Promise<void> {
  return request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// ---- Settings bundles ----
//
// The shareable slice of the settings document plus the sharer's extension
// list, as one file another install can import. The server builds and applies
// it (server/src/settingsBundle.ts) so the list of what travels lives in one
// place; the client's job is to move the file and to ask before applying it.

// Opaque on purpose: the client never picks the bundle apart, it hands it
// straight back to preview and apply.
export type SettingsBundle = Record<string, unknown>;

export interface BundleExtensionRow {
  id: string;
  version: string;
  source: string | null;
  installed: boolean;
  // False when no source was recorded for this extension, or the recorded one
  // isn't configured here. `reason` says which, for the row to show.
  installable: boolean;
  reason?: string;
}

export interface BundleSummary {
  exportedAt: string;
  categories: { key: string; label: string; count: number }[];
  extensions: BundleExtensionRow[];
}

export interface BundleInstallResult {
  id: string;
  ok: boolean;
  error?: string;
}

export function fetchSettingsBundle(): Promise<SettingsBundle> {
  return request("/api/settings/bundle");
}

// Read-only: says what the bundle would contribute and which extensions could
// be installed, changing nothing.
export function previewSettingsBundle(bundle: SettingsBundle): Promise<BundleSummary> {
  return request("/api/settings/bundle/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bundle),
  });
}

export function applySettingsBundle(
  bundle: SettingsBundle,
  extensionIds: string[],
): Promise<{ extensions: BundleInstallResult[] }> {
  return request("/api/settings/bundle/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle, extensions: extensionIds }),
  });
}

export function killSession(name: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// Types text into a session's pane, optionally submitting it. Core's own
// callers use this directly; extensions hit the same public route with a
// plain fetch instead (see docs/EXTENSION_API.md) rather than importing
// client code across the extension boundary. windowIndex targets a specific
// window within the session — omit it only when the session is known to
// have just one window (e.g. one just created), since omitting it targets
// the session's own "current" (last-focused) window, not necessarily the intended
// one.
export function sendTextToSession(name: string, text: string, submit?: boolean, windowIndex?: number): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}/send-text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, submit, windowIndex }),
  });
}

// Resolves with the new window's index — the bottom terminal panel attaches
// the window it just created (see hooks/useBottomPanel.ts); every other
// caller ignores it and lets the session poll surface the new window.
export function createWindow(name: string, cwd?: string): Promise<{ index: number }> {
  return request(`/api/sessions/${encodeURIComponent(name)}/windows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

export function openLazygit(name: string, cwd?: string): Promise<{ index: number }> {
  return request(`/api/sessions/${encodeURIComponent(name)}/lazygit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

export function selectWindow(name: string, index: number): Promise<void> {
  return request(
    `/api/sessions/${encodeURIComponent(name)}/windows/${index}/select`,
    { method: "POST" },
  );
}

export function killWindow(name: string, index: number): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}/windows/${index}`, {
    method: "DELETE",
  });
}

export function openWindowTab(name: string, index: number): Promise<{ attachName: string }> {
  return request(
    `/api/sessions/${encodeURIComponent(name)}/windows/${index}/open-tab`,
    { method: "POST" },
  );
}

export function closeWindowTab(attachName: string): Promise<void> {
  return request(`/api/window-views/${encodeURIComponent(attachName)}`, { method: "DELETE" });
}

// An empty newName hands the name back to the backend's automatic naming — see
// resetWindowName in server/src/terminals.ts for why that needs a server round
// trip rather than just being a rename to the command's name.
export function renameWindow(name: string, index: number, newName: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}/windows/${index}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

export function renameSession(name: string, newName: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(name)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

export function listDir(dirPath: string): Promise<FsListing> {
  return request(`/api/fs?path=${encodeURIComponent(dirPath)}`);
}

// With `query`, the server fuzzy-filters and returns only the top matches
// (per-keystroke quick-switcher search); without it, the full capped listing.
export function listFiles(dirPath: string, query?: string): Promise<FsFilesListing> {
  const q = query ? `&q=${encodeURIComponent(query)}` : "";
  return request(`/api/fs/files?path=${encodeURIComponent(dirPath)}${q}`);
}

// Resolves the git repo root containing dirPath, or dirPath itself when it
// isn't inside a repo — roots the FILES panel / quick-switcher search.
export function getGitRoot(dirPath: string): Promise<FsGitRoot> {
  return request(`/api/fs/git-root?path=${encodeURIComponent(dirPath)}`);
}

// Which repository each path belongs to, and every worktree of that
// repository — the PROJECTS tree's middle level. The server deduplicates the
// git work by repository, so asking about every session path at once costs
// one listing per repo rather than one per path. `dirty` adds a `git status`
// per worktree; `branches` adds the create form's branch pickers.
export function getWorktrees(
  paths: string[],
  opts: { dirty?: boolean; branches?: boolean } = {},
): Promise<WorktreeLookup> {
  const query = paths.map((p) => `path=${encodeURIComponent(p)}`);
  if (opts.dirty) query.push("dirty=1");
  if (opts.branches) query.push("branches=1");
  return request(`/api/git/worktrees?${query.join("&")}`);
}

// Creates the checkout only — the caller creates the session rooted in it, so
// the tree can name that session and record the folder as a project.
export function createWorktree(body: {
  cwd: string;
  branch: string;
  base?: string;
  mode: "new" | "existing";
  location?: string;
}): Promise<{ path: string; branch: string }> {
  return request("/api/git/worktrees/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Removes a worktree's checkout, keeping its branch. Kill any sessions inside
// it first — this never touches the terminal backend.
export function removeWorktree(body: {
  cwd: string;
  path: string;
  force?: boolean;
}): Promise<{ removed: string }> {
  return request("/api/git/worktrees/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Clean Up Worktrees, step one: which worktrees a bulk cleanup would remove
// (directory missing, or clean and already merged) and which it keeps, and
// why. Read-only. Sessions are the caller's to account for.
export interface WorktreeCleanupEntry<Reason extends string> {
  path: string;
  branch: string | null;
  reason: Reason;
}

export interface WorktreeCleanupPlan {
  repo: string;
  removable: WorktreeCleanupEntry<"missing" | "merged">[];
  kept: WorktreeCleanupEntry<"locked" | "dirty" | "unmerged">[];
}

export function planWorktreeCleanup(cwd: string): Promise<WorktreeCleanupPlan> {
  return request("/api/git/worktrees/cleanup/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

// Step two: removes the confirmed paths. The server re-checks each one, so a
// worktree that changed since the plan is skipped rather than removed.
export function cleanUpWorktrees(body: {
  cwd: string;
  paths: string[];
}): Promise<{ removed: string[]; skipped: { path: string; error: string }[] }> {
  return request("/api/git/worktrees/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function openFile(
  session: string,
  filePath: string,
  keysPane?: string,
  line?: number,
): Promise<{ windowIndex: number | null; deferredPane?: string }> {
  return request(`/api/sessions/${encodeURIComponent(session)}/open-file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath, keysPane, line }),
  });
}

// Opens `nvim -d` on a two-sided diff in a new window of `session`. The server
// materializes whichever side isn't a real file into a temp file — see
// openDiffInWindow. Mirrors openFile's return: a window index to surface as a
// tab, or null when the file landed in an existing window.
export function openDiff(
  session: string,
  req: {
    original: { content: string; label: string };
    modified: { content: string; label: string; path?: string };
  },
): Promise<{ windowIndex: number | null }> {
  return request(`/api/sessions/${encodeURIComponent(session)}/open-diff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}

// Opens git mergetool's nvimdiff layout (LOCAL | MERGED | REMOTE, cursor in
// MERGED) on a conflicted working file — see openMergeInWindow.
export function openMerge(
  session: string,
  req: {
    path: string;
    ours: { content: string; label: string };
    theirs: { content: string; label: string };
    base?: { content: string; label: string };
  },
): Promise<{ windowIndex: number | null }> {
  return request(`/api/sessions/${encodeURIComponent(session)}/open-merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}

// Validates terminal-link file-path candidates — see the matching server
// route for the resolution rules. `cells` (index-aligned, optional) carries
// each candidate's screen cell so it resolves against its own pane. Result
// array is index-aligned with `paths`; a null entry means "not a real file,
// don't linkify it". Callers go through pathResolver.ts, which caches.
export function resolvePaths(
  session: string,
  paths: string[],
  cells?: ({ row: number; col: number } | null)[],
): Promise<{ results: (string | null)[] }> {
  return request(`/api/sessions/${encodeURIComponent(session)}/resolve-paths`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cells ? { paths, cells } : { paths }),
  });
}

export function makeDir(destDir: string, relativePath: string): Promise<void> {
  return request(
    `/api/mkdir?dir=${encodeURIComponent(destDir)}&path=${encodeURIComponent(relativePath)}`,
    { method: "POST" },
  );
}

export function createFile(destDir: string, relativePath: string): Promise<{ path: string }> {
  return request(
    `/api/newfile?dir=${encodeURIComponent(destDir)}&path=${encodeURIComponent(relativePath)}`,
    { method: "POST" },
  );
}

export function renameEntry(targetPath: string, newName: string): Promise<{ path: string }> {
  return request("/api/fs/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: targetPath, newName }),
  });
}

export function deleteEntry(targetPath: string): Promise<void> {
  return request(`/api/fs?path=${encodeURIComponent(targetPath)}`, { method: "DELETE" });
}

// Server-held FILES-tree clipboard — see server/src/api.ts's fsClipboard.
// Copy/cut write here; paste reads the server's own state, so it works
// across browsers/tabs pointed at the same server.
export function setFsClipboard(paths: string[], mode: "copy" | "cut"): Promise<void> {
  return request("/api/fs/clipboard", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths, mode }),
  });
}

export function getFsClipboard(): Promise<{ paths: string[]; mode: "copy" | "cut" | null }> {
  return request("/api/fs/clipboard");
}

export function clearFsClipboard(): Promise<void> {
  return request("/api/fs/clipboard", { method: "DELETE" });
}

export function pasteFsClipboard(
  destDir: string,
): Promise<{ pasted: string[]; errors: { path: string; message: string }[] }> {
  return request("/api/fs/paste", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destDir }),
  });
}

// FILES-tree drag-and-drop move/copy — a separate route from the clipboard
// above on purpose, so a drag never clobbers a pending cut/copy.
export function transferEntries(
  paths: string[],
  destDir: string,
  mode: "move" | "copy",
): Promise<{ done: string[]; errors: { path: string; message: string }[] }> {
  return request("/api/fs/transfer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths, destDir, mode }),
  });
}

export function downloadUrl(targetPath: string): string {
  return `/api/download?path=${encodeURIComponent(targetPath)}`;
}

// Raw file contents as text (for the markdown preview) — request<T>() above
// always JSON.parses the body, so it can't serve this; reuses the same
// /api/download route ImageView already uses for image bytes.
export async function fetchFileText(targetPath: string): Promise<string> {
  const res = await fetch(downloadUrl(targetPath));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// Renders a file inline instead of downloading it — for content an <iframe>
// navigates to (PdfView), where Content-Disposition: attachment would
// trigger a download instead of rendering. <img>/<video> subresource loads
// don't need this: they ignore that header regardless.
export function inlineUrl(targetPath: string): string {
  return `/api/download?inline=1&path=${encodeURIComponent(targetPath)}`;
}

// Writes content back to targetPath via the existing upload route in
// overwrite mode — no dedicated "write file" endpoint needed. Used by
// JsonView's Format & Save and CsvView's Save.
export function saveFileText(targetPath: string, content: string): Promise<{ path: string }> {
  const slash = targetPath.lastIndexOf("/");
  const dir = targetPath.slice(0, slash);
  const name = targetPath.slice(slash + 1);
  return uploadFile(dir, name, new Blob([content], { type: "text/plain" }), "overwrite");
}

// A 413 never comes from /api/upload itself — that route streams the request
// body straight to disk with no size limit of its own (verified: a 200MB body
// lands fine). It comes from whatever sits in front of the server: a reverse
// proxy, tunnel, or CDN capping request bodies, none of which this app can
// see or configure. Their reply is that proxy's own HTML error page, so the
// generic handler below would surface a bare "413 Request Entity Too Large"
// with nothing actionable in it — hence a typed error carrying the size that
// was actually refused, which is the number the user needs to pick a limit.
export class UploadTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(
      `too large for the server (${formatMb(size)} MB refused with 413) - a proxy in ` +
        `front of it caps request size. Set "Maximum upload file size" in Settings → ` +
        `Behavior to catch these before uploading.`,
    );
    this.name = "UploadTooLargeError";
  }
}

// Thrown when the server refuses to upload because the destination already
// exists and the caller asked for "fail" conflict semantics (used to drive
// the ask-before-overwrite flow).
export class UploadConflictError extends Error {
  constructor() {
    super("file already exists");
    this.name = "UploadConflictError";
  }
}

// XHR, not fetch: only XHR exposes upload progress events, which the
// byte-level progress banner needs.
export function uploadFile(
  destDir: string,
  relativePath: string,
  file: File | Blob,
  conflict: "rename" | "overwrite" | "fail",
  onProgress?: (loadedBytes: number) => void,
): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url =
      `/api/upload?dir=${encodeURIComponent(destDir)}` +
      `&path=${encodeURIComponent(relativePath)}&conflict=${conflict}`;
    xhr.open("POST", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status === 409) {
        reject(new UploadConflictError());
        return;
      }
      if (xhr.status === 413) {
        reject(new UploadTooLargeError(file.size));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText ? JSON.parse(xhr.responseText) : { path: "" });
        return;
      }
      let message = `${xhr.status} ${xhr.statusText}`;
      try {
        const body = JSON.parse(xhr.responseText);
        if (body?.error) message = body.error;
      } catch {
        // non-JSON error body; keep the status message
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("network error during upload"));
    xhr.send(file);
  });
}

export function fetchExtensions(): Promise<ExtensionInfo[]> {
  return request("/api/extensions");
}

export function installExtensionPackage(file: File | Blob): Promise<ExtensionInfo> {
  return request("/api/extensions/install", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
}

export function uninstallExtension(id: string): Promise<void> {
  return request(`/api/extensions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionInfo> {
  return request(`/api/extensions/${encodeURIComponent(id)}/enabled`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

// Resolves an extension-relative path (theme JSON, icon font/SVG, the
// client entry module) to a fetchable/importable URL.
export function extensionFileUrl(id: string, relPath: string): string {
  return `/api/extensions/${encodeURIComponent(id)}/file/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

// Extension registries: user-configured sources, each serving an index.json
// catalog — see server/src/registry.ts.
// `sources`, when passed, bypasses the server's settings-doc read — see
// server/src/registry.ts's getRegistryCatalog doc comment on why an
// add/remove-then-refresh needs this instead of relying on the (debounced)
// persisted doc.
export function fetchRegistry(refresh?: boolean, sources?: string[]): Promise<RegistrySourceResult[]> {
  const params = new URLSearchParams();
  if (refresh) params.set("refresh", "1");
  if (sources) params.set("sources", JSON.stringify(sources));
  const qs = params.toString();
  return request(`/api/registry${qs ? `?${qs}` : ""}`).then(
    (body) => (body as { sources: RegistrySourceResult[] }).sources,
  );
}

// The app's built-in default registry (EXTENSION_REGISTRY env on the server,
// else the shipped GitHub Pages catalog), or null if disabled. Merged ahead of
// the user's own sources for display/fetch — see App.tsx.
export function fetchDefaultRegistry(): Promise<string | null> {
  return request("/api/registry/default").then(
    (body) => (body as { registry: string | null }).registry,
  );
}

export function installFromRegistry(source: string, id: string): Promise<ExtensionInfo> {
  return request("/api/registry/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, id }),
  });
}

// Bypasses the JSON request() helper — the response body is markdown text,
// not JSON.
export async function fetchRegistryReadme(source: string, id: string): Promise<string> {
  const url = `/api/registry/readme?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
  return res.text();
}

// Direct-use URL for an <img src> — the icon proxy streams image bytes, not
// JSON, so this isn't routed through request().
export function registryIconUrl(source: string, id: string): string {
  return `/api/registry/icon?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`;
}

// The mount point for an extension's server hook, if it has one and is
// enabled — 404s otherwise (see extensionHookMiddleware).
export function extensionApiBase(id: string): string {
  return `/api/ext/${encodeURIComponent(id)}`;
}

// Shell integration status (plans/warp-features.md) — the Settings card's
// "is it sourced anywhere" signal plus the canonical rc snippet.
export function fetchShellIntegrationStatus(): Promise<{
  receivedAny: boolean;
  path: string;
  sourceLine: string;
  // Where the line goes, e.g. "~/.zshrc or ~/.bashrc".
  profile?: string;
}> {
  return request("/api/command-events/status");
}

// Web-push notifications (plans/codeman-mobile-features.md Phase 4).
export function fetchPushVapidKey(): Promise<{ publicKey: string }> {
  return request("/api/push/vapid-key");
}

export function subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
  return request("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription),
  });
}

export function unsubscribePush(endpoint: string): Promise<void> {
  return request("/api/push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}
