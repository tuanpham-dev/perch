export interface TerminalWindow {
  // Stable window id (a uuid on the daemon, "tmux-<n>" on the tmux backend) — survives renumbering.
  id: string;
  index: number;
  name: string;
  active: boolean;
  cwd: string;
  activity: boolean;
  // The active pane's current foreground command (e.g. "bash", "claude") —
  // see the server-side TerminalWindow's matching field for why this exists.
  command: string;
}

// `perch open`'s SSE payload (server/src/openUrl.ts's OpenTargetPayload)
// — a directory to open as a project, or a file to open in its project.
// `path`/`projectCwd` arrive already `~`-shortened, matching TerminalSession.path.
export interface OpenTargetPayload {
  kind: "dir" | "file";
  path: string;
  projectCwd: string;
  line?: number;
  action?: "editor" | "preview";
}

export interface TerminalSession {
  // Stable session id — survives rename.
  id: string;
  name: string;
  created: number;
  attached: number;
  // The session's default working directory (the session's start directory, `~`-
  // shortened) — the key sessions are matched to projects by, since it
  // survives renames where the name can't.
  path: string;
  windows: TerminalWindow[];
}

// A project is a folder: `cwd` (full `~`-shortened path) is its identity and
// what its session is matched by (session.path === cwd); the display
// name is always derived from the folder basename (lib/projects.ts's
// projectName), never stored. The registry doubles as the recent-projects
// list, MRU by lastOpened. A pinned project survives its session being
// killed: the PROJECTS panel keeps a dead row that recreates the session in
// exactly this folder; unpinned projects live only in the recents dropdown.
export interface Project {
  cwd: string;
  pinned: boolean;
  lastOpened: number;
}

