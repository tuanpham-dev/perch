// Client-side extension registry: fetches the installed-extension list from
// the server, dynamic-imports each enabled extension's client entry, and
// hands it a small ctx API (commands, file viewers, sidebar panels, active
// context, a fetch scoped to its own server routes). Themes/icon themes are
// NOT activated here — theme.ts and utils/iconThemes.ts read the same
// `extensions` list directly and apply themes without running any
// extension code, since they're just JSON. ctx.app.getFileIcon/getFolderIcon
// do let an extension *query* the already-active icon theme's resolved
// result (see makeContext) — that's read-only exposure of iconThemes.ts's
// own resolver, not extension involvement in loading/activating themes.
import * as ReactNS from "react";
import { extensionApiBase, extensionFileUrl, fetchAgentWindows, fetchExtensions, type AgentWindowDto } from "./api";
import type { CreateTerminalEngine } from "./engines/types";
import { loadCodiconItems } from "./lib/codiconCatalog";
import type { PickItem } from "./lib/pickFilter";
import type { SidebarSide } from "./lib/sidebarLayout";
import type { ExtensionSettingsValues } from "./settings";
import type { EditorCapability, ExtensionInfo, MenuItem } from "./types";
import { getFileExtension } from "./utils/fileExtension";
import { getFileIconResult, getFolderIconResult, subscribeIconTheme } from "./utils/iconThemes";
import type { IconResult } from "./utils/iconThemes";
import { getActiveThemeColors, getActiveTokenColors, subscribeColorTheme } from "./theme";
import type { TokenColorRule } from "./theme";

export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface RegisteredCommand {
  // Namespaced ext.<extensionId>.<id> — see registerCommand.
  id: string;
  label: string;
  defaultBinding?: string;
  run: () => void;
}

// Every prop beyond filePath/active is optional so a viewer that only cares
// about the file (e.g. hello-extension's DemoViewer) needs no changes —
// these are opt-in host affordances the built-in-turned-extension viewers
// (image/markdown/json/csv/media/pdf) rely on.
export interface FileViewerHostProps {
  filePath: string;
  active: boolean;
  // The tab bar's actions container — same portal mechanism ImageView's
  // zoom toolbar and MarkdownView/JsonView/CsvView's controls already use.
  toolbarTarget?: HTMLDivElement | null;
  // Escape hatch back to the default (nvim) view of this same file.
  openInEditor?: (path: string) => void;
  // Opens the app's shared context menu at the given screen position.
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  // Reports dirty/clean transitions so closing the tab can confirm before
  // discarding unsaved edits (CsvView's editable grid).
  setDirty?: (dirty: boolean) => void;
  // Bumped each time an explicit open/preview action re-targets this
  // already-open tab (FILES-tree click or "Preview", terminal link, quick
  // switcher, ctx.app.openViewerTab) — see Tab.extViewerReloadKey. A viewer
  // showing on-disk content should re-fetch when it changes; one holding
  // unsaved edits (a dirty CSV grid) should leave them untouched instead.
  reloadKey?: number;
  // Terminal/UI font size, in px — JsonView sizes its tree to match.
  fontSize?: number;
}

export type FileViewerMode = "default" | "preview";

// A viewer's registered mode: a fixed value, or a thunk re-read on every
// lookup — for a viewer whose click action is user-configurable (markdown's
// markdown.clickAction setting), so flipping the setting applies live
// without re-registering the viewer. See resolveViewerMode.
export type FileViewerModeSource = FileViewerMode | (() => FileViewerMode);

export interface RegisteredFileViewer {
  id: string;
  extensionId: string;
  // Lowercase file extensions without the leading dot, e.g. ["demo"].
  extensions: string[];
  // "default" (image/media/pdf): a FILES-tree click opens this viewer
  // directly. "preview" (markdown/json/yaml/csv): a click still opens nvim;
  // this viewer is reached via the hover icon / "Preview" menu item /
  // Shift+Enter instead. See findFileViewerFor.
  mode: FileViewerModeSource;
  // Whether the FILES-tree context menu offers "Open in Editor" (nvim) as an
  // escape hatch from this "default"-mode viewer — true for image (editing
  // e.g. an SVG's source) and any third-party binary viewer, false for
  // media/pdf (nvim on audio/video/PDF bytes isn't useful). Ignored for
  // "preview"-mode viewers, which already open in nvim by default. Defaults
  // to true when omitted.
  editorFallback: boolean;
  component: ReactNS.ComponentType<FileViewerHostProps>;
}

export interface SidebarPanelHostProps {
  // The panel header's actions container — same portal mechanism
  // FileViewerHostProps.toolbarTarget uses for tab-bar controls. Lets a
  // panel put its own header-row buttons (refresh, sync, …) next to its
  // title instead of inside its scrollable body. null until the header
  // has mounted.
  actionsTarget?: HTMLDivElement | null;
  // Opens the app's shared context menu at the given screen position — same
  // capability FileViewerHostProps.showMenu gives file viewers.
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  // The app's shared confirm dialog (message → resolves true on confirm) —
  // for destructive panel actions like the ports panel's Kill process.
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

// "tab": the panel is its own sidebar tab (SCM, Search). "explorer": the
// panel is an accordion section inside the Explorer tab, alongside the
// built-in SESSIONS/FILES sections — it takes part in the accordion's
// ordering/collapse/resize persistence under its namespaced id. "run": the
// same accordion treatment inside the Run tab (TASKS/PORTS), which has no
// built-in sections and therefore only appears in the tab strip while at
// least one non-hidden run panel is registered.
export type SidebarPanelLocation = "tab" | "explorer" | "run" | "commands";

export interface RegisteredSidebarPanel {
  // Namespaced ext.<extensionId>.<id> — used as the sidebar's PanelId.
  id: string;
  title: string;
  // Codicon name for the sidebar tab strip. Falls back to "extensions" when
  // omitted (see Sidebar.tsx's tab icon resolution).
  icon?: string;
  // Small count shown on this panel's sidebar tab (e.g. changed-file count
  // for Source Control) — null/0/undefined shows no badge. Set via
  // ctx.app.setSidebarBadge, not at registration time, since it typically
  // depends on data fetched after activate() runs.
  badge?: number | null;
  location: SidebarPanelLocation;
  // Whether an accordion section ("explorer"/"run") starts collapsed for
  // users with no stored state for it (the tab location ignores this).
  defaultCollapsed?: boolean;
  // Accordion sections only: hides this section (and, for the Run tab, lets
  // the tab itself disappear once none of its sections are visible) — for a
  // panel that has nothing to show in the current context, e.g. the tasks
  // panel with no active cwd. Set via ctx.app.setSidebarPanelVisible, not at
  // registration time, same as badge above.
  hidden?: boolean;
  // The already-namespaced id of the tab this section lives in, when it is
  // another panel's rather than one of its own. See PanelLike.defaultTab.
  defaultTab?: string;
  // Accordion sections only: default placement weight. Consulted the one
  // time a panel's id first joins the stored accordion order (Sidebar.tsx's
  // reconciliation) — an ordered panel is inserted before same-location
  // panels with a greater (or no) declared order, instead of landing
  // wherever async extension activation happened to append it. Never moves
  // an id the user already has stored, so drags always win.
  order?: number;
  component: ReactNS.ComponentType<SidebarPanelHostProps>;
}

// What a window action's isVisible/onClick are evaluated against — a plain
// snapshot of one SESSIONS-tree window row, not a live handle.
export interface WindowActionContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  // The window's active pane's current foreground command (see TerminalWindow.command)
  // — e.g. isVisible: (w) => w.command === "claude".
  command: string;
}

