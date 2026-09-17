import { migrateKeybindingOverrides, type KeybindingOverrides } from "./keybindings";
import { parsePanelState, parseSidebarLayout, type PanelState, type StoredSidebarLayout } from "./lib/sidebarLayout";
import { parseStatusBarLayout, type StatusBarLayout } from "./lib/statusBarLayout";
import type { Project } from "./types";

// The API kinds core implements itself, plus - for a CLI - the id of an agent
// from Settings → AI Providers' own Agents group. The CLIs used to be literals
// here ("claude" | "codex" | "agy"); they are agent ids now, so adding one is
// an extension rather than an edit to this union
// (plans/cli-providers-from-agents.md). The `string & {}` arm keeps the three
// literals in autocomplete while accepting any agent id.
export type AiProviderId = "anthropic" | "openai" | "custom" | (string & {});

// The kinds core itself knows how to talk to. Anything else in a profile's
// `provider` is an agent id.
export const API_PROVIDER_IDS = ["anthropic", "openai", "custom"] as const;

// One configured AI. Mirrors server/src/ai.ts's AiProfile — the server reads
// these straight out of the settings document, so the two shapes have to
// agree. API keys are NOT here: they live server-side in aiSecrets, keyed by
// this profile's id, and never reach a client (see settingsStore.ts).
export interface AiProfile {
  // Stable across renames — what a caller stores when it picks a profile.
  id: string;
  label: string;
  provider: AiProviderId;
  model: string;
  binaryPath: string;
  customCommand: string;
  baseUrl: string;
  // A profile kept but not offered: it stays configured (key included) and
  // stops showing up in pickers.
  enabled: boolean;
}

// One agent as the settings document stores it. The server reads these back,
// but only for `id` and `enabled`: an agent's identity now comes from the
// extension that contributed it, and the document only records what the user
// did to it (plans/agents-from-extensions.md). The rest of the fields are
// kept so a row can render from stored state alone, without waiting for the
// server's copy - the difference between a 21ms toggle and a 4.5s one.
export interface AgentPreset {
  // Stable across renames — what an extension stores when it picks one.
  id: string;
  label: string;
  // the window's foreground command. Empty means launch-preset only: no pane will
  // ever be detected as this agent.
  program: string;
  // The full launch line. Empty means detection only.
  command: string;
  // Appended to `command` to start this agent with its permission prompts
  // off - its "yolo mode". A parameter rather than a second entry, because
  // every agent has one and a pair of entries only ever differed by this
  // flag. Empty means no such mode, and no checkbox is offered for it.
  skipPermissionsArgs: string;
  // Where to read about this agent, or how to install it - the row's
  // external link in Settings → AI Providers. Empty hides it.
  docsUrl: string;
  // An image for the row (the app serves its own at /agents/<id>.svg; a
  // contributed one is resolved to its extension's file route). Empty falls
  // back to `icon`.
  iconUrl: string;
  // Fallback codicon name for an agent with no image. Empty or unknown
  // renders a generic robot.
  icon: string;
  // An agent kept but not offered: stays configured, stops showing up in
  // pickers and in detection.
  enabled: boolean;
  // The extension that contributed this entry, or "" for one the app ships
  // or the user wrote. Contributed entries are not editable.
  contributedBy: string;
}


// A profile starts with no agents of its own. The app ships none: every agent
// comes from an extension's `contributes.agents`, and the bundled
// extensions/agents supplies Claude Code and Codex. An empty list here means
// the document never overrides anything, so a freshly installed agent arrives
// enabled as its extension declared it.
export const DEFAULT_AGENTS: AgentPreset[] = []