export interface Tab {
  id: string;
  // The editor group (split pane) this tab belongs to — see lib/splits.ts's
  // SplitNode. Every tab has exactly one; optional only because a tab
  // restored from localStorage before splits shipped won't have one yet —
  // loadStoredTabs stamps it with the tree's sole leaf id on migration.
  groupId?: string;
  sessionName: string;
  // What's actually passed as the WS ?session= param.
  // Equal to sessionName for a whole-session tab; a synthetic grouped
  // session name for a window-tab.
  attachName: string;
  // Present only for a window-tab — the specific window it's pinned to.
  windowIndex?: number;
  // Stable ids for the tab's session/window, used to re-target
  // sessionName/windowIndex after an out-of-band rename or renumber
  // (see lib/tabs.ts's reconcileTabs). Absent for tabs restored from
  // localStorage before id-keying shipped, or a fresh open whose ids
  // haven't been resolved from the next poll yet — both self-heal on the
  // next successful id match.
  sessionId?: string;
  windowId?: string;
  // Legacy virtual-tab kinds from before built-in previews became extension-
  // registered viewers (image/media/pdf/markdown/json/yaml/csv all moved to
  // extViewerId/extViewerPath below). Only ever present on a tab restored
  // from localStorage before that migration shipped — App.tsx's one-time
  // migration effect converts these to extViewerId/extViewerPath as soon as
  // the registry populates; never set on a newly created tab.
  imagePath?: string;
  previewPath?: string;
  // Marks the (singleton) settings tab — sessionName/attachName are "" for
  // this and every virtual-tab kind below — every terminal-facing code path
  // (reconcile, the vanished-window sweep, dedupe, close) already gates on
  // windowIndex or a real session-name match, so a virtual tab passes
  // through untouched.
  settingsView?: true;
  // Marks the (singleton) Keyboard Shortcuts editor tab — same virtual-tab
  // conventions as settingsView above (sessionName/attachName "", deduped
  // globally, every terminal-facing code path passes through untouched).
  keyboardView?: true;
  // Marks an extension-registered file-viewer tab — the current virtual-tab
  // kind for every built-in and third-party preview. extViewerId identifies
  // which registered viewer (extensions.ts) renders extViewerPath; a
  // newly-created tab always has exactly one of settingsView/extViewerPath
  // set (imagePath/previewPath only appear pre-migration — see above).
  extViewerId?: string;
  extViewerPath?: string;
  // Optional override for the tab-bar label, set via ctx.app.openViewerTab's
  // `title` option — e.g. git-scm's diff viewer titles its tab
  // "App.tsx (Working Tree)" instead of the bare basename tabLabel derives
  // by default. Absent for every other viewer tab.
  extViewerTitle?: string;
  // Bumped by openExtViewerTab each time an explicit open/preview action
  // re-targets this already-open viewer tab (FILES-tree click or "Preview",
  // terminal link, quick switcher, ctx.app.openViewerTab) — surfaced to the
  // mounted viewer as FileViewerHostProps.reloadKey so it can re-fetch the
  // file from disk. Plain tab-bar switching never touches it.
  extViewerReloadKey?: number;
  // Only on a viewer tab (extViewerPath set): the real session it was
  // opened "from" (App.tsx's openExtViewerTab), pinned at creation time so
  // it can join that session's Chrome-style tab group — see groupKeyForTab
  // in lib/tabs.ts. originSessionId mirrors sessionId's rename-survival role;
  // both are cleared once the origin session no longer exists (the viewer
  // tab itself is left open and just ungroups — previews aren't tied to a
  // live terminal process the way window-tabs are). Absent for a settings tab,
  // for a viewer tab opened with no real tab ever active, or one restored
  // from localStorage before this shipped.
  originSessionName?: string;
  originSessionId?: string;
  // Marks an extension detail-page tab — sessionName/attachName are "" like
  // every other virtual-tab kind above. Deduped globally by extensionPageId
  // (one page per extension, like the settings tab), never grouped to a
  // session. extensionPageSource is set only while the subject is a
  // registry-only entry not yet installed (the {source, id} the page/API
  // calls need); cleared once the extension becomes installed, since
  // installed extensions are looked up by id alone.
  extensionPageId?: string;
  extensionPageSource?: string;
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
  // Right-aligned keyboard-shortcut hint — a files.* command id (e.g.
  // "files.copy") resolved to its first live binding by ContextMenu via
  // formatBinding, so a Settings rebind updates the hint on the very next
  // render (even in a menu already open when the rebind happens). Display
  // only: it doesn't dispatch the shortcut itself — these are local FileTree
  // handlers dispatched by FileTree's own key handler, not global commands.
  // No hint renders when the command is unbound.
  shortcutCommand?: string;
  // Renders a row of color swatches instead of the normal label/click row —
  // used by a tab-group chip's context menu to pick the group's color.
  // label/onClick are unused placeholders on a swatches item; ContextMenu
  // checks `swatches` first.
  swatches?: {
    colors: { key: string; hex: string }[];
    selected: string;
    onPick: (key: string) => void;
  };
  // Leading check icon — marks the session's active window in the tab
  // group chip's windows dropdown. When any item in a menu sets this (true
  // or false), ContextMenu reserves a leading gutter so labels stay aligned.
  checked?: boolean;
  // Renders the row dimmed and inert (no click handling) — used for the
  // "No windows" placeholder when a chip's session has vanished or has no
  // windows.
  disabled?: boolean;
  // Renders a thin horizontal divider instead of the normal label/click row
  // — label/onClick are unused placeholders, same convention as `swatches`.
  separator?: boolean;
  // Leading codicon name (e.g. "add"), rendered in the same gutter as
  // `checked` — used by the chip dropdown's "New Window" item. `checked`
  // wins if both are set.
  icon?: string;
  // Right-aligned icon button giving the row a secondary action — e.g. the
  // recent-projects dropdown's per-entry "Remove from Recent". Clicking it
  // runs its own onClick without triggering the row's; Delete on the
  // keyboard-focused row dispatches it too (see ContextMenu).
  trailing?: {
    icon: string;
    title: string;
    onClick: () => void;
  };
  // A nested list opened from this row (the gear menu's Panes and Theme
  // lists). A row with a submenu has no action of its own: its onClick is
  // never called, and pointing at it — or tapping it, where there is no
  // hover — opens the child list beside it instead.
  submenu?: MenuItem[];
}

// Per-project tab-group UI state (useTabGroups' tabGroupState), keyed by
// the group key — the session's project folder (session_path), falling
// back to the session name for pathless sessions. Pre-project state keyed
// by session name migrates best-effort in useTabGroups' reconcile effect.
export interface TabGroupState {
  color: string; // a utils/groupColor.ts GROUP_COLORS key
  collapsed: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  // Set only by the tab-group chip's windows-dropdown trigger, so that
  // button can tell whether its OWN menu is the one currently open and
  // toggle it closed on a second click — every other showMenu caller leaves
  // this undefined.
  sourceId?: string;
}

export interface FsEntry {
  name: string;
  dir: boolean;
}

export interface FsListing {
  path: string;
  entries: FsEntry[];
}

export interface FsFilesListing {
  path: string;
  files: string[];
  truncated: boolean;
}

export interface FsGitRoot {
  root: string;
}

// One git worktree of a repository, as the PROJECTS tree's middle level shows
// it. `path` is `~`-shortened like every other path the client sees, so it
// compares directly against TerminalSession.path. `main` marks the repository's
// own checkout — always first, never removable, and the identity of the
// project row the others nest under.
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
  dirty: boolean;
}