export interface RegisteredWindowAction {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Codicon name for the row button (same Icon component the built-in
  // window-kill-button uses).
  icon: string;
  title: string;
  // Re-evaluated by Sidebar.tsx on every window row render (the session
  // list already polls every ~3s — see useSessions.ts — so this is
  // reactive for free, no extra plumbing needed).
  isVisible(ctx: WindowActionContext): boolean;
  onClick(ctx: WindowActionContext): void;
  // Also render this action in the tab bar's actions area (next to the
  // built-in per-tab controls) whenever a group's active tab is the
  // matching terminal window — see App.tsx's tabExtrasFor. Defaults to
  // false: most window actions are row-only.
  showInTabBar?: boolean;
}

// An item contributed to the FILES-tree context menu of a single file or
// directory row. isVisible is re-evaluated on every menu open (menus are
// built on demand), so it can read whatever state the extension keeps. The
// bulk menu shown for a multi-row selection is deliberately not a
// contribution point — see fileMultiMenuItems.
export interface RegisteredFileMenuItem {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  label: string;
  // Codicon name for the menu's leading gutter (MenuItem.icon).
  icon?: string;
  // Placement weight among the extension items (ascending; unset sorts
  // last, then registration order). Built-in items always come first.
  order?: number;
  isVisible(path: string, isDir: boolean): boolean;
  onClick(path: string): void;
}

// What a tab-group menu item's isVisible/onClick are evaluated against — a
// plain snapshot, same convention as WindowActionContext. A tab group is a
// session, so cwd is that session's active window's directory (null
// while it has no live window, e.g. a group whose session just died).
export interface TabGroupContext {
  sessionName: string;
  cwd: string | null;
}

// An item contributed to a tab-group chip's windows dropdown (the chip's
// arrow button — App.tsx's chipWindowMenuItems), below the window list and
// "New Window". Deliberately that menu rather than the chip's right-click
// menu, which is about the group itself (collapse/color/move/close) while
// this dropdown is where per-session actions already live. Same per-open
// evaluation and fail-safe posture as RegisteredFileMenuItem.
// An extension-owned sidebar tab that holds no panel of its own — a
// container the user drops panes into (the custom-tabs extension's tabs).
// Always shown in its strip, even empty. See ExtensionContext.registerSidebarTab.
export interface RegisteredSidebarTab {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  title: string;
  // Codicon name for the tab strip.
  icon: string;
  // The side a newly placed tab joins. Once the tab is in the stored
  // layout, that placement wins (the user may have dragged it).
  side: SidebarSide;
}

export interface SidebarTabHandle {
  // The namespaced id — what SidebarTabMenuContext.tabId carries.
  id: string;
  update(patch: { title?: string; icon?: string }): void;
  // Shows the sidebar holding the tab (if hidden) and switches to it.
  reveal(): void;
  // Deletes the tab: it leaves the strip and every pane in it returns to
  // its default home. Not needed on deactivate, which only unregisters and
  // keeps where panes were (they come back with the tab).
  remove(): void;
}

// What a tab strip right-click is on: a tab, or the strip's empty area
// (tabId null), in one of the two sidebars.
export interface SidebarTabMenuContext {
  tabId: string | null;
  side: SidebarSide;
}

// An item for the sidebar tab strip's right-click menu, after the built-in
// move item. Same per-open evaluation as RegisteredTabGroupMenuItem.
export interface RegisteredSidebarTabMenuItem {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  label: string;
  order?: number;
  isVisible(ctx: SidebarTabMenuContext): boolean;
  onClick(ctx: SidebarTabMenuContext): void;
}

export interface RegisteredTabGroupMenuItem {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  label: string;
  // Codicon name for the menu's leading gutter (MenuItem.icon).
  icon?: string;
  // Placement weight among the extension items (ascending; unset sorts
  // last, then registration order). Built-in items always come first.
  order?: number;
  isVisible(ctx: TabGroupContext): boolean;
  onClick(ctx: TabGroupContext): void;
}

export interface ExtensionContext {
  React: typeof ReactNS;
  registerCommand(cmd: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    // Defaults to "default" when omitted, matching v1 extensions (like
    // hello-extension) that predate the preview/default distinction. A
    // thunk is re-read on every lookup — see FileViewerModeSource.
    mode?: FileViewerModeSource;
    // See RegisteredFileViewer.editorFallback. Defaults to true.
    editorFallback?: boolean;
    component: ReactNS.ComponentType<FileViewerHostProps>;
  }): void;
  // Asynchronously claims a file open that would otherwise land in nvim —
  // see RegisteredFileOpenInterceptor. Runs after "default"-mode viewer
  // matching (so image/media/pdf viewers keep their paths) and must fail
  // open: any thrown error falls through to the editor.
  registerFileOpenInterceptor(intercept: (path: string) => Promise<boolean>): void;
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    // Codicon name shown on this panel's sidebar tab. Defaults to
    // "extensions" when omitted.
    icon?: string;
    // Where the panel renders — its own sidebar tab (default) or an
    // accordion section inside the Explorer or Run tab. See
    // SidebarPanelLocation.
    location?: SidebarPanelLocation;
    // Renders this panel as a PANE OF another panel of THIS extension,
    // named by that panel's unnamespaced registration id (git-scm's
    // "commits" passes "git"). The two become stacked, separately
    // collapsible sections of that one tab, and this one can be dragged to
    // any other tab afterwards — but it never gets a tab-strip entry of its
    // own, so use it for a section that only makes sense next to its host,
    // not for a second standalone panel. Cross-extension homing isn't
    // offered: the target tab may not exist yet (or at all) at activation
    // time.
    defaultTab?: string;
    // Accordion locations only: collapsed by default for users with no
    // stored accordion state for this panel.
    defaultCollapsed?: boolean;
    // Accordion locations only: default placement weight — see
    // RegisteredSidebarPanel.order.
    order?: number;
    // Default keybinding (keybindings.ts combo syntax, e.g. "ctrl+shift+KeyG")
    // for the auto-registered "Sidebar: Focus <title>" command that reveals
    // the sidebar (if hidden) and switches to this tab / expands this
    // section — see focusSidebarTab/focusAccordionPanel. For "tab" panels,
    // omitting it omits the command entirely (most panels don't need a
    // dedicated shortcut cluttering the palette); accordion panels
    // ("explorer"/"run") always get the command (unbound when omitted),
    // matching the built-in sections' own always-present focus commands.
    focusBinding?: string;
    component: ReactNS.ComponentType<SidebarPanelHostProps>;
  }): void;
  // Adds a sidebar tab with no panel of its own, which the user fills by
  // moving panes into it. Stays visible while empty. Re-registering an id
  // updates its title and icon. Absent on hosts older than this API, so
  // feature-detect with `typeof ctx.registerSidebarTab === "function"`.
  registerSidebarTab(tab: { id: string; title: string; icon: string; side?: SidebarSide }): SidebarTabHandle;
  // Contributes an item to the sidebar tab strip's right-click menu (on a
  // tab or on the strip's empty area). See RegisteredSidebarTabMenuItem.
  registerSidebarTabMenuItem(item: {
    id: string;
    label: string;
    order?: number;
    isVisible: (ctx: SidebarTabMenuContext) => boolean;
    onClick: (ctx: SidebarTabMenuContext) => void;
  }): void;
  // Contributes a button to the SESSIONS tree's window rows (next to the
  // built-in kill-window button), shown only on rows where isVisible
  // returns true — e.g. a preview action for windows running a specific
  // command. Generic: not tied to any particular command or extension.
  registerWindowAction(action: {
    id: string;
    icon: string;
    title: string;
    isVisible: (ctx: WindowActionContext) => boolean;
    onClick: (ctx: WindowActionContext) => void;
    showInTabBar?: boolean;
  }): void;
  // Contributes an item to the FILES-tree context menu for a file or
  // directory row, appended after the built-in items behind a separator.
  // See RegisteredFileMenuItem.
  registerFileMenuItem(item: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    isVisible: (path: string, isDir: boolean) => boolean;
    onClick: (path: string) => void;
  }): void;
  // Contributes an item to a tab-group chip's windows dropdown, appended
  // after "New Window" behind a separator. See RegisteredTabGroupMenuItem.
  registerTabGroupMenuItem(item: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    isVisible: (ctx: TabGroupContext) => boolean;
    onClick: (ctx: TabGroupContext) => void;
  }): void;
  // Contributes per-row decorations (badge + row class + tooltip) to the
  // FILES tree, and optionally a root decoration (the branch pill slot).
  // provideDecoration is synchronous — serve from a cache the extension
  // maintains itself, then call the returned refresh() after that cache
  // changes so the tree re-renders with the new answers.
  registerFileDecorationProvider(provider: {
    id: string;
    provideDecoration: (path: string, isDir: boolean) => FileDecoration | undefined;
    provideRootDecoration?: (rootPath: string) => RootDecoration | undefined;
  }): { refresh(): void };
  // Contributes badges to SESSIONS-tree window rows (where the built-in
  // subagent count rendered before extraction). Same sync-from-cache +
  // refresh() contract as registerFileDecorationProvider.
  registerSessionDecorationProvider(provider: {
    id: string;
    provideWindowDecoration: (ctx: SessionDecorationContext) => SessionDecoration | undefined;
    onClick?: (anchorRect: DOMRect, ctx: SessionDecorationContext) => void;
  }): { refresh(): void };
  // Supplies a terminal engine (the CreateTerminalEngine seam from
  // engines/types) — TerminalView resolves the engine setting against this
  // registry after extensions settle. See engines/index.ts.
  registerTerminalEngine(engine: { id: string; label: string; create: CreateTerminalEngine }): void;
  // Supplies an editor for the `editor` setting — the implementation behind
  // this extension's contributes.editors declaration (which is what the
  // Settings picker lists). Declare only the capabilities actually
  // implemented: resolution falls back to nvim per capability, so an editor
  // that omits openDiff simply never receives diffs. Open your own tab from
  // these callbacks via ctx.app.openViewerTab.
  registerEditor(editor: {
    id: string;
    label: string;
    capabilities: EditorCapability[];
    openFile(path: string, line?: number): Promise<void>;
    openDiff?(req: DiffRequest): Promise<void>;
    openMerge?(req: MergeRequest): Promise<void>;
  }): void;
  // Contributes result rows to the quick switcher (non-command mode),
  // alongside the core tab/window/session/file sources. Same sync-from-
  // cache + refresh() contract as the decoration providers.
  registerQuickSwitcherProvider(provider: {
    id: string;
    provideResults: (query: string) => QuickSwitcherItem[];
  }): { refresh(): void };
  // Renders per-terminal UI in the touch-key bar's old slots — see
  // TerminalAccessoryContext/TerminalAccessoryPlacement.
  registerTerminalAccessory(accessory: {
    id: string;
    placement: TerminalAccessoryPlacement;
    component: ReactNS.ComponentType<TerminalAccessoryHostProps>;
  }): void;
  // Renders a component once over the editor area (the .main region), on top
  // of whatever tab is active — a terminal, Settings, a viewer. Unlike a
  // terminal accessory (which only mounts inside a focused TerminalView),
  // this is app-global. The host draws it into a pointer-events:none overlay
  // layer, so the component must opt its own interactive surfaces back into
  // pointer-events. See AppOverlayContext/AppOverlayHostProps.
  registerAppOverlay(overlay: {
    id: string;
    component: ReactNS.ComponentType<AppOverlayHostProps>;
  }): void;
  // Renders a component in the app's bottom status bar — a compact readout
  // with an optional click action (the Claude usage extension's token
  // counter is the motivating case). `placement` picks the bar's left or
  // right group (default "right", where core's own readouts also live), and
  // `order` sorts within it. The bar is hidden entirely on phones/tablets,
  // so an item never renders there. See StatusBarItemContext.
  registerStatusBarItem(item: {
    id: string;
    // Names the item in the gear menu's Status Bar list, where the user
    // switches it on and off. Defaults to the extension's display name,
    // which is enough for an extension contributing a single item.
    title?: string;
    placement?: StatusBarItemPlacement;
    order?: number;
    // A dotted boolean key from this extension's own manifest settings. Given
    // one, that setting IS the item's switch: the Status Bar list reads and
    // writes it instead of the app's hidden list, so an extension that
    // already offers "show this in the status bar" keeps one control rather
    // than gaining a second. The item renders unless the value is false.
    visibilitySetting?: string;
    component: ReactNS.ComponentType<StatusBarItemHostProps>;
  }): void;
  // Renders a custom component inside this extension's Settings section,
  // below its scalar configuration controls.
  registerSettingsComponent(component: { id: string; component: ReactNS.ComponentType }): void;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    // line jumps to that line when the path opens in nvim (ignored by a
    // "default"-mode viewer like image/media/pdf — same as a FILES-tree
    // ctrl+click "file:line" link, see openFileOrViewer).
    openFileTab(path: string, line?: number): void;
    // Opens (or activates, if already open) a tab for one of this
    // extension's own registered file viewers, bypassing the normal
    // extension-matching a FILES-tree click goes through — for a viewer
    // that's never auto-matched to a file extension (registerFileViewer's
    // `extensions: []`) and is only ever reached this way, e.g. a diff
    // viewer opened from a source-control panel. opts.title overrides the
    // tab-bar label (default: the path's basename); re-calling this for an
    // already-open (viewerId, path) tab also updates its title, e.g. to
    // reflect a working-tree/staged toggle.
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
    // Closes an already-open viewer tab (opened via openViewerTab above)
    // for this extension's own viewerId, with no unsaved-changes confirm —
    // for a draft-style tab the extension is retiring right after its own
    // save flow already handled the content, since extensions otherwise
    // have no way to close a tab they opened. No-op if path isn't currently
    // open under this extension's viewerId.
    closeViewerTab(viewerId: string, path: string): void;
    // Bumps the FILES tree's refresh key so its git-status badges reflect a
    // change this extension just made (stage/commit/discard/pull) without
    // waiting for the tree's own poll.
    refreshFiles(): void;
    // Sets (or clears, via null/0) the count badge on one of this
    // extension's own registered sidebar panels (panelId is the same
    // unnamespaced id passed to registerSidebarPanel). No-ops if that
    // panel was never registered.
    setSidebarBadge(panelId: string, badge: number | null): void;
    // Shows/hides one of this extension's own accordion sections (same
    // unnamespaced panelId as setSidebarBadge) — for a panel with nothing to
    // show in the current context. A hidden section isn't rendered in its
    // accordion, and the Run tab drops out of the tab strip once none of its
    // sections are visible. No-ops if that panel was never registered.
    setSidebarPanelVisible(panelId: string, visible: boolean): void;
    // Reveals one of this extension's own sidebar panels (same unnamespaced
    // panelId as setSidebarBadge): reveals the sidebar if hidden, switches to
    // the panel's own tab, and expands/focuses its accordion section — the
    // same path its auto-registered "Sidebar: Focus <title>" command takes,
    // minus that command's toggle-hide-when-already-active branch, since a
    // command that opens a panel's UI must never end with it hidden. No-ops
    // if that panel was never registered.
    revealSidebarPanel(panelId: string): void;
    // Opens the PROJECTS tree's create-worktree form, revealing the tree
    // first. runCommandIndex preselects one of the configured worktree run
    // agents (the app's registry, Settings → AI Providers); omit it for none.
    newWorktree(opts?: { runCommandIndex?: number }): void;
    // Starts Clean Up Worktrees on the active repository project (or the
    // first one with linked worktrees), revealing the PROJECTS tree first:
    // lists the worktrees that are safe to remove (folder already deleted, or
    // clean and merged, and no session) and removes them once the user
    // confirms. Branches are kept. A no-op when no project has worktrees.
    cleanUpWorktrees(): void;
    // Opens a session's active window as a window-tab. When no session
    // by that name exists, opts.createCwd creates it there first (same
    // create-then-open path the sidebar's own pinned-session restore uses);
    // without createCwd, a missing session surfaces an error to the user.
    // Session-name collisions surface the backend's own "duplicate session" error —
    // pick the name accordingly.
    openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
    // Kills a session and closes its tabs, including the synthetic
    // per-window attachments that killing the session behind the app's back would leave behind.
    // Deliberately runs no confirmation of its own (unlike the sidebar's own
    // Close Project, which is gated by the confirmBeforeKill setting): the
    // caller owns the prompt, so an extension that already confirmed a larger
    // destructive action doesn't double-prompt. Confirm before calling.
    killSession(sessionName: string): void;
    // The app's own dialogs. confirmDialog resolves true on confirm;
    // promptDialog resolves the entered text, or null on cancel; pickItem
    // shows a filterable list and resolves the chosen item's id, or null;
    // pickIcon is pickItem over every codicon (searchable by its tags too),
    // resolving the icon name. Each resolves false/null if the app hasn't
    // finished mounting.
    confirmDialog(message: string, confirmLabel?: string): Promise<boolean>;
    promptDialog(message: string, defaultValue?: string): Promise<string | null>;
    pickItem(opts: { title: string; items: PickItem[]; current?: string; placeholder?: string }): Promise<string | null>;
    pickIcon(opts?: { title?: string; current?: string }): Promise<string | null>;
    // Opens a path in whichever editor the `editor` setting selects (nvim by
    // default) — the same dispatch a FILES-tree click ends in, minus the
    // viewer matching. `line` jumps there when the editor supports it.
    openInEditor(path: string, line?: number): void;
    // Shows a two-sided diff in the selected editor. Resolves false when no
    // editor claims the "diff" capability, which is the caller's cue to fall
    // back to its own view — git-scm keeps its unified DiffView for exactly
    // that, and as a secondary action either way.
    openDiff(req: DiffRequest): Promise<boolean>;
    // Opens a conflicted working file in the selected editor. Same false
    // contract as openDiff.
    openMerge(req: MergeRequest): Promise<boolean>;
    // Whether some registered viewer can show a *rendered* preview of this
    // path — markdown, JSON/YAML, CSV and the like. The same question the
    // FILES tree asks before drawing its hover Preview icon.
    canPreview(path: string): boolean;
    // Opens that preview, if there is one. A no-op otherwise, so a caller can
    // simply offer the action wherever canPreview says yes. Unlike
    // openViewerTab this reaches *another* extension's viewer, which is the
    // point: an editor showing a .md file has no way to render it itself.
    openPreview(path: string): void;
    // One-shot: returns (and clears) a pending "files to include" glob
    // pushed by the FILES-tree "Find in Folder…" menu item, or null if
    // none is pending. Only the search extension's activate() is expected
    // to call this — see requestFindInFolder/consumePendingFindInFolderGlob.
    consumeFindInFolderGlob(): string | null;
    // Which agent is running in a terminal, and which process it is (see
    // core's agentWindows.ts): matched by the window's foreground command,
    // else by a descendant process named after an agent's `program`, so an
    // agent behind a wrapper is still found, whichever terminal backend
    // runs the window. `agentPid` is for reading the files an agent keeps
    // about itself. Resolves null / an empty array for a session that isn't
    // there, and never throws.
    agentForWindow(session: string, windowIndex: number): Promise<AgentWindowDto | null>;
    agentForSession(session: string): Promise<AgentWindowDto[]>;
    // Resolves a file/folder name against the currently active icon theme
    // (same resolver the FILES tree and tab bar use) — read-only query, the
    // extension never loads or activates a theme itself. `kind: "none"`
    // means no icon theme is active, or it has no icon for that name; the
    // extension's own FileIcon copy already renders that as nothing.
    getFileIcon(fileName: string): IconResult;
    getFolderIcon(folderName: string, expanded: boolean): IconResult;
    // Fires with no arguments whenever the active icon theme finishes
    // loading or changes in Settings — call getFileIcon/getFolderIcon again
    // to get the fresh result, same shape as settings.onDidChange below.
    onDidChangeIconTheme(cb: () => void): () => void;
    // The active color theme's raw workbench `colors` and TextMate
    // `tokenColors` rules — for an extension that runs its own real
    // scope-resolving tokenizer (e.g. text-editor's Shiki-based syntax
    // highlighting) rather than the app's own approximate CSS-var chains.
    // Empty ({}/[]) when no theme is active or it defines neither.
    getThemeColors(): Record<string, string>;
    getTokenColors(): TokenColorRule[];
    // Fires with no arguments whenever the active color theme finishes
    // loading or changes in Settings — call getThemeColors/getTokenColors
    // again for the fresh values, same shape as onDidChangeIconTheme above.
    onDidChangeColorTheme(cb: () => void): () => void;
    // Runs a command by id — a built-in command (e.g. "tab.next",
    // "quickSwitcher.toggle") or an extension command by its namespaced id
    // (ext.<extensionId>.<id>). No-ops on an unknown id, or one whose scope
    // can't be dispatched globally (terminal/files/sessions-scoped commands
    // aren't runnable this way — see getCommands, which omits them).
    executeCommand(commandId: string): void;
    // Lists the commands executeCommand can actually run right now — every
    // global built-in command plus every registered extension command, as
    // {id,label}. Snapshot, not live; call again after the registry changes.
    getCommands(): { id: string; label: string }[];
    // Returns keyboard focus to the active terminal — for an extension UI
    // (a dialog, an overlay) that stole focus and whose close should let
    // the user keep typing at the prompt (e.g. press Enter on a command
    // the extension just typed there). No-op when no terminal tab is
    // focused.
    focusActiveTerminal(): void;
  };
  // fetch() scoped to this extension's own server hook, mounted at
  // /api/ext/<extensionId> — 404s if the extension has no server entry or
  // is disabled.
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  // Resolves an extension-relative path (a bundled stylesheet, an image) to
  // a fetchable URL — same route registerFileViewer's own client entry is
  // dynamic-imported from.
  assetUrl(relPath: string): string;
  // This extension's contributes.configuration values (declared default,
  // overridden by whatever the user set in Settings). get() takes the full
  // dotted key exactly as declared in the manifest. onDidChange fires with
  // no arguments — call get() again for whichever key you care about — same
  // as subscribeExtensionRegistry's plain re-render nudge.
  settings: {
    get(key: string): unknown;
    // Writes one of this extension's own configuration values — same
    // store the Settings UI edits (server-synced), so onDidChange fires
    // and the value persists.
    set(key: string, value: unknown): void;
    onDidChange(cb: () => void): () => void;
  };
}