export interface AppSettings {
  // "auto" resolves per device (xterm on mobile pointers, ghostty
  // elsewhere) — synced across devices, so a phone and a desktop each get
  // the engine suited to them from one setting. Switching (directly or via
  // auto re-resolving) remounts the terminal and reattaches. Otherwise a
  // namespaced extension engine id (ext.<extensionId>.<engineId>) —
  // xterm-engine is bundled and required, ghostty-engine is an optional
  // registry install (auto falls back to xterm without it); see
  // client/src/engines/index.ts.
  terminalEngine: string;
  // Which editor opens files, git diffs and merge conflicts: the bare id
  // "nvim" (core's terminal editor, the default and the per-capability
  // fallback) or a namespaced extension editor id (ext.<extensionId>.<id>,
  // declared via contributes.editors). See client/src/editors/index.ts.
  editor: string;
  fontFamily: string;
  fontSize: number;
  // Terminal font size used instead of fontSize on real phones/tablets
  // (the "(pointer: coarse) and (hover: none)" predicate App.tsx tracks).
  // 0 (or anything below 8, the smallest real size) means "follow
  // fontSize" — same 0-disables convention as notifyCommandMinDuration.
  // Applied where fontSize is consumed for rendering (App.tsx's
  // effectiveSettings), never written back into the stored blob.
  fontSizeMobile: number;
  // Weight used for ordinary (non-bold) text: "medium" renders everything
  // in the font's 500 face when the extension ships one (IBM Plex Mono
  // does), falling back to regular per style otherwise. Implemented by
  // font-face registration (utils/fonts.ts), same mechanism as
  // fontWeightBold below — and with the same limitation: extension-loaded
  // fonts only.
  fontWeight: "normal" | "medium";
  // Synthetic glyph thickening: stroke width in px added around every glyph
  // (0 = off). Fractional control between the font's designed weights, at
  // the cost of slightly softer edges. ghostty engine: canvas rasterizer
  // shim (the ghostty-engine extension). xterm engine: native -webkit-text-stroke on the
  // DOM renderer. Applies to any font, including system fallbacks (unlike
  // fontWeight).
  textThickness: number;
  // ghostty-web has no fontWeightBold option, so the ghostty engine
  // implements "normal" by registering the text-weight font face across all
  // weights so the renderer's "bold …" canvas font lookups resolve to it
  // (utils/fonts.ts) — only covers extension-loaded fonts, system fonts in
  // the stack keep their real bold. xterm engine: native option.
  fontWeightBold: "normal" | "bold";
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  // Line height multiplier / letter spacing in px. ghostty engine: no
  // native options, applied by adjusting the renderer's measured cell
  // metrics (the ghostty-engine extension's shims). xterm engine: native options.
  lineHeight: number;
  letterSpacing: number;
  // 1 disables it; 4.5 is the VS Code/code-server default (WCAG AA) —
  // without it, e.g. lazygit's selected row keeps its original foreground
  // colors on the blue selection background and becomes unreadable.
  // ghostty engine: shim (its extension's renderer shims). xterm engine: native option.
  minimumContrastRatio: number;
  // What a copied selection looks like (selectionText.ts).
  //   "raw": the engines' own per-row text, newline at every wrap column.
  //   "joinWrapped" (default): joins rows the TERMINAL wrapped — the tmux
  //     backend's redraws destroy the engines' wrap flags, so without this a wrapped
  //     line copies with a "\n" at every wrap column. Lossless: newlines the
  //     program itself emitted are preserved, so code and lists survive.
  //   "paragraph": additionally joins the line breaks a PROGRAM made while
  //     word-wrapping its own output (unwrapParagraphs). Lossy — a code
  //     block collapses to one line — which is why it isn't the default;
  //     prefer the per-copy "Copy as Paragraph" action.
  copySelection: "raw" | "joinWrapped" | "paragraph";
  // What a plain (unshifted) right-click in a terminal does.
  //   "menu" (default): opens the terminal context menu; Shift+right-click
  //     is forwarded to a program that has mouse reporting on (vim, htop).
  //   "forward": the reverse — a mouse-aware program gets the plain click,
  //     Shift+right-click opens the menu. With no mouse reporting active
  //     there is nothing to forward to, so the menu opens either way.
  //   "paste": pastes the clipboard (Windows Terminal habit), except over a
  //     link or with text selected, where the menu is more useful.
  rightClickBehavior: "menu" | "forward" | "paste";
  // Typing while the pane is scrolled back jumps it to the live tail first,
  // the way a normal terminal emulator does. PageUp/PageDown are exempt —
  // moving within the scrollback is their whole job — as are the wheel and
  // the app's own terminal.* keybindings (find, copy, prompt jumps), which
  // stay usable while scrolled.
  scrollbackSnapToBottom: boolean;
  // Where terminals run: "daemon" (bundled) or an engine id an extension
  // registers ("tmux"). Read by the server when it starts.
  terminalBackend: string;
  // The shell new terminal windows run; empty means the account's own
  // ($SHELL). Applied to windows created after the change.
  terminalShell: string;
  // Keep each window's output on disk so it comes back after a restart.
  // Off still brings back sessions, windows and folders, just not history.
  saveScrollback: boolean;
  // Bring sessions back when the terminal daemon starts (after a reboot, or
  // after it was stopped).
  restoreSessionsOnStart: boolean;
  // After a restore, type an agent's resume command ("claude --continue")
  // into windows that were running it.
  resumeAgentsOnRestore: boolean;
  // The bottom status bar (git branch, terminals, listening ports, extension
  // items). Stays on phones, compacted to icons and counts.
  showStatusBar: boolean;
  // When the installed desktop app's browser title bar is hidden (Window
  // Controls Overlay), draw the app's own title bar in that strip and drop
  // the left sidebar footer whose buttons it carries. Off keeps the footer,
  // and content then runs up under the window controls.
  customTitleBar: boolean;
  // What clicking the custom title bar's command center opens.
  commandCenterAction: "quickSwitcher" | "commandPalette";
  uploadConflict: "rename" | "overwrite" | "ask";
  // Largest single file accepted by an upload, in MB. 0 means no limit —
  // same 0-disables convention as notifyCommandMinDuration. Enforced client
  // side before any bytes go on the wire (upload.ts's uploadAll for the
  // FILES tree, TerminalView's paste/drop path for a terminal pane), so an
  // oversized file is reported as a skip instead of streaming a multi-GB
  // drag onto the server.
  uploadMaxSizeMb: number;
  // Destination directory for image paste/drop and the {image} touch key
  // (plans/mobile-image-upload-key.md). {tmp} (the server's temp folder),
  // {cwd} (the pane's folder) and {gitroot} (its repo root) are expanded per
  // upload; default "{tmp}". Empty falls back to the pane's own
  // `<cwd>/uploads`.
  pasteDropUploadDir: string;
  // Comma-separated program names (lib/terminalInput.ts's whenMatches
  // rules) gating
  // zero-lag local echo (plans/codeman-mobile-features.md): on a mobile
  // pointer device, while the pane's foreground command matches, typed
  // input renders instantly in a DOM overlay while every keystroke is still
  // sent to the PTY straight away (see localEcho.ts). Also gates image
  // paste/drop uploads, on desktop too. "" disables both.
  localEchoWhen: string;
  // Where the PROJECTS tree creates new worktrees. {repo} is the repository
  // root, {branch} the branch name with path separators replaced by "-". A
  // relative path resolves against the repository root. When the location is
  // inside the repository, its top folder is added to .git/info/exclude so it
  // stays out of git status (your committed .gitignore is never modified).
  worktreeLocation: string;
  // The API providers the user has added, in their own order - a keyed API
  // for the jobs worth paying for, or a custom command. CLIs are not stored
  // here: every agent that can answer a single prompt is offered as a
  // provider by the server, from the agent registry. Each caller (core, or
  // an extension with an "ai-profile" setting) either names one or gets
  // aiProfileId's.
  aiProfiles: AiProfile[];
  // Which profile answers a caller that doesn't name one. Empty (or naming a
  // profile that's gone) means the first enabled profile.
  aiProfileId: string;
  // The model the DEFAULT provider runs, chosen by the one select in
  // Settings → AI Providers rather than per profile. Empty means that
  // provider's own default model. It overrides the default profile's own
  // `model` field, because "default model" is exactly what it says - a
  // profile named explicitly by an extension still uses its own.
  aiDefaultModel: string;
  // The user's per-agent enabled overrides, keyed by id. The agents
  // themselves come from extensions' contributes.agents (server/src/agents.ts
  // resolveAgents), which extensions read through GET /api/agents or
  // host.agents.list(); a stored entry no extension contributes is ignored.
  agents: AgentPreset[];
  // The one switch over core's agent-hook pipeline: on, core keeps its hooks
  // installed in each agent's own config file, so the app can show working /
  // waiting / done states; off, it removes them and stops putting them back.
  // Off by default - writing into a file the app does not own is not
  // something to start doing unasked.
  agentHooksEnabled: boolean;
  // How agents are launched by default. "yolo" appends each agent's own
  // skip-permissions flag (see AgentPreset.skipPermissionsArgs); "manual"
  // leaves the prompts on. Every launch follows it (the New Worktree form,
  // an extension's Start work); there is no per-launch override.
  agentPermissions: "yolo" | "manual";
  // Whether core installs the per-tool-call hook events (tool-start /
  // tool-end) an extension asked for. Off by default: they fire once per
  // tool call, which buys exact working-state detection at the cost of a
  // hook process every time the agent touches anything. With it off, a
  // subscriber still gets the turn-level events and falls back to its own
  // inference. Named flat like every other core setting in here; the plan
  // that specified it writes it agentHooks.highFrequencyEvents, which no
  // AppSettings key could be without quoting.
  agentHooksHighFrequencyEvents: boolean;
  // Gates the "Close Project"/"Close Terminal" confirm dialogs. Unsaved-changes
  // confirms (dirty CSV tabs) are never gated — that's data loss, not a
  // preference.
  confirmBeforeKill: boolean;
  // What closing the active tab activates: the previously active tab (VS
  // Code-style MRU) or the positional neighbor.
  tabCloseActivation: "recent" | "adjacent";
  // Where a newly opened tab is inserted: appended at the end of the tab
  // bar, or immediately to the right of the active tab.
  newTabPlacement: "end" | "afterActive";
  // Chrome-style tab groups: each session's tabs sit behind a colored,
  // collapsible chip in the tab bar. On by default since projects became
  // the organizing unit (plans/project-first-ui.md); migrateSettings flips
  // a stored false once (guarded), so a later deliberate opt-out sticks.
  tabGroupsBySession: boolean;
  // Where the Open Folder dialog starts browsing. Empty = home. Renamed
  // from newSessionCwd (migrateSettings copies the old key forward).
  defaultProjectsFolder: string;
  // `${extensionId}:${themeLabel}` from an installed extension's
  // contributes.themes — see theme.ts. Defaults to the bundled
  // perch.plastic-legacy-theme extension; "" (or any unresolvable
  // value) falls back to the hard-coded Plastic Legacy values in
  // styles.css's :root, which are pixel-identical to that extension.
  colorTheme: string;
  // `${extensionId}:${iconThemeId}` from an installed extension's
  // contributes.iconThemes — see utils/iconThemes.ts. Defaults to the
  // bundled perch.seti-icons extension; "" means no icon theme (blank
  // spacer icons, not a fallback to Seti).
  iconTheme: string;
  // When true, the command palette (QuickSwitcher's ">" mode) sorts commands
  // by usage count instead of their static COMMANDS order — see App.tsx's
  // paletteCommands memo and commandUsage below. The single most-recently-run
  // command always pins to row 1 regardless of this setting.
  paletteSortByUsage: boolean;
  // Web-push a notification when a command reported by shell integration
  // (plans/warp-features.md) finishes after running at least this many
  // seconds. 0 disables. Read server-side (index.ts, which calls push.ts) from the synced doc —
  // the shell reports and the push fan-out never touch the client.
  notifyCommandMinDuration: number;
}