// A local branch and the worktree that currently has it checked out — git
// refuses one branch in two worktrees, so the create form offers only the
// unattached ones.
export interface WorktreeBranch {
  name: string;
  checkedOutAt: string | null;
}

// A repository as the tree groups by it: `repo` is the main worktree's path
// (the group key every session in any of its worktrees shares).
export interface RepoInfo {
  repo: string;
  worktrees: WorktreeInfo[];
  branches: WorktreeBranch[];
}

export interface WorktreeLookup {
  results: {
    path: string;
    // null when this path isn't inside a git repository at all — a normal
    // answer for a session started outside one, not an error.
    repo: string | null;
    worktrees: WorktreeInfo[];
    branches: WorktreeBranch[];
  }[];
}

export interface ExtensionThemeContribution {
  label: string;
  path: string;
}

export interface ExtensionIconThemeContribution {
  id: string;
  label: string;
  path: string;
}

export interface ExtensionFontSrc {
  path: string;
  format: string;
}

// See server/src/extensions.ts's FontGroupContribution comment — a
// perch-specific manifest field, not a VS Code concept. Entries
// sharing a `family` are different weights/styles of the same font; entries
// with distinct `family` values are separate fonts bundled into one group. A
// group is the Settings font picker's unit of selection — picking it writes
// every family in `fonts` into the stack at once. One extension can
// contribute several groups.
export interface ExtensionFontEntry {
  family: string;
  src: ExtensionFontSrc[];
  weight?: string;
  style?: string;
  // CSS unicode-range descriptor — splits one family/weight/style combo
  // across several entries by script (e.g. IBM Plex Mono's latin/cyrillic/
  // vietnamese subsets), each loaded as its own FontFace.
  unicodeRange?: string;
}

export interface ExtensionFontGroupContribution {
  group: string;
  fonts: ExtensionFontEntry[];
}

// Mirrors server/src/extensions.ts's ExtensionConfigurationProperty — the
// server has already normalized/validated the manifest, so the client just
// renders a control per property. `key` is the full dotted name exactly as
// declared (no shared prefix assumed).
export interface ExtensionConfigurationProperty {
  key: string;
  type: "boolean" | "number" | "integer" | "string";
  // "ai-profile" renders a picker of the AIs configured in Settings → AI Providers,
  // storing the chosen profile's id. Anything else renders as usual.
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

// One installable entry from a registry source's index.json — see
// server/src/registry.ts. file/readme/icon relative paths never reach the
// client; it names entries by {source, id} and the server re-resolves them.
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

export type EditorCapability = "file" | "diff" | "merge";

export interface ExtensionInfo {
  id: string;
  displayName: string;
  version: string;
  description: string;
  // Extension-relative path (VS Code manifest `icon` field), or null —
  // resolved via extensionFileUrl(id, icon), same as clientEntry.
  icon: string | null;
  enabled: boolean;
  themes: ExtensionThemeContribution[];
  iconThemes: ExtensionIconThemeContribution[];
  fonts: ExtensionFontGroupContribution[];
  configuration: ExtensionConfigurationSection[];
  // Declared, not activated — lets the app resolve/list available terminal
  // engines (the Settings picker, and which one a session actually needs)
  // without running the extension's client code. `id` is unnamespaced, same
  // local id its ctx.registerTerminalEngine call uses at activation time
  // (see extensions.ts's registerTerminalEngine — both namespace it
  // identically: ext.<extensionId>.<id>).
  terminalEngines: { id: string; label: string }[];
  // Declared, not activated — the same contract terminalEngines has, for
  // editors (see client/src/editors/index.ts). Lets the Settings picker list
  // every installed editor, and lets resolution know which extension owns a
  // stored editor id, without running any extension's client code.
  // `capabilities` is what this editor can open: files, git diffs, merge
  // conflicts. Anything it doesn't declare falls back to nvim.
  editors: { id: string; label: string; capabilities: EditorCapability[] }[];
  clientEntry: string | null;
  hasClient: boolean;
  hasServer: boolean;
  // Shipped from the repo's extensions/ dir rather than user-installed.
  builtin: boolean;
  // Bundled + manifest perch.required — cannot be disabled or
  // uninstalled (the server enforces it; the UI hides those actions).
  required: boolean;
  // A builtin that's been uninstalled: still listed and inactive
  // (enabled=false), the UI offers Reinstall instead of Disable/Uninstall.
  uninstalled: boolean;
  // The registry source this extension was installed from, or null when none
  // was recorded (an upload, a builtin, or an install from before it was
  // tracked). Mirrors server/src/extensions.ts's ExtensionInfo.
  source: string | null;
}