// A single row's decoration in the FILES tree — the visual vocabulary
// GitStatusBadge/git-status-* row classes used before extraction, made
// generic. Colors live in the providing extension's own stylesheet (it
// supplies a className), not in a color value here, so theming stays CSS.
export interface FileDecoration {
  // Short badge text rendered at the row's right edge (e.g. "M").
  badge?: string;
  // Tooltip for the badge (falls back to the badge text).
  tooltip?: string;
  // Extra class(es) applied to the whole row (e.g. "git-status-modified" —
  // row coloring/dimming is the provider's stylesheet's job).
  className?: string;
}

// Decoration for the tree's root header (the branch pill, generically):
// label is the pill text.
export interface RootDecoration {
  label: string;
  tooltip?: string;
}

export interface RegisteredFileDecorationProvider {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Synchronous, from provider-owned cache — called per visible row on
  // every tree render, so it must be a plain lookup, never a fetch.
  provideDecoration(path: string, isDir: boolean): FileDecoration | undefined;
  provideRootDecoration?(rootPath: string): RootDecoration | undefined;
}

// What a session-window decoration's provide/onClick are evaluated against —
// same plain-snapshot shape as WindowActionContext.
export interface SessionDecorationContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

// A badge on a SESSIONS-tree window row (the subagent count, generically).
export interface SessionDecoration {
  badge: string;
  tooltip?: string;
  className?: string;
}

export interface RegisteredSessionDecorationProvider {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Synchronous, from provider-owned cache — see provideDecoration above.
  provideWindowDecoration(ctx: SessionDecorationContext): SessionDecoration | undefined;
  // Clicking the badge. anchorRect is the badge's bounding rect so the
  // extension can position its own popover (rendered via its own portal
  // root, torn down in deactivate).
  onClick?(anchorRect: DOMRect, ctx: SessionDecorationContext): void;
}

// A quick-switcher result contributed by an extension provider — rendered
// alongside the core tab/window/session/file rows.
export interface QuickSwitcherItem {
  label: string;
  // Short chip text shown where core rows show their group ("tab", "file",
  // …). Defaults to "ext".
  tag?: string;
  // secondary mirrors core rows' Shift+Enter/Shift+click argument; items
  // without a secondary action can ignore it.
  run: (secondary: boolean) => void;
}

export interface RegisteredQuickSwitcherProvider {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Synchronous, called per keystroke with the current (non-command-mode)
  // query — answer from provider-owned cached state and self-limit result
  // counts; call the registration handle's refresh() when that cache
  // changes so an open switcher re-queries.
  provideResults(query: string): QuickSwitcherItem[];
}

// A shell-integration command lifecycle event (plans/warp-features.md),
// relayed from the server's "commandEvent" WS frame. Also dispatched
// app-wide as a `perch:command-event` CustomEvent on window (detail =
// this shape) so non-accessory consumers (e.g. a command-history switcher
// provider) can react without new host API surface.
export interface TerminalCommandEvent {
  pane: string;
  sessionName: string;
  event: "start" | "end";
  command: string;
  cwd: string;
  exitCode?: number;
  durationMs?: number;
}

// The per-terminal context handed to a terminal accessory's component —
// shaped from exactly what the extracted touch-key bar consumed (see
// extensions/touch-keys), no speculative surface.
export interface TerminalAccessoryContext {
  // Whether this terminal is the focused one (accessories usually render
  // only for it).
  focused: boolean;
  // matchMedia("(pointer: coarse) and (hover: none)") — a real phone or
  // tablet, not a touch-screen laptop.
  mobilePointer: boolean;
  // The pane's current foreground command (for when-clause gating).
  command: string;
  // The most recent shell-integration command event for this terminal's
  // session, or null before the first one (including when shell integration
  // isn't sourced at all).
  lastCommandEvent: TerminalCommandEvent | null;
  // The app's sticky-Ctrl state for this terminal (applied to typed input
  // by TerminalView's own input pipeline) — accessories may display and
  // toggle it.
  stickyCtrl: boolean;
  toggleStickyCtrl(): void;
  // Raw bytes to the pty (mouse-report/keystroke channel).
  sendInput(data: string): void;
  // Local-echo-aware text send (e.g. voice transcripts) — buffers through
  // the echo overlay when local echo is active instead of going straight
  // to the pty.
  sendText(text: string): void;
  // Routes a picked image through the terminal's upload pipeline.
  uploadImage(file: File): void;
  // Multi-image counterpart — uploads all and inserts their paths as one
  // no-submit block (bracketed paste when the pane's program supports it,
  // else space-separated). Use for a multi-select picker or a multi-drop.
  uploadImages(files: File[]): void;
  // Suppresses (or restores) the mobile soft keyboard for this terminal:
  // the engine's hidden input element gets inputmode="none", so it stays
  // focusable — hardware keys and accessory-drawn keyboards keep working —
  // but tapping the terminal no longer summons the OS keyboard. The
  // request is remembered across engine remounts and no-ops on an engine
  // that doesn't implement the seam's setSoftKeyboardSuppressed. Make this
  // opt-in via your own setting: while suppressed, YOUR accessory is the
  // only on-screen text input (no OS autocomplete/dictation/IME).
  setSoftKeyboardSuppressed(suppressed: boolean): void;
  // Positioning container for "overlay" accessories (the terminal body).
  containerRef: ReactNS.RefObject<HTMLDivElement | null>;
}