// Defaults mirror the user's code-server settings.json (editor.fontFamily,
// terminal.integrated.fontSize). IBM
// Plex Mono, Plastic Legacy, and Seti are bundled extensions (see
// extensions/ibm-plex-mono, plastic-legacy-theme, seti-icons) rather than
// built into the client bundle — selected-only asset loading applies to all
// three like any other extension. The fallback tail after IBM Plex Mono is
// each major OS's own default monospace font — Menlo (macOS, since Lion),
// Consolas (Windows, since Vista), DejaVu Sans Mono / Liberation Mono (the
// two most commonly pre-installed on Linux, no single distro-wide default
// exists) — so an unavailable bundled font still lands on something native
// to the machine before falling through to the browser's generic mapping.
export const DEFAULT_SETTINGS: AppSettings = {
  // xterm.js is the bundled, required engine (extensions/xterm-engine) — the
  // safe default. Ghostty moved to the optional registry, so it's no longer
  // shipped; install it from the Extensions tab to select it here.
  terminalEngine: "ext.perch.xterm-engine.xterm",
  // nvim — today's behavior for every existing install.
  editor: "nvim",
  fontFamily: "'IBM Plex Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
  fontSize: 14,
  fontSizeMobile: 0,
  fontWeight: "normal",
  textThickness: 0,
  fontWeightBold: "normal",
  cursorStyle: "block",
  cursorBlink: true,
  lineHeight: 1,
  letterSpacing: 0,
  minimumContrastRatio: 4.5,
  copySelection: "joinWrapped",
  rightClickBehavior: "menu",
  scrollbackSnapToBottom: true,
  terminalBackend: "daemon",
  terminalShell: "",
  saveScrollback: true,
  restoreSessionsOnStart: true,
  resumeAgentsOnRestore: true,
  showStatusBar: true,
  customTitleBar: true,
  commandCenterAction: "quickSwitcher",
  uploadConflict: "rename",
  uploadMaxSizeMb: 0,
  // {tmp} is the server's temp folder (/tmp, or %TEMP% on Windows).
  pasteDropUploadDir: "{tmp}",
  localEchoWhen: "claude",
  worktreeLocation: "{repo}/.worktrees/{branch}",
  aiProfiles: [],
  aiProfileId: "",
  aiDefaultModel: "",
  // Copied, not shared: DEFAULT_SETTINGS is spread into a mutable settings
  // object that the Agents section edits in place.
  agents: DEFAULT_AGENTS.map((a) => ({ ...a })),
  agentHooksEnabled: false,
  agentPermissions: "manual",
  agentHooksHighFrequencyEvents: false,
  confirmBeforeKill: true,
  tabCloseActivation: "recent",
  newTabPlacement: "end",
  tabGroupsBySession: true,
  defaultProjectsFolder: "",
  colorTheme: "perch.plastic-legacy-theme:Plastic Legacy",
  iconTheme: "perch.seti-icons:seti",
  paletteSortByUsage: false,
  notifyCommandMinDuration: 0,
};