export interface TerminalAccessoryHostProps {
  context: TerminalAccessoryContext;
}

// "bar": rendered after the terminal body, in document flow (the docked
// touch-key bar's slot). "overlay": rendered inside the terminal body's
// positioning context (the floating touch keys' slot).
export type TerminalAccessoryPlacement = "bar" | "overlay";

export interface RegisteredTerminalAccessory {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  placement: TerminalAccessoryPlacement;
  component: ReactNS.ComponentType<TerminalAccessoryHostProps>;
}

// The context handed to an app-global overlay (registerAppOverlay) — kept
// minimal, sized to what a bottom swipe/gesture strip needs. No per-terminal
// "focused" here: the overlay is drawn once over the editor area regardless
// of which tab is active.
export interface AppOverlayContext {
  // matchMedia("(pointer: coarse) and (hover: none)") — a real phone or
  // tablet, not a touch-screen laptop.
  mobilePointer: boolean;
  // The overlay layer element (a bottom-anchored positioning context inside
  // .main) — for an overlay that clamps/positions against the editor bounds.
  containerRef: ReactNS.RefObject<HTMLDivElement | null>;
}

export interface AppOverlayHostProps {
  context: AppOverlayContext;
}

export interface RegisteredAppOverlay {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  component: ReactNS.ComponentType<AppOverlayHostProps>;
}

// The context handed to a status-bar item (registerStatusBarItem). Smaller
// than every other host context on purpose: an item is a 22px-tall readout,
// not a panel, so it gets a way to show a menu, a way to open a popover
// above the bar, and nothing else. Anything richer belongs in a sidebar
// panel the item can reveal.
export interface StatusBarItemContext {
  // matchMedia("(pointer: coarse) and (hover: none)") — a real phone or
  // tablet. The whole bar is hidden there, so an item that renders is on a
  // pointer device; the flag is passed for parity with the other contexts.
  mobilePointer: boolean;
  // The app's shared context menu, for an item whose click is a short list
  // of actions.
  showMenu(x: number, y: number, items: MenuItem[]): void;
  // The app's shared confirm dialog (message → resolves true on confirm) —
  // the same capability SidebarPanelHostProps gives a panel, since a status
  // bar item's popover can offer the same destructive actions its panel
  // does (the ports item's Kill process). Preferred over window.confirm:
  // the native dialog blurs the window, and the popover closes on blur.
  confirmDialog(message: string, confirmLabel?: string): Promise<boolean>;
  // Opens `content` in a floating panel anchored above the bar, clamped to
  // the viewport (the host owns positioning and dismissal — outside click,
  // Escape, blur). Pass the trigger's own getBoundingClientRect(). Calling
  // it again while THIS item's popover is open closes it, so a trigger
  // button toggles without tracking any state of its own; another item's
  // call replaces it. closePopover() closes it outright.
  //
  // `content` is held as the node it was at click time — the host has no way
  // to rebuild it from the item's later renders. A popover showing anything
  // that moves therefore wants a COMPONENT (<MyPopover />) that subscribes to
  // its own data, not a tree closing over the item's current state, which
  // would freeze the moment it opened.
  openPopover(anchor: DOMRect, content: ReactNS.ReactNode): void;
  closePopover(): void;
}

export interface StatusBarItemHostProps {
  context: StatusBarItemContext;
}

// "left" and "right" are the bar's two groups; core's own readouts sit at
// the right end, after any right-placed extension items.
export type StatusBarItemPlacement = "left" | "right";

export interface RegisteredStatusBarItem {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  // Label for the Status Bar show/hide list; the extension's display name
  // stands in when absent.
  title?: string;
  // The extension setting that switches this item on and off, if it owns
  // one — see registerStatusBarItem.
  visibilitySetting?: string;
  placement: StatusBarItemPlacement;
  // Sort key within the group (ascending, default 0); ties break on id, so
  // ordering is stable however activation happened to interleave.
  order: number;
  component: ReactNS.ComponentType<StatusBarItemHostProps>;
}

// A custom component rendered inside the extension's own Settings section,
// below its scalar configuration controls — for config that outgrows the
// scalar property renderer (the touch-keys drag-and-drop layout editor).
// Reads/writes its values through ctx.settings (get/set/onDidChange).
export interface RegisteredSettingsComponent {
  // Namespaced ext.<extensionId>.<id>.
  id: string;
  extensionId: string;
  component: ReactNS.ComponentType;
}

// A terminal engine implementation supplied by an extension — the app's
// rendering surface itself. Activated lazily, on demand, by
// engines/index.ts's loadEngine() — not part of loadExtensions()'s blanket
// activation sweep (see its comment). The xterm-engine extension is a
// *required builtin* (see the server's perch.required handling), so
// loadEngine's fallback path always has one to activate even if the
// resolved/selected engine is unavailable.
export interface RegisteredTerminalEngine {
  // Namespaced ext.<extensionId>.<id> — what the terminalEngine setting
  // stores.
  id: string;
  extensionId: string;
  // Human label for the Settings engine select.
  label: string;
  create: CreateTerminalEngine;
}

// ---- Editors ----
// The seam behind the `editor` setting: which editor opens a file, a git
// diff, or a merge conflict. Mirrors the terminal-engine seam — extensions
// declare editors in their manifest (contributes.editors, so the Settings
// picker lists them without activating anything) and supply the
// implementation here at activation. Resolution is per *capability*, not per
// editor: see client/src/editors/index.ts.

// A two-sided diff to show. Carries content rather than a git revision so an
// editor needs no git access of its own — whoever asks (git-scm today) has
// already resolved both sides to text.
export interface DiffRequest {
  title: string;
  original: { content: string; label: string };
  // `path` set means the modified side is a real file on disk the editor may
  // save to. When it's absent the side is read-only, and readOnlyReason (when
  // given) explains why — see git-scm's staged-diff rule.
  modified: { content: string; label: string; path?: string; readOnlyReason?: string };
}

// A conflicted working file to resolve. `path` is the real file, markers and
// all — the editor edits it in place, as VS Code does. ours/theirs/base are
// the merge stages, for a side-by-side compare action.
export interface MergeRequest {
  title: string;
  path: string;
  ours: { content: string; label: string };
  theirs: { content: string; label: string };
  base?: { content: string; label: string };
  // Called once the file has no conflict markers left and is saved — git-scm
  // passes a `git add` of this path.
  markResolved: () => Promise<void>;
}

export interface RegisteredEditor {
  // Namespaced ext.<extensionId>.<id> — what the `editor` setting stores.
  // The core nvim provider uses the bare id "nvim" and a null extensionId.
  id: string;
  extensionId: string | null;
  label: string;
  capabilities: EditorCapability[];
  openFile(path: string, line?: number): Promise<void>;
  openDiff?(req: DiffRequest): Promise<void>;
  openMerge?(req: MergeRequest): Promise<void>;
}

// A file-open interceptor gets a shot at every path that would otherwise
// fall through to nvim (after "default"-mode viewer matching, before
// openFileInSession — see useFileOpeners.openFileOrViewer). Returning true
// means "handled — open nothing else"; false/throwing falls through to the
// next interceptor and ultimately nvim. Backs file-guard's binary/large
// detection, which content-sniffs server-side and can't be expressed as an
// extension-list viewer match.
export interface RegisteredFileOpenInterceptor {
  extensionId: string;
  intercept: (path: string) => Promise<boolean>;
}

export const extensionCommands: RegisteredCommand[] = [];
export const extensionFileViewers: RegisteredFileViewer[] = [];
export const extensionFileOpenInterceptors: RegisteredFileOpenInterceptor[] = [];
export const extensionSidebarPanels: RegisteredSidebarPanel[] = [];
export const extensionWindowActions: RegisteredWindowAction[] = [];
export const extensionFileMenuItems: RegisteredFileMenuItem[] = [];
export const extensionTabGroupMenuItems: RegisteredTabGroupMenuItem[] = [];
export const extensionSidebarTabs: RegisteredSidebarTab[] = [];
export const extensionSidebarTabMenuItems: RegisteredSidebarTabMenuItem[] = [];
export const extensionFileDecorationProviders: RegisteredFileDecorationProvider[] = [];
export const extensionSessionDecorationProviders: RegisteredSessionDecorationProvider[] = [];
export const extensionTerminalEngines: RegisteredTerminalEngine[] = [];
export const extensionEditors: RegisteredEditor[] = [];
export const extensionQuickSwitcherProviders: RegisteredQuickSwitcherProvider[] = [];
export const extensionTerminalAccessories: RegisteredTerminalAccessory[] = [];
export const extensionAppOverlays: RegisteredAppOverlay[] = [];
export const extensionStatusBarItems: RegisteredStatusBarItem[] = [];
export const extensionSettingsComponents: RegisteredSettingsComponent[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();
function notify(): void {
  for (const l of listeners) l();
}

// React components subscribe here (see useExtensionRegistry) to re-render
// once extension activation populates the registries above — activation is
// async and happens after first mount.
export function subscribeExtensionRegistry(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Re-render nudge for components that query the registries imperatively per
// render (FileTree/ProjectList reading decoration providers) rather than
// consuming useExtensionRegistry's snapshot arrays — the returned tick is
// only ever used as a dependency/render trigger. Also bumped by providers'
// refresh() handles when their cached data (not the registry itself) changes.
export function useExtensionRegistryVersion(): number {
  const [tick, setTick] = ReactNS.useState(0);
  ReactNS.useEffect(() => subscribeExtensionRegistry(() => setTick((t) => t + 1)), []);
  return tick;
}

// First provider with an answer wins — decorations don't merge. With one
// bundled provider (git-scm) that's exact; if two ever collide, registration
// order (builtin-last override semantics don't apply here) decides.
export function getFileDecoration(path: string, isDir: boolean): FileDecoration | undefined {
  for (const p of extensionFileDecorationProviders) {
    const d = p.provideDecoration(path, isDir);
    if (d) return d;
  }
  return undefined;
}

export function getRootDecorations(rootPath: string): RootDecoration[] {
  const out: RootDecoration[] = [];
  for (const p of extensionFileDecorationProviders) {
    const d = p.provideRootDecoration?.(rootPath);
    if (d) out.push(d);
  }
  return out;
}

// Extension quick-switcher results for a query, in registration order — a
// provider that throws contributes nothing rather than breaking the list.
export function getQuickSwitcherResults(
  query: string,
): { provider: RegisteredQuickSwitcherProvider; item: QuickSwitcherItem }[] {
  const out: { provider: RegisteredQuickSwitcherProvider; item: QuickSwitcherItem }[] = [];
  for (const p of extensionQuickSwitcherProviders) {
    try {
      for (const item of p.provideResults(query)) out.push({ provider: p, item });
    } catch (err) {
      console.error(`quick-switcher provider ${p.id} threw:`, err);
    }
  }
  return out;
}

// All providers' badges, in registration order — a window row can carry
// several (unlike file decorations, where one row = one status).
export function getWindowDecorations(
  ctx: SessionDecorationContext,
): { provider: RegisteredSessionDecorationProvider; decoration: SessionDecoration }[] {
  const out: { provider: RegisteredSessionDecorationProvider; decoration: SessionDecoration }[] = [];
  for (const p of extensionSessionDecorationProviders) {
    const d = p.provideWindowDecoration(ctx);
    if (d) out.push({ provider: p, decoration: d });
  }
  return out;
}

// Matches by extension + mode ("default": FILES-tree click target;
// "preview": hover icon / "Preview" menu / Shift+Enter target — see
// FileViewerMode). Among ties, a non-builtin (user-installed) viewer wins
// over a bundled one, so a third-party extension can override e.g. the
// built-in CSV preview; otherwise first-registered wins.
export function resolveViewerMode(viewer: RegisteredFileViewer): FileViewerMode {
  return typeof viewer.mode === "function" ? viewer.mode() : viewer.mode;
}

export function findFileViewerFor(
  filePath: string,
  viewers: RegisteredFileViewer[],
  mode: FileViewerMode,
): RegisteredFileViewer | null {
  const ext = getFileExtension(filePath);
  if (!ext) return null;
  const matches = viewers.filter((v) => resolveViewerMode(v) === mode && v.extensions.includes(ext));
  if (matches.length <= 1) return matches[0] ?? null;
  const isBuiltin = (extensionId: string) =>
    installedExtensions.find((e) => e.id === extensionId)?.builtin ?? false;
  return matches.find((v) => !isBuiltin(v.extensionId)) ?? matches[0];
}

// A viewer that can show a preview surface for this path in *some* state:
// its resolved mode is "preview" right now, or its mode is a thunk (a thunk
// marks a click-action-configurable viewer — its preview must stay reachable
// from the "Preview" menu item / Shift+Enter even while a click opens it
// directly). Same tie-breaking as findFileViewerFor via the mode filter.
export function findPreviewCapableViewerFor(
  filePath: string,
  viewers: RegisteredFileViewer[],
): RegisteredFileViewer | null {
  return (
    findFileViewerFor(filePath, viewers, "preview") ??
    findFileViewerFor(
      filePath,
      viewers.filter((v) => typeof v.mode === "function"),
      "default",
    )
  );
}

export function useExtensionRegistry(): {
  commands: RegisteredCommand[];
  fileViewers: RegisteredFileViewer[];
  sidebarPanels: RegisteredSidebarPanel[];
  sidebarTabs: RegisteredSidebarTab[];
  sidebarTabMenuItems: RegisteredSidebarTabMenuItem[];
  // False until the first extension load has finished activating (or the
  // wait gave up) — see loadExtensions.
  extensionsSettled: boolean;
  windowActions: RegisteredWindowAction[];
  appOverlays: RegisteredAppOverlay[];
} {
  const [tick, setTick] = ReactNS.useState(0);
  ReactNS.useEffect(() => subscribeExtensionRegistry(() => setTick((t) => t + 1)), []);
  // New array references only when the registry actually changes (tick),
  // not on every unrelated App re-render — consumers (e.g. Sidebar's
  // reconcile effect) depend on these by reference, and the underlying
  // arrays are mutated in place by registerCommand/etc., so returning them
  // directly would never look "changed" to a dependency array.
  return ReactNS.useMemo(
    () => ({
      commands: [...extensionCommands],
      fileViewers: [...extensionFileViewers],
      sidebarPanels: [...extensionSidebarPanels],
      sidebarTabs: [...extensionSidebarTabs],
      sidebarTabMenuItems: [...extensionSidebarTabMenuItems],
      extensionsSettled,
      windowActions: [...extensionWindowActions],
      appOverlays: [...extensionAppOverlays],
    }),
    [tick],
  );
}

let activeContextValue: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
const contextListeners = new Set<(ctx: ActiveContext) => void>();

// Called from App.tsx whenever the derived "active real tab" context
// changes (session/window/cwd) — see the activeRealTab/filesRootDir
// derivation it already computes for the FILES panel and lazygit pill.
export function setActiveContext(ctx: ActiveContext): void {
  activeContextValue = ctx;
  for (const l of contextListeners) l(ctx);
}

let focusActiveTerminalHandler: (() => void) | null = null;

// Registered by whichever TerminalView is currently focused (cleared on
// unfocus). clear is identity-compared: React doesn't order one view's
// effect cleanup against another view's effect across components, so an
// unconditional null-out could drop the handler the newly-focused view
// just registered.
export function setFocusActiveTerminalHandler(handler: () => void): void {
  focusActiveTerminalHandler = handler;
}
export function clearFocusActiveTerminalHandler(handler: () => void): void {
  if (focusActiveTerminalHandler === handler) focusActiveTerminalHandler = null;
}

// Hands keyboard focus (back) to the focused terminal view after a tab
// activation or overlay close. TerminalView's own [focused] effect only
// fires on focused-state *transitions*, so activating the tab that is
// already active — quick-switching to the tab you're on, a new window
// folding into the live whole-session tab — is a state no-op and leaves
// DOM focus wherever the triggering UI (palette input, sidebar row) left
// it, stranded on <body> once that UI unmounts. The rAF defers past the
// triggering commit so the handler read is the post-activation view's; if
// the activated tab isn't a terminal, its view cleared the handler by then
// and this is a no-op. `onlyIfUnowned` restricts the refocus to stranded
// focus (body/null) so an overlay close never steals from a dialog the same
// action just opened — dialogs autofocus on mount, which commits before
// this rAF fires. Touch devices bail entirely: granting keyboard focus
// there pops the on-screen keyboard (same gate as the [focused] effect).
export function requestTerminalRefocus(opts?: { onlyIfUnowned?: boolean }): void {
  if (window.matchMedia("(pointer: coarse)").matches) return;
  requestAnimationFrame(() => {
    const ae = document.activeElement;
    if (opts?.onlyIfUnowned && ae !== null && ae !== document.body) return;
    focusActiveTerminalHandler?.();
  });
}

let openFileTabHandler: ((path: string, line?: number) => void) | null = null;

// Wired once from App.tsx to whatever dispatch logic decides which viewer
// (nvim, an extension viewer, a built-in preview) opens a given path.
export function setOpenFileTabHandler(handler: (path: string, line?: number) => void): void {
  openFileTabHandler = handler;
}

let openViewerTabHandler:
  | ((namespacedViewerId: string, path: string, title?: string) => void)
  | null = null;

// Wired once from App.tsx to openExtViewerTab — see ExtensionContext.app.openViewerTab.
export function setOpenViewerTabHandler(
  handler: (namespacedViewerId: string, path: string, title?: string) => void,
): void {
  openViewerTabHandler = handler;
}

let canPreviewHandler: ((path: string) => boolean) | null = null;
let openPreviewHandler: ((path: string) => void) | null = null;

// Wired once from App.tsx to useFileOpeners' isPreviewable/openPreviewViewerTab
// — see ExtensionContext.app.canPreview/openPreview.
export function setPreviewHandlers(handlers: {
  canPreview: (path: string) => boolean;
  openPreview: (path: string) => void;
}): void {
  canPreviewHandler = handlers.canPreview;
  openPreviewHandler = handlers.openPreview;
}

let openInEditorHandler: ((path: string, line?: number) => void) | null = null;
let openDiffHandler: ((req: DiffRequest) => Promise<boolean>) | null = null;
let openMergeHandler: ((req: MergeRequest) => Promise<boolean>) | null = null;

// Wired once from App.tsx to useFileOpeners' editor-dispatch functions — see
// ExtensionContext.app.openInEditor/openDiff/openMerge.
export function setEditorHandlers(handlers: {
  openInEditor: (path: string, line?: number) => void;
  openDiff: (req: DiffRequest) => Promise<boolean>;
  openMerge: (req: MergeRequest) => Promise<boolean>;
}): void {
  openInEditorHandler = handlers.openInEditor;
  openDiffHandler = handlers.openDiff;
  openMergeHandler = handlers.openMerge;
}

let refreshFilesHandler: (() => void) | null = null;

// Wired once from App.tsx to bump filesRefreshKey — see ExtensionContext.app.refreshFiles.
export function setRefreshFilesHandler(handler: () => void): void {
  refreshFilesHandler = handler;
}

let closeViewerTabHandler: ((namespacedViewerId: string, path: string) => void) | null = null;

// Wired once from App.tsx to closeExtViewerTab — see ExtensionContext.app.closeViewerTab.
export function setCloseViewerTabHandler(handler: (namespacedViewerId: string, path: string) => void): void {
  closeViewerTabHandler = handler;
}

let openSessionWindowHandler:
  | ((sessionName: string, createCwd?: string) => void)
  | null = null;

// Wired once from App.tsx to the same create-then-open-a-window-tab path the
// sidebar's pinned-session restore uses — see
// ExtensionContext.app.openSessionWindow.
export function setOpenSessionWindowHandler(
  handler: (sessionName: string, createCwd?: string) => void,
): void {
  openSessionWindowHandler = handler;
}

let killSessionHandler: ((sessionName: string) => void) | null = null;

interface DialogHandlers {
  confirm(message: string, confirmLabel?: string): Promise<boolean>;
  prompt(message: string, defaultValue?: string): Promise<string | null>;
  pick(opts: { title: string; items: PickItem[]; current?: string; placeholder?: string }): Promise<string | null>;
}
let dialogHandlers: DialogHandlers | null = null;

// Wired from App.tsx to useDialogs — backs ExtensionContext.app's
// confirmDialog/promptDialog/pickItem/pickIcon. Nulled on unmount.
export function setDialogHandlers(handlers: DialogHandlers | null): void {
  dialogHandlers = handlers;
}

// Wired once from App.tsx to useSessionActions' killSessionNow — the
// *unconfirmed* kill, since the extension caller owns the prompt (see
// ExtensionContext.app.killSession).
export function setKillSessionHandler(handler: (sessionName: string) => void): void {
  killSessionHandler = handler;
}

// Wired from App.tsx to the same globalHandlers + extension-command map the
// keyboard dispatcher (useGlobalKeybindings) runs — backs
// ExtensionContext.app.executeCommand/getCommands. Nulled on unmount.
let executeCommandHandler: ((commandId: string) => void) | null = null;
let getCommandsHandler: (() => { id: string; label: string }[]) | null = null;

export function setExecuteCommandHandler(handler: ((commandId: string) => void) | null): void {
  executeCommandHandler = handler;
}

export function setGetCommandsHandler(handler: (() => { id: string; label: string }[]) | null): void {
  getCommandsHandler = handler;
}

// One bridge for BOTH sidebars, registered by useSidebarLayout. Every
// question is asked by id and answered against the live layout, so a
// "reveal Source Control" call keeps working after the user drags that tab
// to the other side or drops its panel into Explorer.
interface SidebarLayoutBridge {
  sideOfTab(tabId: string): SidebarSide | null;
  // The tab a panel currently calls home (its own id for an untouched
  // "tab" panel), or null if no such panel is registered.
  tabOfPanel(panelId: string): string | null;
  isTabVisible(tabId: string): boolean;
  getActive(side: SidebarSide): string | null;
  selectTab(tabId: string): void;
  isVisible(side: SidebarSide): boolean;
  setVisible(side: SidebarSide, visible: boolean): void;
  // Deletes a tab from the layout and sends its panes to their default homes.
  removeTab(tabId: string): void;
}

let sidebarLayoutBridge: SidebarLayoutBridge | null = null;
// Buffers a tab id requested before the bridge exists (the app's very first
// render, or a reveal queued while React hasn't re-rendered yet).
let pendingTabId: string | null = null;

export function setSidebarLayoutBridge(bridge: SidebarLayoutBridge | null): void {
  sidebarLayoutBridge = bridge;
  if (bridge && pendingTabId !== null) {
    const id = pendingTabId;
    pendingTabId = null;
    bridge.selectTab(id);
  }
}

// Reveals whichever side holds `tabId` (if it's hidden) and selects it.
function revealTab(tabId: string): SidebarSide | null {
  const bridge = sidebarLayoutBridge;
  if (!bridge) {
    pendingTabId = tabId;
    return null;
  }
  const side = bridge.sideOfTab(tabId);
  if (!side) return null;
  if (!bridge.isVisible(side)) bridge.setVisible(side, true);
  bridge.selectTab(tabId);
  return side;
}

// Container tabs asked to reveal before the layout had placed them — see
// SidebarTabHandle.reveal. Flushed by useSidebarLayout after placement.
const pendingTabReveals = new Set<string>();

export function flushPendingTabReveals(): void {
  for (const id of [...pendingTabReveals]) {
    if (!extensionSidebarTabs.some((t) => t.id === id)) {
      pendingTabReveals.delete(id);
    } else if (revealTab(id)) {
      pendingTabReveals.delete(id);
    }
  }
}

export function selectSidebarTab(id: string): void {
  if (sidebarLayoutBridge) revealTab(id);
  else pendingTabId = id;
}

// Drives every "Sidebar: Focus <tab>" command: hidden → reveal and switch
// to it; visible on a different tab → switch; visible and already active →
// hide that side (VS Code's toggle). The side is resolved per call, so the
// same command follows a tab dragged to the right sidebar.
export function focusSidebarTab(id: string): void {
  const bridge = sidebarLayoutBridge;
  if (!bridge) return;
  const side = bridge.sideOfTab(id);
  if (!side) return;
  if (bridge.isVisible(side) && bridge.getActive(side) === id) {
    bridge.setVisible(side, false);
    return;
  }
  revealTab(id);
}

interface ProjectsFocusBridge {
  // Expands the PROJECTS accordion panel if collapsed, then moves keyboard
  // focus to its focused-or-first row.
  focus(): void;
}

// Keyed by side: each mounted Sidebar registers its own, and a focus call
// is routed to whichever side currently shows the panel.
const projectsFocusBridges: Partial<Record<SidebarSide, ProjectsFocusBridge | null>> = {};

export function setProjectsFocusBridge(side: SidebarSide, bridge: ProjectsFocusBridge | null): void {
  projectsFocusBridges[side] = bridge;
}

interface WorktreeBridge {
  // Opens the PROJECTS tree's inline create-worktree form on the active
  // project (or the first repository project), optionally preselecting one
  // of the configured run commands by index.
  open(runCommandIndex?: number): void;
  // Starts Clean Up Worktrees on the active repository project (or the first
  // one with linked worktrees).
  cleanUp(): void;
}

const worktreeBridges: Partial<Record<SidebarSide, WorktreeBridge | null>> = {};

export function setWorktreeBridge(side: SidebarSide, bridge: WorktreeBridge | null): void {
  worktreeBridges[side] = bridge;
}

// Reveals the PROJECTS panel and returns the tree's worktree bridge on
// whichever side is showing it. Worktrees used to be an extension's own
// panel; this is what its commands drive now that the tree owns them. See
// plans/worktrees-into-projects.md.
function revealWorktreeBridge(): WorktreeBridge | null {
  const bridge = sidebarLayoutBridge;
  if (!bridge) return null;
  const tabId = bridge.tabOfPanel("projects");
  if (!tabId) return null;
  const side = revealTab(tabId);
  if (!side) return null;
  projectsFocusBridges[side]?.focus();
  return worktreeBridges[side] ?? null;
}

// Backs ExtensionContext.app.newWorktree.
export function openNewWorktreeForm(runCommandIndex?: number): void {
  revealWorktreeBridge()?.open(runCommandIndex);
}

// Backs ExtensionContext.app.cleanUpWorktrees.
export function startWorktreeCleanup(): void {
  revealWorktreeBridge()?.cleanUp();
}

interface ExplorerPanelFocusBridge {
  // Expands the given accordion section if collapsed, then moves keyboard
  // focus into its content — the generic counterpart of the PROJECTS bridge
  // above. One per mounted sidebar; panel ids are unique across both.
  focus(panelId: string): void;
}

const explorerPanelFocusBridges: Partial<Record<SidebarSide, ExplorerPanelFocusBridge | null>> = {};

export function setExplorerPanelFocusBridge(
  side: SidebarSide,
  bridge: ExplorerPanelFocusBridge | null,
): void {
  explorerPanelFocusBridges[side] = bridge;
}

// Drives an accordion-located panel's "Sidebar: Focus <title>" command and
// ctx.app.revealSidebarPanel: reveal the side holding the panel's tab,
// switch to that tab, then hand off to the section itself. Never toggles
// anything shut — a reveal always means "show it".
export function focusAccordionPanel(panelId: string): void {
  const bridge = sidebarLayoutBridge;
  if (!bridge) return;
  const tabId = bridge.tabOfPanel(panelId);
  if (!tabId) return;
  const side = revealTab(tabId);
  if (!side) return;
  if (panelId === "projects") projectsFocusBridges[side]?.focus();
  else explorerPanelFocusBridges[side]?.focus(panelId);
}

export function focusProjectsPanel(): void {
  focusAccordionPanel("projects");
}

// Backs ExtensionContext.app.revealSidebarPanel. A panel that IS its own
// tab (an untouched "tab" panel) reveals that tab; one living inside an
// accordion reveals the tab and focuses the section.
export function revealSidebarPanelById(panelId: string): void {
  const bridge = sidebarLayoutBridge;
  if (!bridge) return;
  const tabId = bridge.tabOfPanel(panelId);
  if (!tabId) return;
  if (tabId === panelId) revealTab(tabId);
  else focusAccordionPanel(panelId);
}

// "Find in Folder…" (FILES-tree folder context menu, useFileActions.ts) —
// switches to the bundled search extension's tab and hands it a glob scope.
// Hardcodes the search extension's namespaced panel id rather than adding a
// generic extension-contribution API, since this wires one specific
// built-in menu item to one specific built-in extension (same category of
// coupling as core already knowing about git-scm's diff viewer). The
// extension id itself is `${publisher}.${name}` from its manifest (see
// server/src/extensions.ts's resolveId), not just the bare folder name —
// extensions/search/package.json is publisher "perch", name "search".
const SEARCH_PANEL_ID = "ext.perch.search.search";

// The search panel isn't mounted yet at the moment this fires (activating
// its tab and mounting SearchPanel both happen on the next render) — the
// pending glob is consumed once by the panel's own mount/session-load
// effect rather than pushed through a live-subscriber callback.
let pendingFindInFolderGlob: string | null = null;

export function requestFindInFolder(glob: string): void {
  if (extensionSidebarPanels.some((p) => p.id === SEARCH_PANEL_ID)) {
    pendingFindInFolderGlob = glob;
    selectSidebarTab(SEARCH_PANEL_ID);
  }
}

// Reads without immediately clearing: React's development-mode double-
// invoke runs the search panel's mount effect twice, synchronously, for
// the same logical mount — the second pass's own "restore last session's
// cached state" step would otherwise run with nothing left to override it
// with, since an eager clear on the first read already nulled it out,
// stomping the correctly-applied result with stale cached values. The
// setTimeout defers the actual clear past both synchronous passes (which
// always complete within the same tick) while still clearing it before any
// later, unrelated mount (which requires an intervening user action, so it
// always takes far longer than one tick).
export function consumePendingFindInFolderGlob(): string | null {
  const glob = pendingFindInFolderGlob;
  if (glob !== null) {
    setTimeout(() => {
      pendingFindInFolderGlob = null;
    }, 0);
  }
  return glob;
}

let installedExtensions: ExtensionInfo[] = [];

export function getInstalledExtensions(): ExtensionInfo[] {
  return installedExtensions;
}

// Sparse overrides as last pushed from App.tsx (see setExtensionSettingsOverrides),
// and the resolved (override ?? manifest default) values per extension id —
// recomputed on every push so ctx.settings.get() is a plain lookup. Kept as
// a NEW object per extension on every push (never mutated in place) so the
// shallow-equal comparison below can actually detect "nothing changed".
let extensionSettingsOverrides: ExtensionSettingsValues = {};
let resolvedExtensionSettings: Record<string, Record<string, unknown>> = {};
const extensionSettingsListeners = new Map<string, Set<() => void>>();

function resolveExtensionSettings(ext: ExtensionInfo, overrides: ExtensionSettingsValues): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const section of ext.configuration) {
    for (const prop of section.properties) values[prop.key] = prop.default;
  }
  Object.assign(values, overrides[ext.id]);
  return values;
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

// Called from App.tsx whenever extension settings change (initial load,
// server doc arriving, or a user edit in Settings) — recomputes every
// installed extension's resolved values and notifies only the extensions
// whose resolved values actually changed.
export function setExtensionSettingsOverrides(
  overrides: ExtensionSettingsValues,
  extensions: ExtensionInfo[],
): void {
  extensionSettingsOverrides = overrides;
  const prev = resolvedExtensionSettings;
  const next: Record<string, Record<string, unknown>> = {};
  for (const ext of extensions) next[ext.id] = resolveExtensionSettings(ext, overrides);
  resolvedExtensionSettings = next;
  for (const [id, values] of Object.entries(next)) {
    if (prev[id] && shallowEqual(prev[id], values)) continue;
    const listeners = extensionSettingsListeners.get(id);
    if (listeners) for (const l of listeners) l();
  }
}

// Wired once from App.tsx to the server-synced extension-settings store's
// updater — backs ctx.settings.set.
let extensionSettingUpdater: ((extId: string, key: string, value: unknown) => void) | null = null;

export function setExtensionSettingUpdater(
  handler: ((extId: string, key: string, value: unknown) => void) | null,
): void {
  extensionSettingUpdater = handler;
}

function makeContext(ext: ExtensionInfo, runtime: ExtensionRuntime): ExtensionContext {
  return {
    React: ReactNS,
    registerCommand(cmd) {
      extensionCommands.push({ ...cmd, id: `ext.${ext.id}.${cmd.id}` });
      notify();
    },
    registerFileViewer(viewer) {
      extensionFileViewers.push({
        id: `ext.${ext.id}.${viewer.id}`,
        extensionId: ext.id,
        extensions: viewer.extensions.map((e) => e.toLowerCase()),
        mode: viewer.mode ?? "default",
        editorFallback: viewer.editorFallback ?? true,
        component: viewer.component,
      });
      notify();
    },
    registerFileOpenInterceptor(intercept) {
      extensionFileOpenInterceptors.push({ extensionId: ext.id, intercept });
      notify();
    },
    registerSidebarPanel(panel) {
      const namespacedId = `ext.${ext.id}.${panel.id}`;
      const location = panel.location ?? "tab";
      // Namespaced the same way the target's own registration was, so an
      // extension names its sibling by the plain id it registered it under.
      const defaultTab =
        location === "tab" && panel.defaultTab ? `ext.${ext.id}.${panel.defaultTab}` : undefined;
      extensionSidebarPanels.push({
        id: namespacedId,
        title: panel.title,
        icon: panel.icon,
        location,
        defaultTab,
        defaultCollapsed: panel.defaultCollapsed,
        order: panel.order,
        component: panel.component,
      });
      // Tab panels: opt-in only — most don't warrant a dedicated shortcut
      // cluttering the palette/keybinding list. Accordion sections: always
      // registered (unbound when no focusBinding), matching the built-in
      // SESSIONS/FILES sections' always-present focus commands. A defaultTab
      // panel renders as a section like those, so it's treated like one.
      if (panel.focusBinding || location !== "tab" || defaultTab) {
        extensionCommands.push({
          id: `${namespacedId}.focus`,
          label: `Sidebar: Focus ${panel.title}`,
          defaultBinding: panel.focusBinding,
          // Where the panel lives is resolved when the command RUNS, not
          // where it was registered: the user may have moved it into an
          // accordion (or moved an accordion section out into its own tab),
          // and the shortcut has to follow it.
          run: () => {
            if (sidebarLayoutBridge?.tabOfPanel(namespacedId) === namespacedId) {
              focusSidebarTab(namespacedId);
            } else {
              focusAccordionPanel(namespacedId);
            }
          },
        });
      }
      notify();
    },
    registerWindowAction(action) {
      extensionWindowActions.push({
        id: `ext.${ext.id}.${action.id}`,
        extensionId: ext.id,
        icon: action.icon,
        title: action.title,
        isVisible: action.isVisible,
        onClick: action.onClick,
        showInTabBar: action.showInTabBar ?? false,
      });
      notify();
    },
    registerFileMenuItem(item) {
      extensionFileMenuItems.push({
        id: `ext.${ext.id}.${item.id}`,
        extensionId: ext.id,
        label: item.label,
        icon: item.icon,
        order: item.order,
        isVisible: item.isVisible,
        onClick: item.onClick,
      });
      notify();
    },
    registerSidebarTab(tab) {
      const id = `ext.${ext.id}.${tab.id}`;
      const existing = extensionSidebarTabs.find((t) => t.id === id);
      if (existing) {
        existing.title = tab.title;
        existing.icon = tab.icon;
      } else {
        extensionSidebarTabs.push({
          id,
          extensionId: ext.id,
          title: tab.title,
          icon: tab.icon,
          side: tab.side === "right" ? "right" : "left",
        });
      }
      notify();
      return {
        id,
        update(patch) {
          const entry = extensionSidebarTabs.find((t) => t.id === id);
          if (!entry) return;
          if (patch.title !== undefined) entry.title = patch.title;
          if (patch.icon !== undefined) entry.icon = patch.icon;
          notify();
        },
        reveal() {
          // A tab registered moments ago isn't placed in the layout until
          // React re-renders; hold the reveal until it is.
          if (sidebarLayoutBridge && !revealTab(id)) pendingTabReveals.add(id);
        },
        remove() {
          const at = extensionSidebarTabs.findIndex((t) => t.id === id);
          if (at !== -1) extensionSidebarTabs.splice(at, 1);
          sidebarLayoutBridge?.removeTab(id);
          notify();
        },
      };
    },
    registerSidebarTabMenuItem(item) {
      extensionSidebarTabMenuItems.push({
        id: `ext.${ext.id}.${item.id}`,
        extensionId: ext.id,
        label: item.label,
        order: item.order,
        isVisible: item.isVisible,
        onClick: item.onClick,
      });
      notify();
    },
    registerTabGroupMenuItem(item) {
      extensionTabGroupMenuItems.push({
        id: `ext.${ext.id}.${item.id}`,
        extensionId: ext.id,
        label: item.label,
        icon: item.icon,
        order: item.order,
        isVisible: item.isVisible,
        onClick: item.onClick,
      });
      notify();
    },
    registerFileDecorationProvider(provider) {
      extensionFileDecorationProviders.push({
        id: `ext.${ext.id}.${provider.id}`,
        extensionId: ext.id,
        provideDecoration: provider.provideDecoration,
        provideRootDecoration: provider.provideRootDecoration,
      });
      notify();
      // refresh() is the provider's "my cached answers changed" nudge —
      // same notify the registries use, so every subscribed consumer
      // re-queries. Cheap enough at this scale to not need per-provider
      // listener granularity.
      return { refresh: notify };
    },
    registerSessionDecorationProvider(provider) {
      extensionSessionDecorationProviders.push({
        id: `ext.${ext.id}.${provider.id}`,
        extensionId: ext.id,
        provideWindowDecoration: provider.provideWindowDecoration,
        onClick: provider.onClick,
      });
      notify();
      return { refresh: notify };
    },
    registerTerminalEngine(engine) {
      extensionTerminalEngines.push({
        id: `ext.${ext.id}.${engine.id}`,
        extensionId: ext.id,
        label: engine.label,
        create: engine.create,
      });
      notify();
    },
    registerEditor(editor) {
      extensionEditors.push({
        id: `ext.${ext.id}.${editor.id}`,
        extensionId: ext.id,
        label: editor.label,
        capabilities: editor.capabilities,
        openFile: editor.openFile,
        openDiff: editor.openDiff,
        openMerge: editor.openMerge,
      });
      notify();
    },
    registerQuickSwitcherProvider(provider) {
      extensionQuickSwitcherProviders.push({
        id: `ext.${ext.id}.${provider.id}`,
        extensionId: ext.id,
        provideResults: provider.provideResults,
      });
      notify();
      return { refresh: notify };
    },
    registerTerminalAccessory(accessory) {
      extensionTerminalAccessories.push({
        id: `ext.${ext.id}.${accessory.id}`,
        extensionId: ext.id,
        placement: accessory.placement,
        component: accessory.component,
      });
      notify();
    },
    registerAppOverlay(overlay) {
      extensionAppOverlays.push({
        id: `ext.${ext.id}.${overlay.id}`,
        extensionId: ext.id,
        component: overlay.component,
      });
      notify();
    },
    registerStatusBarItem(item) {
      extensionStatusBarItems.push({
        id: `ext.${ext.id}.${item.id}`,
        extensionId: ext.id,
        title: item.title,
        visibilitySetting: item.visibilitySetting,
        placement: item.placement ?? "right",
        order: item.order ?? 0,
        component: item.component,
      });
      notify();
    },
    registerSettingsComponent(component) {
      extensionSettingsComponents.push({
        id: `ext.${ext.id}.${component.id}`,
        extensionId: ext.id,
        component: component.component,
      });
      notify();
    },
    app: {
      getActiveContext: () => activeContextValue,
      onDidChangeContext(cb) {
        contextListeners.add(cb);
        // Tracked per-extension (not just the shared Set above) so
        // deactivateClientExtension can unsubscribe exactly this extension's
        // callbacks without touching any other extension's.
        runtime.contextListeners.add(cb);
        return () => {
          contextListeners.delete(cb);
          runtime.contextListeners.delete(cb);
        };
      },
      openFileTab(path, line) {
        openFileTabHandler?.(path, line);
      },
      openViewerTab(viewerId, path, opts) {
        openViewerTabHandler?.(`ext.${ext.id}.${viewerId}`, path, opts?.title);
      },
      closeViewerTab(viewerId, path) {
        closeViewerTabHandler?.(`ext.${ext.id}.${viewerId}`, path);
      },
      refreshFiles() {
        refreshFilesHandler?.();
      },
      openInEditor(path, line) {
        openInEditorHandler?.(path, line);
      },
      canPreview(path) {
        return canPreviewHandler?.(path) ?? false;
      },
      openPreview(path) {
        openPreviewHandler?.(path);
      },
      // Defaults to false (not handled) when App hasn't wired the handler
      // yet, so a caller racing startup falls back to its own view rather
      // than silently opening nothing.
      openDiff(req) {
        return openDiffHandler?.(req) ?? Promise.resolve(false);
      },
      openMerge(req) {
        return openMergeHandler?.(req) ?? Promise.resolve(false);
      },
      setSidebarBadge(panelId, badge) {
        const namespaced = `ext.${ext.id}.${panelId}`;
        const panel = extensionSidebarPanels.find((p) => p.id === namespaced);
        if (!panel) return;
        panel.badge = badge;
        notify();
      },
      setSidebarPanelVisible(panelId, visible) {
        const namespaced = `ext.${ext.id}.${panelId}`;
        const panel = extensionSidebarPanels.find((p) => p.id === namespaced);
        if (!panel) return;
        panel.hidden = !visible;
        notify();
      },
      newWorktree(opts) {
        openNewWorktreeForm(opts?.runCommandIndex);
      },
      cleanUpWorktrees() {
        startWorktreeCleanup();
      },
      revealSidebarPanel(panelId) {
        const namespaced = `ext.${ext.id}.${panelId}`;
        if (!extensionSidebarPanels.some((p) => p.id === namespaced)) return;
        revealSidebarPanelById(namespaced);
      },
      openSessionWindow(sessionName, opts) {
        openSessionWindowHandler?.(sessionName, opts?.createCwd);
      },
      killSession(sessionName) {
        killSessionHandler?.(sessionName);
      },
      confirmDialog: (message, confirmLabel) =>
        dialogHandlers ? dialogHandlers.confirm(message, confirmLabel) : Promise.resolve(false),
      promptDialog: (message, defaultValue) =>
        dialogHandlers ? dialogHandlers.prompt(message, defaultValue) : Promise.resolve(null),
      pickItem: (opts) => (dialogHandlers ? dialogHandlers.pick(opts) : Promise.resolve(null)),
      async pickIcon(opts) {
        if (!dialogHandlers) return null;
        const items = await loadCodiconItems();
        return dialogHandlers.pick({
          title: opts?.title ?? "Choose an icon",
          items,
          current: opts?.current,
          placeholder: "Search icons by name or tag",
        });
      },
      consumeFindInFolderGlob: () => consumePendingFindInFolderGlob(),
      async agentForWindow(session, windowIndex) {
        try {
          const { windows } = await fetchAgentWindows(session, windowIndex);
          return windows[0] ?? null;
        } catch {
          return null;
        }
      },
      async agentForSession(session) {
        try {
          return (await fetchAgentWindows(session)).windows;
        } catch {
          return [];
        }
      },
      getFileIcon: (fileName) => getFileIconResult(fileName),
      getFolderIcon: (folderName, expanded) => getFolderIconResult(folderName, expanded),
      onDidChangeIconTheme(cb) {
        // subscribeIconTheme's own listeners Set is private to iconThemes.ts
        // (unlike contextListeners below, which this module owns directly),
        // so runtime tracks the *unsubscribe* closure it returns rather than
        // the raw callback — that's the only handle deactivate has to stop
        // it from firing into a torn-down extension.
        const unsubscribe = subscribeIconTheme(cb);
        runtime.iconThemeListeners.add(unsubscribe);
        return () => {
          runtime.iconThemeListeners.delete(unsubscribe);
          unsubscribe();
        };
      },
      getThemeColors: () => getActiveThemeColors(),
      getTokenColors: () => getActiveTokenColors(),
      onDidChangeColorTheme(cb) {
        const unsubscribe = subscribeColorTheme(cb);
        runtime.colorThemeListeners.add(unsubscribe);
        return () => {
          runtime.colorThemeListeners.delete(unsubscribe);
          unsubscribe();
        };
      },
      executeCommand: (commandId) => executeCommandHandler?.(commandId),
      getCommands: () => getCommandsHandler?.() ?? [],
      focusActiveTerminal: () => focusActiveTerminalHandler?.(),
    },
    serverFetch(path, init) {
      return fetch(`${extensionApiBase(ext.id)}${path}`, init);
    },
    settings: {
      get(key) {
        return resolvedExtensionSettings[ext.id]?.[key];
      },
      set(key, value) {
        extensionSettingUpdater?.(ext.id, key, value);
      },
      onDidChange(cb) {
        let listeners = extensionSettingsListeners.get(ext.id);
        if (!listeners) {
          listeners = new Set();
          extensionSettingsListeners.set(ext.id, listeners);
        }
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    assetUrl(relPath) {
      return extensionFileUrl(ext.id, relPath);
    },
  };
}

interface ExtensionRuntime {
  // The dynamically-imported client-entry module, so deactivate (below) can
  // call its optional `deactivate` export.
  module: unknown;
  // This extension's own onDidChangeContext callbacks — a subset of the
  // shared contextListeners Set, tracked separately so deactivation can
  // remove exactly these without touching other extensions' callbacks.
  contextListeners: Set<(ctx: ActiveContext) => void>;
  // Unsubscribe closures returned by subscribeIconTheme for this extension's
  // onDidChangeIconTheme callbacks — see makeContext's app.onDidChangeIconTheme.
  iconThemeListeners: Set<() => void>;
  // Same as iconThemeListeners, for subscribeColorTheme — see makeContext's
  // app.onDidChangeColorTheme.
  colorThemeListeners: Set<() => void>;
}

const activatedIds = new Set<string>();
const extensionRuntimes = new Map<string, ExtensionRuntime>();
// One shared promise per in-flight activation, so concurrent callers (every
// TerminalView mounting in the same tick calls loadEngine → here) all await
// the same import instead of the late ones returning before the engine has
// registered — which used to leave loadEngine's registry lookup empty and
// surface as "Terminal engine unavailable" on first load.
const pendingActivations = new Map<string, Promise<void>>();

async function activateClientExtension(ext: ExtensionInfo): Promise<void> {
  if (activatedIds.has(ext.id) || !ext.clientEntry) return;
  const inFlight = pendingActivations.get(ext.id);
  if (inFlight) return inFlight;
  const url = extensionFileUrl(ext.id, ext.clientEntry);
  const promise = (async () => {
    let mod: unknown;
    try {
      // Vite must not try to statically analyze/pre-bundle this — the path is
      // only known at runtime, from the server's extension list.
      mod = await import(/* @vite-ignore */ url);
    } catch (err) {
      // Deliberately NOT latched into activatedIds: an import failure here is
      // typically transient (server restarting mid-request, network hiccup),
      // and latching it used to disable the extension — including the
      // required xterm engine — for the whole page session. Leaving it
      // unlatched lets the next activateExtensionById retry the import.
      console.error(`extension ${ext.id}: failed to load client entry:`, err);
      return;
    }
    // Latched only once the module is actually in hand — from here on,
    // failures are deterministic (bad export, activate() bug), so a retry
    // could only duplicate registrations.
    activatedIds.add(ext.id);
    const runtime: ExtensionRuntime = {
      module: mod,
      contextListeners: new Set(),
      iconThemeListeners: new Set(),
      colorThemeListeners: new Set(),
    };
    extensionRuntimes.set(ext.id, runtime);
    const activate = (mod as { activate?: unknown }).activate;
    if (typeof activate !== "function") {
      console.error(`extension ${ext.id}: client entry has no activate() export`);
      return;
    }
    try {
      (activate as (ctx: ExtensionContext) => void)(makeContext(ext, runtime));
    } catch (err) {
      console.error(`extension ${ext.id}: activate() threw:`, err);
    }
  })().finally(() => pendingActivations.delete(ext.id));
  pendingActivations.set(ext.id, promise);
  return promise;
}

// Reverses activateClientExtension: calls the module's optional deactivate()
// export (e.g. to remove an injected stylesheet), removes this extension's
// entries from the command/file-viewer/sidebar-panel registries, unsubscribes
// its onDidChangeContext, onDidChangeIconTheme, and settings.onDidChange
// callbacks, and clears activatedIds so a later re-enable calls activate()
// again instead of silently no-oping against the stale guard.
function deactivateClientExtension(extId: string): void {
  if (!activatedIds.has(extId)) return;
  const runtime = extensionRuntimes.get(extId);
  const deactivate = (runtime?.module as { deactivate?: unknown } | null)?.deactivate;
  if (typeof deactivate === "function") {
    try {
      (deactivate as () => void)();
    } catch (err) {
      console.error(`extension ${extId}: deactivate() threw:`, err);
    }
  }
  const prefix = `ext.${extId}.`;
  for (let i = extensionCommands.length - 1; i >= 0; i--) {
    if (extensionCommands[i].id.startsWith(prefix)) extensionCommands.splice(i, 1);
  }
  for (let i = extensionFileViewers.length - 1; i >= 0; i--) {
    if (extensionFileViewers[i].extensionId === extId) extensionFileViewers.splice(i, 1);
  }
  for (let i = extensionFileOpenInterceptors.length - 1; i >= 0; i--) {
    if (extensionFileOpenInterceptors[i].extensionId === extId) extensionFileOpenInterceptors.splice(i, 1);
  }
  for (let i = extensionSidebarPanels.length - 1; i >= 0; i--) {
    if (extensionSidebarPanels[i].id.startsWith(prefix)) extensionSidebarPanels.splice(i, 1);
  }
  for (let i = extensionWindowActions.length - 1; i >= 0; i--) {
    if (extensionWindowActions[i].extensionId === extId) extensionWindowActions.splice(i, 1);
  }
  for (let i = extensionFileMenuItems.length - 1; i >= 0; i--) {
    if (extensionFileMenuItems[i].extensionId === extId) extensionFileMenuItems.splice(i, 1);
  }
  for (let i = extensionTabGroupMenuItems.length - 1; i >= 0; i--) {
    if (extensionTabGroupMenuItems[i].extensionId === extId) extensionTabGroupMenuItems.splice(i, 1);
  }
  // Unregistered only: the layout keeps these tabs' ids and the panes homed
  // in them, so re-enabling the extension brings both back.
  for (let i = extensionSidebarTabs.length - 1; i >= 0; i--) {
    if (extensionSidebarTabs[i].extensionId === extId) extensionSidebarTabs.splice(i, 1);
  }
  for (let i = extensionSidebarTabMenuItems.length - 1; i >= 0; i--) {
    if (extensionSidebarTabMenuItems[i].extensionId === extId) extensionSidebarTabMenuItems.splice(i, 1);
  }
  for (let i = extensionFileDecorationProviders.length - 1; i >= 0; i--) {
    if (extensionFileDecorationProviders[i].extensionId === extId) extensionFileDecorationProviders.splice(i, 1);
  }
  for (let i = extensionSessionDecorationProviders.length - 1; i >= 0; i--) {
    if (extensionSessionDecorationProviders[i].extensionId === extId) extensionSessionDecorationProviders.splice(i, 1);
  }
  for (let i = extensionTerminalEngines.length - 1; i >= 0; i--) {
    if (extensionTerminalEngines[i].extensionId === extId) extensionTerminalEngines.splice(i, 1);
  }
  for (let i = extensionEditors.length - 1; i >= 0; i--) {
    if (extensionEditors[i].extensionId === extId) extensionEditors.splice(i, 1);
  }
  for (let i = extensionQuickSwitcherProviders.length - 1; i >= 0; i--) {
    if (extensionQuickSwitcherProviders[i].extensionId === extId) extensionQuickSwitcherProviders.splice(i, 1);
  }
  for (let i = extensionTerminalAccessories.length - 1; i >= 0; i--) {
    if (extensionTerminalAccessories[i].extensionId === extId) extensionTerminalAccessories.splice(i, 1);
  }
  for (let i = extensionAppOverlays.length - 1; i >= 0; i--) {
    if (extensionAppOverlays[i].extensionId === extId) extensionAppOverlays.splice(i, 1);
  }
  for (let i = extensionStatusBarItems.length - 1; i >= 0; i--) {
    if (extensionStatusBarItems[i].extensionId === extId) extensionStatusBarItems.splice(i, 1);
  }
  for (let i = extensionSettingsComponents.length - 1; i >= 0; i--) {
    if (extensionSettingsComponents[i].extensionId === extId) extensionSettingsComponents.splice(i, 1);
  }
  if (runtime) for (const cb of runtime.contextListeners) contextListeners.delete(cb);
  if (runtime) for (const unsubscribe of runtime.iconThemeListeners) unsubscribe();
  if (runtime) for (const unsubscribe of runtime.colorThemeListeners) unsubscribe();
  extensionSettingsListeners.delete(extId);
  extensionRuntimes.delete(extId);
  activatedIds.delete(extId);
  notify();
}

// Fetches the list once and activates every enabled extension's client
// entry EXCEPT terminal engines (filtered out below) — a terminal engine's
// code is only ever activated on demand, by engines/index.ts's loadEngine(),
// for whichever ONE engine a session actually resolves to. Eagerly
// activating every bundled engine here regardless of selection used to mean
// every boot downloaded and ran all of them, and terminal rendering waited
// on this entire Promise.all (every other extension too, not just its own
// engine) rather than just its own engine's fetch. Themes/icon themes need
// no activation step at all — see the module comment — so this only
// concerns commands/viewers/panels/engines. onListLoaded, if given, fires
// right after the list is known but before any client entry activates —
// App.tsx uses this to push extension-settings overrides into this module's
// store first, so ctx.settings.get() already resolves correctly the very
// first time an activating extension reads it.
export async function loadExtensions(onListLoaded?: (list: ExtensionInfo[]) => void): Promise<ExtensionInfo[]> {
  const list = await fetchExtensions();
  const enabledIds = new Set(list.filter((ext) => ext.enabled).map((ext) => ext.id));
  // Disabled or uninstalled since the last load: tear this extension down
  // before installedExtensions/notify reflect the new list, so nothing
  // observes a moment where a now-gone extension's panel/viewer is still
  // registered but its backing extension info has already disappeared.
  for (const id of [...activatedIds]) {
    if (!enabledIds.has(id)) deactivateClientExtension(id);
  }
  installedExtensions = list;
  notify();
  settleExtensionsListed();
  onListLoaded?.(list);
  const activations = Promise.all(
    list
      .filter((ext) => ext.enabled && ext.hasClient && ext.terminalEngines.length === 0)
      .map((ext) => activateClientExtension(ext)),
  );
  if (!extensionsSettled) {
    // Settled when every activation has finished, or after the cap: one
    // extension that never finishes loading mustn't keep panes whose tab
    // it owned out of sight for good.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_CAP_MS);
    });
    void Promise.race([activations.then(() => undefined, () => undefined), cap]).then(() => {
      clearTimeout(timer);
      if (extensionsSettled) return;
      extensionsSettled = true;
      notify();
    });
  }
  await activations;
  return list;
}

// Activates exactly one extension's client entry on demand — used by
// engines/index.ts's loadEngine() to fetch/run only the terminal engine a
// session actually needs, instead of loadExtensions()'s blanket sweep above
// (which now deliberately skips every terminal-engine extension). A no-op
// for an id that isn't installed, already active, or has no client — same
// guards activateClientExtension already applies internally.
export async function activateExtensionById(id: string): Promise<void> {
  const ext = installedExtensions.find((e) => e.id === id);
  if (ext) await activateClientExtension(ext);
}

// Whether the first extension load has settled (see loadExtensions). A pane
// homed in a tab nobody has registered is kept out of sight until then,
// because that tab's extension may simply not have activated yet.
let extensionsSettled = false;
const SETTLE_CAP_MS = 5000;

// Resolved as soon as the extension LIST is known (before any activation) —
// engines/index.ts's loadEngine() waits on this alone, so opening a terminal
// never blocks on unrelated extensions (previews, git-scm, search, …)
// finishing activation.
let settleExtensionsListed: () => void = () => {};
const extensionsListed = new Promise<void>((resolve) => {
  settleExtensionsListed = resolve;
});

export function whenExtensionsListed(): Promise<void> {
  return extensionsListed;
}