// A stored value from before the built-in theme/icon theme/font were
// extracted into bundled extensions: colorTheme/iconTheme "" used to mean
// "the built-in one", which is now a value colorTheme still tolerates
// (falls back to hard-coded :root colors) but iconTheme does not (means "no
// icon theme" instead of Seti) — leaving it unmigrated would silently drop
// a returning user's file icons. The old default font stack maps forward
// too; a stack the user actually customized (including one that merely
// starts with 'IBM Plex Mono') is left alone.
const LEGACY_DEFAULT_FONT_FAMILY =
  "'IBM Plex Mono', 'Symbols Nerd Font Mono', 'Noto Color Emoji', 'Droid Sans Mono', monospace";

// One-shot settings migrations, guarded like Sidebar.tsx's panel
// migrations so they never fight a user's later explicit choice. The
// module-level memo mirrors tasksOrderMigratedThisLoad there: within one
// page load the flip stays applied for every migrateSettings call (the
// localStorage-first load AND the later server-doc apply both run through
// here), while a fresh load consults only the persisted flag.
const SETTINGS_MIGRATIONS_KEY = "settingsMigrations";
let tabGroupsFlippedThisLoad = false;

function appliedSettingsMigrations(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_MIGRATIONS_KEY) ?? "null");
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

export function migrateSettings(settings: AppSettings): AppSettings {
  const next = { ...settings };
  if (next.colorTheme === "") next.colorTheme = DEFAULT_SETTINGS.colorTheme;
  if (next.iconTheme === "") next.iconTheme = DEFAULT_SETTINGS.iconTheme;
  if (next.fontFamily === LEGACY_DEFAULT_FONT_FAMILY) next.fontFamily = DEFAULT_SETTINGS.fontFamily;
  // Engine values from before both engines became bundled extensions map to
  // the extensions' namespaced ids ("auto" is still "auto").
  if (next.terminalEngine === "ghostty") next.terminalEngine = "ext.perch.ghostty-engine.ghostty";
  if (next.terminalEngine === "xterm") next.terminalEngine = "ext.perch.xterm-engine.xterm";
  // newSessionCwd → defaultProjectsFolder rename: a stored blob written by a
  // pre-rename build carries the old key (invisible to the type, present at
  // runtime); adopt it whenever the new key is still at its "" default.
  // copyJoinWrappedLines (boolean) → copySelection (three modes). Only a
  // stored `false` carried information — it meant "don't join at all", i.e.
  // the new "raw" mode; everything else lands on the "joinWrapped" default
  // this migration's caller already merged in.
  const legacyCopy = next as AppSettings & { copyJoinWrappedLines?: boolean };
  if (legacyCopy.copyJoinWrappedLines === false) next.copySelection = "raw";
  delete legacyCopy.copyJoinWrappedLines;
  const legacy = next as AppSettings & { newSessionCwd?: string };
  if (typeof legacy.newSessionCwd === "string" && legacy.newSessionCwd !== "" && next.defaultProjectsFolder === "") {
    next.defaultProjectsFolder = legacy.newSessionCwd;
  }
  delete legacy.newSessionCwd;
  // Tab groups became the project chips and default on — flip a stored
  // false exactly once so existing users see them, without overriding a
  // post-migration opt-out.
  const migrations = appliedSettingsMigrations();
  if (!migrations.includes("tab-groups-on") || tabGroupsFlippedThisLoad) {
    next.tabGroupsBySession = true;
    if (!migrations.includes("tab-groups-on")) {
      localStorage.setItem(SETTINGS_MIGRATIONS_KEY, JSON.stringify([...migrations, "tab-groups-on"]));
    }
    tabGroupsFlippedThisLoad = true;
  }
  return next;
}

const KEY = "settings";
const KEYBINDINGS_KEY = "keybindings";
const EXTENSION_SETTINGS_KEY = "extensionSettings";
const PINNED_SESSIONS_KEY = "pinnedSessions";
const PROJECTS_KEY = "projects";
const EXTENSION_REGISTRIES_KEY = "extensionRegistries";
const SIDEBAR_TABS_ORDER_KEY = "sidebarTabsOrder";

export function loadSettings(): AppSettings {
  try {
    return migrateSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

// Keybinding overrides (command id → its full replacement binding set), NOT
// the resolved map — unset commands fall through to their defaults in
// keybindings.ts, so a future default change reaches users who never
// customized that command. migrateKeybindingOverrides also upgrades the
// pre-multi-binding shape (command id → single combo string) that may still
// be sitting in an existing user's localStorage.
export function loadKeybindingOverrides(): KeybindingOverrides {
  try {
    return migrateKeybindingOverrides(JSON.parse(localStorage.getItem(KEYBINDINGS_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export function saveKeybindingOverrides(overrides: KeybindingOverrides): void {
  localStorage.setItem(KEYBINDINGS_KEY, JSON.stringify(overrides));
}

// Sparse per-extension setting overrides: `extensionId -> key -> value`.
// Only values that differ from the manifest's declared default are stored —
// same rationale as keybinding overrides above — so a future default change
// still reaches a user who never customized that setting.
export type ExtensionSettingsValues = Record<string, Record<string, unknown>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadExtensionSettings(): ExtensionSettingsValues {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EXTENSION_SETTINGS_KEY) ?? "{}");
    if (!isPlainObject(parsed)) return migrateExtensionSettings({});
    const result: ExtensionSettingsValues = {};
    for (const [extId, values] of Object.entries(parsed)) {
      if (isPlainObject(values)) result[extId] = values;
    }
    return migrateExtensionSettings(result);
  } catch {
    return {};
  }
}

// One-time carry-over of the pre-extraction core `fileTreeGitStatus`
// setting (its feature moved into the git-scm extension): a user who had
// turned tree badges off keeps them off via the extension's own
// gitScm.fileTreeDecorations property. Only `false` needs migrating — the
// old and new defaults are both on. Reads the legacy app-settings blob
// directly since the AppSettings type no longer carries the key.
function migrateExtensionSettings(values: ExtensionSettingsValues): ExtensionSettingsValues {
  try {
    const legacy: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (isPlainObject(legacy)) {
      if (
        legacy.fileTreeGitStatus === false &&
        values["perch.git-scm"]?.["gitScm.fileTreeDecorations"] === undefined
      ) {
        values["perch.git-scm"] = {
          ...values["perch.git-scm"],
          "gitScm.fileTreeDecorations": false,
        };
      }
      // Pre-extraction touch-key settings → the touch-keys extension's own
      // properties. Only non-default values carry over; the customized key
      // layout serializes into the extension's JSON-string setting.
      const tk: Record<string, unknown> = { ...values["perch.touch-keys"] };
      let touched = false;
      if (
        (legacy.touchKeyBar === "always" || legacy.touchKeyBar === "never") &&
        tk["touchKeys.show"] === undefined
      ) {
        tk["touchKeys.show"] = legacy.touchKeyBar;
        touched = true;
      }
      if (legacy.touchKeyBarStyle === "floating" && tk["touchKeys.style"] === undefined) {
        tk["touchKeys.style"] = "floating";
        touched = true;
      }
      if (Array.isArray(legacy.touchKeys) && tk["touchKeys.keys"] === undefined) {
        tk["touchKeys.keys"] = JSON.stringify(legacy.touchKeys);
        touched = true;
      }
      if (touched) values["perch.touch-keys"] = tk;
    }
  } catch {
    // No legacy blob to migrate.
  }
  return values;
}

export function saveExtensionSettings(values: ExtensionSettingsValues): void {
  localStorage.setItem(EXTENSION_SETTINGS_KEY, JSON.stringify(values));
}

// Projects (the recent-projects registry, pin flags included) live outside
// AppSettings on purpose — "Reset Settings to Defaults" writes
// `{...DEFAULT_SETTINGS}` and must not wipe them.
export function sanitizeProjects(parsed: unknown): Project[] {
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: Project[] = [];
  for (const p of parsed) {
    if (!isPlainObject(p) || typeof p.cwd !== "string" || p.cwd === "" || seen.has(p.cwd)) continue;
    seen.add(p.cwd);
    out.push({
      cwd: p.cwd,
      pinned: p.pinned === true,
      lastOpened: typeof p.lastOpened === "number" ? p.lastOpened : 0,
    });
  }
  return out;
}

// One-time migration from the pre-projects pinnedSessions shape
// ({name, cwd}[]): every pin with a usable cwd becomes a pinned project.
// Pins recorded with an empty cwd are dropped — there's no folder to match
// or restore into. The old key is deliberately left in place so a
// downgraded client still finds its pins.
export function projectsFromPins(parsed: unknown): Project[] {
  if (!Array.isArray(parsed)) return [];
  return sanitizeProjects(
    parsed
      .filter((p) => isPlainObject(p) && typeof p.cwd === "string" && p.cwd !== "")
      .map((p) => ({ cwd: (p as { cwd: string }).cwd, pinned: true, lastOpened: Date.now() })),
  );
}

// One-time adoption of the worktrees extension's configuration, from back
// when worktrees lived in an extension rather than in the PROJECTS tree (see
// plans/worktrees-into-projects.md). A value the user actually customised is
// carried over; an app setting they have already changed is never
// overwritten. Reads both the namespaced and bare extension ids, since the
// host namespaces panel/config ids by publisher.
export function adoptWorktreeExtensionSettings(
  settings: AppSettings,
  extensionSettings: ExtensionSettingsValues | undefined,
): AppSettings {
  if (!extensionSettings) return settings;
  const ext = extensionSettings["perch.worktrees"] ?? extensionSettings["worktrees"];
  if (!ext) return settings;
  const next = { ...settings };
  const location = ext["worktrees.location"];
  if (typeof location === "string" && location.trim() && next.worktreeLocation === DEFAULT_SETTINGS.worktreeLocation) {
    next.worktreeLocation = location.trim();
  }
  // worktrees.agents used to migrate into a worktreeRunCommands setting.
  // That setting is gone - the New Worktree form offers the agent registry
  // directly - so there is nothing to carry the old value into.
  return next;
}

export function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw !== null) return sanitizeProjects(JSON.parse(raw));
    return projectsFromPins(JSON.parse(localStorage.getItem(PINNED_SESSIONS_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]): void {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

// Extension registry sources (each an http(s) URL or a local directory path
// serving an index.json catalog — see server/src/registry.ts). Lives outside
// AppSettings, like projects above, so "Reset Settings to Defaults"
// can't wipe a user's configured registries.
export function loadExtensionRegistries(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EXTENSION_REGISTRIES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

export function saveExtensionRegistries(registries: string[]): void {
  localStorage.setItem(EXTENSION_REGISTRIES_KEY, JSON.stringify(registries));
}

// Command palette usage stats, keyed by command id (same ids as
// keybindings.ts' COMMANDS / extension command ids) — count for the
// paletteSortByUsage sort, last (epoch ms) for the always-on "pin last-used
// to row 1" behavior. Lives outside AppSettings, like projects above,
// so "Reset Settings to Defaults" (which writes {...DEFAULT_SETTINGS}) can't
// wipe it. A stale id (uninstalled extension) is harmless — App.tsx's
// paletteCommands memo only looks up ids it's currently listing.
export type CommandUsage = Record<string, { count: number; last: number }>;

const COMMAND_USAGE_KEY = "commandUsage";

function isUsageEntry(value: unknown): value is { count: number; last: number } {
  return (
    isPlainObject(value) &&
    typeof value.count === "number" &&
    typeof value.last === "number"
  );
}

export function loadCommandUsage(): CommandUsage {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COMMAND_USAGE_KEY) ?? "{}");
    if (!isPlainObject(parsed)) return {};
    const result: CommandUsage = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (isUsageEntry(entry)) result[id] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveCommandUsage(usage: CommandUsage): void {
  localStorage.setItem(COMMAND_USAGE_KEY, JSON.stringify(usage));
}

// The three arrangement keys, all persisted the same way: localStorage for
// the instant first render, and the server settings document for the
// cross-device copy (see hooks/useSettingsSync.ts, which owns the sync).
// Each lives outside AppSettings, like projects above, so "Reset Settings to
// Defaults" can't wipe an arrangement the user made by hand.
//
// The parsers themselves live in lib/ with their pure models, because
// client/vitest.config.ts runs a node environment and covers pure logic only
// — a parser sitting next to a localStorage call can't be tested. They are
// re-exported here so callers can keep importing them from one place.
export {
  parsePanelState,
  parseSidebarLayout,
  type PanelState,
  type StoredSidebarLayout,
} from "./lib/sidebarLayout";
export { parseStatusBarLayout, type StatusBarLayout } from "./lib/statusBarLayout";

const SIDEBAR_LAYOUT_KEY = "sidebarLayoutSync";
const STATUS_BAR_LAYOUT_KEY = "statusBarLayout";
const SIDEBAR_PANELS_KEY = "sidebarPanels";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s !== "") : [];
}

// Which tabs sit on which side, any section the user moved into another tab,
// and which panes they hid. Active tabs are deliberately NOT part of this —
// which view you were last looking at is per-device. Null means "no
// cross-device preference yet", in which case useSidebarLayout's own local
// state (including its bundled defaults) stays authoritative rather than
// this overwriting it with nothing.
export function loadSidebarLayout(): StoredSidebarLayout | null {
  try {
    const stored = parseSidebarLayout(JSON.parse(localStorage.getItem(SIDEBAR_LAYOUT_KEY) ?? "null"));
    if (stored) return stored;
    // Pre-right-sidebar builds synced a bare tab order; read it once so a
    // device that only ever knew that key still restores its arrangement.
    const legacy = asStringArray(JSON.parse(localStorage.getItem(SIDEBAR_TABS_ORDER_KEY) ?? "[]"));
    return legacy.length > 0 ? { left: legacy, right: [], panelHome: {}, hiddenPanels: [] } : null;
  } catch {
    return null;
  }
}

export function saveSidebarLayout(layout: StoredSidebarLayout): void {
  localStorage.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify(layout));
}

// The status bar's arrangement: which widgets sit in which group, in what
// order, and which the user switched off. Null on a device that has never
// arranged it, same contract as loadSidebarLayout above.
export function loadStatusBarLayout(): StatusBarLayout | null {
  try {
    return parseStatusBarLayout(JSON.parse(localStorage.getItem(STATUS_BAR_LAYOUT_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function saveStatusBarLayout(layout: StatusBarLayout): void {
  localStorage.setItem(STATUS_BAR_LAYOUT_KEY, JSON.stringify(layout));
}

// The sidebar accordion's arrangement: pane order, which are collapsed, and
// how the expanded ones share the height. Named *Stored to keep it distinct
// from useSidebarLayout's own loadPanelState, which reads the same key and
// then applies that hook's legacy-id rewrites and one-shot migrations on top.
export function loadPanelStateStored(): PanelState | null {
  try {
    return parsePanelState(JSON.parse(localStorage.getItem(SIDEBAR_PANELS_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function savePanelStateStored(state: PanelState): void {
  localStorage.setItem(SIDEBAR_PANELS_KEY, JSON.stringify(state));
}
