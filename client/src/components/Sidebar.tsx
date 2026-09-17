import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { setContextKey } from "../contextKeys";
import {
  getRootDecorations,
  setExplorerPanelFocusBridge,
  setWorktreeBridge,
  setProjectsFocusBridge,
  type RegisteredSidebarPanel,
  type RegisteredSidebarTab,
  type RegisteredSidebarTabMenuItem,
  type RegisteredWindowAction,
} from "../extensions";
import { MIN_PANEL_HEIGHT, type PanelId, type PanelState, type TabDragState } from "../hooks/useSidebarLayout";
import {
  EXPLORER_TAB_ID,
  EXTENSIONS_TAB_ID,
  COMMANDS_TAB_ID,
  RUN_TAB_ID,
  defaultTabForPanel,
  isPanelHidden,
  moveTargetsForPanel,
  sectionsForTab,
  tabOfPanel,
  type PanelLike,
  type SidebarLayout,
  type SidebarSide,
  type TabEnv,
} from "../lib/sidebarLayout";
import { formatBinding, type Keybinding } from "../keybindings";
import type {
  ExtensionInfo,
  MenuItem,
  Project,
  RegistrySourceResult,
  TerminalSession,
  TerminalWindow,
} from "../types";
import ExtensionsPanel from "./ExtensionsPanel";
import FileTree from "./FileTree";
import Icon from "./Icon";
import ProjectList, { type ProjectListHandle, type ProjectListProps, type WorktreeBridgeHandlers } from "./ProjectList";
import SidebarTabStrip, { type SidebarTabInfo } from "./SidebarTabStrip";


// One side of the sidebar UI: the activity-bar tab strip plus the active
// tab's body. Which tabs are on this side, which one is active, and which
// sections each tab holds all come in as props — useSidebarLayout owns that
// state for both sides at once (lib/sidebarLayout.ts has the model). This
// file is the renderer.
//
// A tab's body is one of three shapes: the Extensions manager, an
// accordion of sections (Explorer/Run/Commands, and any tab a section was
// moved into), or a single extension panel filling the height (its own tab,
// untouched). The second and third are the same list of sections — one
// entry versus several.

interface Props {
  width: number;
  // Everything the PROJECTS tree needs, as one bundle. App builds it once
  // and hands the same object to this sidebar and to the status bar's
  // terminals popover, so the two can't drift — and so a change to the tree
  // (a new level, a new action) doesn't ripple through this component's
  // prop list. See plans/worktrees-into-projects.md.
  projectListProps: ProjectListProps;
  onOpenLazygit: () => void;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  // Opens the folder-picker dialog (App owns it) — the panel header's "+".
  onAddProject: () => void;
  // Builds the recent-projects dropdown items on demand (App wires in the
  // folder-picker opener) — shown via onShowMenu from the header button.
  recentProjectsMenu: () => MenuItem[];
  // The app-wide Manage menu this sidebar's gear button opens — built in
  // App, since it spans far more than one sidebar.
  manageMenuItems: () => MenuItem[];
  // The bottom terminal panel's toggle lives up here with the app's other
  // global chrome toggles (hide-sidebar below), not in a TabBar's actions —
  // that bar is rendered per editor group, so the button would duplicate in
  // every split pane.
  panelVisible: boolean;
  onTogglePanel: () => void;
  onCollapse: () => void;
  filesRootDir: string | null;
  // FILES-tree root mode: the active project's fixed folder, or the active
  // terminal's live cwd (follows `cd`). Toggled by the panel-header switch;
  // owned by App since the resolved root also feeds quick-switcher search.
  filesRootMode: "project" | "cwd";
  onFilesRootModeChange: (mode: "project" | "cwd") => void;
  onDropFiles: (destDir: string, dataTransfer: DataTransfer) => void;
  filesRefreshKey: number;
  onOpenFile: (path: string) => void;
  onPreviewFile: (path: string) => void;
  onEditFile: (path: string) => void;
  isPreviewable: (path: string) => boolean;
  fileHoverAction: (path: string) => "preview" | "edit" | null;
  fileMenuItems: (path: string, isDir: boolean, rootDir: string) => MenuItem[];
  fileTreeRootMenuItems: (rootDir: string) => MenuItem[];
  fileMultiMenuItems: (entries: { path: string; isDir: boolean }[]) => MenuItem[];
  deleteFileEntry: (path: string, isDir: boolean) => void;
  deleteFileEntries: (entries: { path: string; isDir: boolean }[]) => void;
  renameFileEntry: (path: string) => void;
  // Backs FileTree's files.findInFolder/newFile/newFolder/copyPath/
  // copyRelativePath keyboard dispatch (see FileTree.tsx's own prop docs).
  onFindInFolder: (path: string, rootDir: string) => void;
  onCreateFile: (dirPath: string) => void;
  onCreateFolder: (dirPath: string) => void;
  onCopyPath: (paths: string[]) => void;
  onCopyRelativePath: (paths: string[], rootDir: string) => void;
  prunePath: { paths: string[] } | null;
  cutPaths: Set<string> | null;
  onCopyEntries: (paths: string[]) => void;
  onCutEntries: (paths: string[]) => void;
  onPasteInto: (destDir: string) => void;
  onClearClipboard: () => void;
  // FILES-tree drag-and-drop: drag = move, Ctrl+drag = copy. Independent of
  // the clipboard props above — a drag never touches the cut/copy clipboard.
  onTransferEntries: (paths: string[], destDir: string, mode: "move" | "copy") => void;
  extensionPanels: RegisteredSidebarPanel[];
  extensionWindowActions: RegisteredWindowAction[];
  extensions: ExtensionInfo[];
  onReloadExtensions: () => void;
  extensionRegistries: string[];
  onExtensionRegistriesChange: (registries: string[]) => void;
  // The app's built-in default registry (or null if disabled) — shown as a
  // non-removable source in the Extensions panel; see ExtensionsPanel.
  defaultRegistry: string | null;
  // Which sidebar this instance is. Everything else about the side comes
  // through the props below; nothing in here reads "left" as a default.
  side: SidebarSide;
  // The whole layout (both sides) — this instance renders its own slice but
  // needs the rest to offer "move to a tab on the other side".
  layout: SidebarLayout;
  // This side's visible tabs and resolved active tab, already computed by
  // useSidebarLayout.
  tabs: string[];
  activeTabId: string | null;
  // Every section that could appear in a tab, built-ins included.
  panelsById: ReadonlyMap<string, PanelLike>;
  // What stored tab ids resolve against right now (see TabEnv).
  tabEnv: TabEnv;
  // Extension tabs with no panel of their own, and the strip menu items
  // extensions contribute.
  sidebarTabs: RegisteredSidebarTab[];
  sidebarTabMenuItems: RegisteredSidebarTabMenuItem[];
  panelState: PanelState;
  setPanelState: React.Dispatch<React.SetStateAction<PanelState>>;
  onSelectTab: (tabId: string) => void;
  // The right sidebar's own visibility, so the topbar's layout toggle can
  // show and flip it from either side.
  rightSidebarVisible: boolean;
  onToggleRightSidebar: () => void;
  // Phone/tablet (see App's own matchMedia): the footer drops its Manage
  // button there, since the status bar carries that menu on phones.
  mobilePointer: boolean;
  // False while App's custom title bar is up: it carries the footer's
  // buttons (plans/pwa-custom-title-bar.md). Only the left sidebar has one.
  showFooter: boolean;
  // Tab back/forward — the footer's two arrows (see useNavigationHistory).
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  // Reorder within this side; `index` is an index into this side's visible tabs.
  onReorderTab: (tabId: string, side: SidebarSide, index: number) => void;
  // Move a tab to a side (possibly the same one) at a visible index.
  onMoveTab: (tabId: string, side: SidebarSide, index: number) => void;
  // Rehome a section into a tab (either side).
  onMovePanel: (panelId: string, tabId: string) => void;
  // The in-flight tab drag, shared by both strips so the one under the
  // pointer can draw the drop indicator.
  tabDrag: TabDragState | null;
  onTabDragChange: (drag: TabDragState | null) => void;
  registryCatalog: RegistrySourceResult[];
  registryLoading: boolean;
  onEnsureRegistryLoaded: () => void;
  onRefreshRegistry: (refresh: boolean) => void;
  onOpenExtensionPage: (id: string, source?: string) => void;
  extensionUpdatesCount: number;
  // Live-resolved (defaults + user overrides) keybindings map, keyed by
  // command id — used to append each tab's current shortcut to its tooltip
  // (see tabInfos below) so a rebind in Settings shows up immediately.
  resolvedBindings: Record<string, Keybinding[]>;
  // Threaded down to extension panels (e.g. the ports panel's Kill process action).
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>;
}

export default function Sidebar({
  width,
  projectListProps,
  onOpenLazygit,
  onShowMenu,
  onAddProject,
  recentProjectsMenu,
  manageMenuItems,
  panelVisible,
  onTogglePanel,
  onCollapse,
  filesRootDir,
  filesRootMode,
  onFilesRootModeChange,
  onDropFiles,
  filesRefreshKey,
  onOpenFile,
  onPreviewFile,
  onEditFile,
  isPreviewable,
  fileHoverAction,
  fileMenuItems,
  fileTreeRootMenuItems,
  fileMultiMenuItems,
  deleteFileEntry,
  deleteFileEntries,
  renameFileEntry,
  onFindInFolder,
  onCreateFile,
  onCreateFolder,
  onCopyPath,
  onCopyRelativePath,
  prunePath,
  cutPaths,
  onCopyEntries,
  onCutEntries,
  onPasteInto,
  onClearClipboard,
  onTransferEntries,
  extensionPanels,
  extensions,
  onReloadExtensions,
  extensionRegistries,
  onExtensionRegistriesChange,
  defaultRegistry,
  side,
  layout,
  tabs: visibleTabOrder,
  activeTabId: activeTabIdProp,
  panelsById,
  tabEnv,
  sidebarTabs,
  sidebarTabMenuItems,
  panelState,
  setPanelState,
  onSelectTab,
  rightSidebarVisible,
  onToggleRightSidebar,
  mobilePointer,
  showFooter,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onReorderTab,
  onMoveTab,
  onMovePanel,
  tabDrag,
  onTabDragChange,
  registryCatalog,
  registryLoading,
  onEnsureRegistryLoaded,
  onRefreshRegistry,
  onOpenExtensionPage,
  extensionUpdatesCount,
  resolvedBindings,
  confirmDialog,
}: Props) {
  const projectListRef = useRef<ProjectListHandle>(null);
  // null means this side is open but holds no tabs — the right sidebar
  // before anything has been moved into it. It still renders its topbar (so
  // the layout toggles stay reachable) plus a hint, and its empty tab strip
  // is itself a drop target.
  const activeTabId = activeTabIdProp;
  // Teardown for an in-progress splitter drag's window listeners — invoked by
  // both the drag's own pointerup/pointercancel AND, as a safety net, by the
  // unmount effect below if Sidebar unmounts mid-drag (e.g. the whole sidebar
  // is hidden) so the listeners/body-class never outlive the component.
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => panelResizeCleanupRef.current?.();
  }, []);

  // Hiding the sidebar unmounts it (App.tsx's conditional render) without
  // firing a blur event on whatever was focused inside it — clear the
  // sidebarFocus context key directly so a when-clause bound to it doesn't
  // stay stuck true.
  useEffect(() => {
    return () => setContextKey("sidebarFocus", false);
  }, []);

  const panelRefs = useRef<Record<PanelId, HTMLDivElement | null>>({
    projects: null,
    files: null,
  });

  // Every registered extension panel, by id — for a section's title,
  // default collapse state, and component. Which tab it belongs to is the
  // layout's business (panelsById + sectionsForTab), not this lookup's.
  const extPanelById = new Map(extensionPanels.map((p) => [p.id, p]));

  const [dragPanelId, setDragPanelId] = useState<PanelId | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: PanelId; edge: "top" | "bottom" } | null>(
    null,
  );
  // Per-panel header actions container, keyed by panel id — the portal
  // target an extension panel renders its header-row buttons into (mirrors
  // TabBar's actionsRef/tabActionsEl for file-viewer toolbars). State (not
  // a plain ref) so a newly-mounted header re-renders the panel content
  // with the now-available DOM node.
  const [extPanelActionsEls, setExtPanelActionsEls] = useState<Record<PanelId, HTMLDivElement | null>>({});
  // A fresh inline `ref={(el) => ...}` closure every render makes React
  // detach+reattach the ref on every render (ref identity changed), which
  // re-triggered setExtPanelActionsEls every time and looped forever
  // ("Maximum update depth exceeded") — caught via a live browser check,
  // not by type-checking. Caching one stable callback per panel id avoids
  // the identity churn.
  const actionsRefCallbacks = useRef<Record<PanelId, (el: HTMLDivElement | null) => void>>({});
  const getActionsRefCallback = (id: PanelId) => {
    let cb = actionsRefCallbacks.current[id];
    if (!cb) {
      cb = (el) => {
        setExtPanelActionsEls((prev) => (prev[id] === el ? prev : { ...prev, [id]: el }));
      };
      actionsRefCallbacks.current[id] = cb;
    }
    return cb;
  };

  // The sections this tab shows, in the shared accordion order — one
  // question for every tab shape (see the module comment).
  const sectionsOf = (tabId: string) => sectionsForTab(panelState.order, tabEnv, layout, tabId);
  const containerTab = (tabId: string | null) =>
    tabId === null ? undefined : sidebarTabs.find((t) => t.id === tabId);

  // Extension items for the strip's right-click menu, evaluated per open.
  const stripMenuItems = (tabId: string | null): MenuItem[] => {
    const ctx = { tabId, side };
    return sidebarTabMenuItems
      .filter((item) => {
        try {
          return item.isVisible(ctx);
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
      .map((item) => ({ label: item.label, onClick: () => item.onClick(ctx) }));
  };

  // Appends " (Ctrl+Shift+E)" etc. to a tab's tooltip from its "Sidebar:
  // Focus <tab>" command's first binding — empty string (no-op) if that
  // command has no binding, e.g. an extension panel registered without a
  // focusBinding (see registerSidebarPanel).
  const shortcutSuffix = (commandId: string): string => {
    const key = resolvedBindings[commandId]?.[0]?.key;
    return key ? ` (${formatBinding(key)})` : "";
  };

  const tabInfos: SidebarTabInfo[] = visibleTabOrder.map((id) => {
    if (id === EXPLORER_TAB_ID) {
      return { id, title: `Explorer${shortcutSuffix("sidebar.focusExplorer")}`, icon: "files" };
    }
    if (id === RUN_TAB_ID) {
      return { id, title: `Run${shortcutSuffix("sidebar.focusRun")}`, icon: "run-all" };
    }
    if (id === COMMANDS_TAB_ID) {
      return { id, title: `Commands${shortcutSuffix("sidebar.focusCommands")}`, icon: "terminal" };
    }
    if (id === EXTENSIONS_TAB_ID) {
      return {
        id,
        title: `Extensions${shortcutSuffix("sidebar.focusExtensions")}`,
        icon: "extensions",
        badge: extensionUpdatesCount,
      };
    }
    const container = containerTab(id);
    if (container) return { id, title: container.title, icon: container.icon };
    const panel = extensionPanels.find((p) => p.id === id);
    return {
      id,
      title: `${panel?.title ?? id}${shortcutSuffix(`${id}.focus`)}`,
      icon: panel?.icon ?? "extensions",
      badge: panel?.badge,
    };
  });

  // Effective collapse state: an id with no stored entry falls back to the
  // extension panel's declared defaultCollapsed (the built-ins always have a
  // stored/default entry via DEFAULT_PANEL_STATE).
  const isPanelCollapsed = (id: PanelId): boolean =>
    panelState.collapsed[id] ?? extPanelById.get(id)?.defaultCollapsed ?? false;

  const togglePanelCollapsed = (id: PanelId) => {
    const next = !isPanelCollapsed(id);
    setPanelState((prev) => ({
      ...prev,
      collapsed: { ...prev.collapsed, [id]: next },
    }));
  };

  // Lets "Sidebar: Focus Projects" (App.tsx's globalHandlers, via
  // extensions.ts's focusProjectsPanel) expand this accordion panel and
  // hand off to ProjectList's own focusList — see setProjectsFocusBridge's
  // doc comment for why this lives in extensions.ts rather than being
  // called directly (App.tsx doesn't otherwise know about Sidebar's
  // internal panelState/ProjectList). Read via a ref (not the closed-over
  // panelState) since the bridge effect below only re-registers on mount.
  const panelStateRef = useRef(panelState);
  panelStateRef.current = panelState;
  // A collapsed panel unmounts ProjectList (panelContent's `!isCollapsed`
  // guard) — expanding it and calling focusList in the same tick would hit
  // a stale/null ref, since the DOM hasn't updated yet. Deferred here to the
  // next render where the panel is actually expanded and ProjectList has
  // (re)mounted.
  const pendingProjectsFocusRef = useRef(false);
  useEffect(() => {
    if (!panelState.collapsed.projects && pendingProjectsFocusRef.current) {
      pendingProjectsFocusRef.current = false;
      projectListRef.current?.focusList();
    }
  }, [panelState.collapsed.projects]);
  useEffect(() => {
    setProjectsFocusBridge(side, {
      focus: () => {
        if (panelStateRef.current.collapsed.projects) {
          pendingProjectsFocusRef.current = true;
          setPanelState((prev) => ({ ...prev, collapsed: { ...prev.collapsed, projects: false } }));
        } else {
          projectListRef.current?.focusList();
        }
      },
    });
    return () => setProjectsFocusBridge(side, null);
  }, []);

  // Generic bridge for accordion-located extension panels' focus commands,
  // in either tab (panel ids are unique, and collapse state/panel refs are
  // shared): expand the section if collapsed, then move
  // focus onto the first focusable row inside its content. An extension
  // component can't expose an imperative focusList handle through the
  // generic render, so "first roving-tabindex stop" is the contract — the
  // same landing spot ProjectList/PortsPanel's own focusList pick when
  // nothing was focused yet. Expansion unmounts→mounts content, so the
  // focus is deferred one render, mirroring the sessions bridge above.
  const pendingExplorerFocusRef = useRef<string | null>(null);
  const focusExplorerPanelContent = (panelId: string) => {
    const content = panelRefs.current[panelId]?.querySelector<HTMLElement>(
      '.panel-content [tabindex="0"], .panel-content button, .panel-content [href], .panel-content input',
    );
    content?.focus();
  };
  useEffect(() => {
    const pending = pendingExplorerFocusRef.current;
    if (pending && panelState.collapsed[pending] === false) {
      pendingExplorerFocusRef.current = null;
      focusExplorerPanelContent(pending);
    }
  }, [panelState.collapsed]);
  useEffect(() => {
    setExplorerPanelFocusBridge(side, {
      focus: (panelId: string) => {
        if (panelStateRef.current.collapsed[panelId] !== false) {
          pendingExplorerFocusRef.current = panelId;
          setPanelState((prev) => ({ ...prev, collapsed: { ...prev.collapsed, [panelId]: false } }));
        } else {
          focusExplorerPanelContent(panelId);
        }
      },
    });
    return () => setExplorerPanelFocusBridge(side, null);
  }, []);

  // Lets the worktrees extension's palette commands reach the tree's
  // worktree actions on this side. Stable identity so ProjectList's effect
  // registers once, not on every render.
  const registerWorktreeBridge = useCallback(
    (bridge: WorktreeBridgeHandlers | null) => {
      setWorktreeBridge(side, bridge);
    },
    [side],
  );

  const panelTitle = (id: PanelId): string => {
    if (id === "projects") return "Projects";
    if (id === "files") return filesRootDir ?? "Files";
    return extPanelById.get(id)?.title ?? id;
  };

  // A pane's stable name, for menus. Distinct from panelTitle above, whose
  // FILES header doubles as a breadcrumb and reads out the current root
  // directory — a whole path is no way to name a checkbox.
  const paneName = (id: PanelId): string => {
    if (id === "projects") return "Projects";
    if (id === "files") return "Explorer";
    return extPanelById.get(id)?.title ?? id;
  };

  const panelActions = (id: PanelId) => {
    if (id === "projects") {
      return (
        <>
          <button
            className="icon-button"
            title="Open Recent…"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onShowMenu(rect.left, rect.bottom + 4, recentProjectsMenu());
            }}
          >
            <Icon name="history" />
          </button>
          <button className="icon-button" title="New Project…" onClick={onAddProject}>
            <Icon name="add" />
          </button>
        </>
      );
    }
    if (id === "files") {
      return (
        <>
          {/* One toggle for the two root modes, showing the mode a click
              switches to (the header's path already says which is active). */}
          {filesRootMode === "project" ? (
            <button
              className="icon-button"
              title="Follow the terminal's folder (follows cd)"
              onClick={() => onFilesRootModeChange("cwd")}
            >
              <Icon name="terminal" />
            </button>
          ) : (
            <button
              className="icon-button"
              title="Show the project folder"
              onClick={() => onFilesRootModeChange("project")}
            >
              <Icon name="root-folder" />
            </button>
          )}
        </>
      );
    }
    // Extension accordion sections put their own header buttons into the
    // actions container via the actionsTarget portal instead.
    return null;
  };

  const panelContent = (id: PanelId) => {
    if (id === "projects") {
      return (
        <ProjectList
          ref={projectListRef}
          {...projectListProps}
          registerWorktreeBridge={registerWorktreeBridge}
        />
      );
    }
    if (id === "files") {
      return (
        <FileTree
          rootDir={filesRootDir}
          onDropFiles={onDropFiles}
          refreshKey={filesRefreshKey}
          onOpenFile={onOpenFile}
          onPreviewFile={onPreviewFile}
          onEditFile={onEditFile}
          isPreviewable={isPreviewable}
          fileHoverAction={fileHoverAction}
          onShowMenu={onShowMenu}
          fileMenuItems={fileMenuItems}
          fileTreeRootMenuItems={fileTreeRootMenuItems}
          fileMultiMenuItems={fileMultiMenuItems}
          deleteFileEntry={deleteFileEntry}
          deleteFileEntries={deleteFileEntries}
          renameFileEntry={renameFileEntry}
          onFindInFolder={onFindInFolder}
          onCreateFile={onCreateFile}
          onCreateFolder={onCreateFolder}
          onCopyPath={onCopyPath}
          onCopyRelativePath={onCopyRelativePath}
          resolvedBindings={resolvedBindings}
          prunePath={prunePath}
          cutPaths={cutPaths}
          onCopyEntries={onCopyEntries}
          onCutEntries={onCutEntries}
          onPasteInto={onPasteInto}
          onClearClipboard={onClearClipboard}
          onTransferEntries={onTransferEntries}
        />
      );
    }
    const extPanel = extPanelById.get(id);
    if (extPanel) {
      const PanelComponent = extPanel.component;
      return (
        <PanelComponent
          actionsTarget={extPanelActionsEls[id] ?? null}
          showMenu={onShowMenu}
          confirmDialog={confirmDialog}
        />
      );
    }
    return null;
  };

  // Converts a pointer drag into flex-grow weights for the two panels
  // straddling the splitter. Weights are seeded from measured pixel heights
  // at drag start, clamped so neither panel shrinks below MIN_PANEL_HEIGHT;
  // only these two panels' weights change, so any other expanded panel's
  // share of the remaining space is undisturbed.
  const startPanelResize = (e: React.PointerEvent, aId: PanelId, bId: PanelId) => {
    e.preventDefault();
    const aEl = panelRefs.current[aId];
    const bEl = panelRefs.current[bId];
    if (!aEl || !bEl) return;
    const startHeightA = aEl.getBoundingClientRect().height;
    const startHeightB = bEl.getBoundingClientRect().height;
    const totalHeight = startHeightA + startHeightB;
    const startY = e.clientY;
    const pointerId = e.pointerId;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dy = ev.clientY - startY;
      const newHeightA = Math.min(
        totalHeight - MIN_PANEL_HEIGHT,
        Math.max(MIN_PANEL_HEIGHT, startHeightA + dy),
      );
      const newHeightB = totalHeight - newHeightA;
      setPanelState((prev) => ({
        ...prev,
        sizes: { ...prev.sizes, [aId]: newHeightA, [bId]: newHeightB },
      }));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing-row");
      panelResizeCleanupRef.current = null;
    };
    document.body.classList.add("resizing-row");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    panelResizeCleanupRef.current = () => end({ pointerId } as PointerEvent);
  };

  const PANEL_DRAG_TYPE = "application/x-perch-panel";

  const headerDragHandlers = (id: PanelId) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(PANEL_DRAG_TYPE, id);
      e.dataTransfer.effectAllowed = "move";
      setDragPanelId(id);
    },
    onDragEnd: () => {
      setDragPanelId(null);
      setDropIndicator(null);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(PANEL_DRAG_TYPE) || !dragPanelId || dragPanelId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const edge: "top" | "bottom" = e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
      setDropIndicator({ id, edge });
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDropIndicator(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(PANEL_DRAG_TYPE)) return;
      e.preventDefault();
      const draggedId = e.dataTransfer.getData(PANEL_DRAG_TYPE) as PanelId;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const edge: "top" | "bottom" = e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
      setDropIndicator(null);
      setDragPanelId(null);
      if (!draggedId || draggedId === id) return;
      setPanelState((prev) => {
        const withoutDragged = prev.order.filter((p) => p !== draggedId);
        const targetIdx = withoutDragged.indexOf(id);
        const insertAt = edge === "top" ? targetIdx : targetIdx + 1;
        const next = [...withoutDragged];
        next.splice(insertAt, 0, draggedId);
        return { ...prev, order: next };
      });
    },
  });

  // The FILES header branch pill, sourced from extension root decorations
  // (git-scm's file-decoration provider) — the app re-renders on registry
  // notify (App's useExtensionRegistry tick feeds the extensionPanels prop),
  // so a provider refresh() lands here without a dedicated subscription.
  const filesBranch = filesRootDir ? (getRootDecorations(filesRootDir)[0]?.label ?? null) : null;

  // A tab's human name, for the "Move to <Tab>" menu rows. Core tabs have
  // fixed names; an extension tab is named after the panel that owns it.
  const tabTitle = (tabId: string): string => {
    if (tabId === EXPLORER_TAB_ID) return "Explorer";
    if (tabId === RUN_TAB_ID) return "Run";
    if (tabId === COMMANDS_TAB_ID) return "Commands";
    if (tabId === EXTENSIONS_TAB_ID) return "Extensions";
    return containerTab(tabId)?.title ?? extPanelById.get(tabId)?.title ?? tabId;
  };

  // Right-clicking a section header offers every tab it could move to, on
  // either side — the keyboard/menu counterpart of dragging the header onto
  // a tab icon. "Reset Location" appears only while the section is somewhere
  // its extension didn't put it.
  const panelMoveMenuItems = (panelId: PanelId): MenuItem[] => {
    const panel = panelsById.get(panelId);
    if (!panel) return [];
    const items: MenuItem[] = moveTargetsForPanel(layout, panel, panelState.order, tabEnv).map((target) => ({
      label: `Move to ${tabTitle(target.tabId)}${target.side === side ? "" : target.side === "right" ? " (right)" : " (left)"}`,
      onClick: () => onMovePanel(panelId, target.tabId),
    }));
    if (layout.panelHome[panelId] !== undefined) {
      if (items.length > 0) items.push({ label: "", separator: true, onClick: () => {} });
      items.push({
        label: `Reset Location (${tabTitle(defaultTabForPanel(panel))})`,
        onClick: () => onMovePanel(panelId, defaultTabForPanel(panel)),
      });
    }
    return items;
  };

  const renderPanel = (id: PanelId, nextId: PanelId | null) => {
    const isCollapsed = isPanelCollapsed(id);
    const showSplitterAfter = !isCollapsed && nextId !== null && !isPanelCollapsed(nextId);
    const indicatorClass =
      dropIndicator?.id === id ? ` drop-indicator-${dropIndicator.edge}` : "";

    return (
      <Fragment key={id}>
        <div
          ref={(el) => {
            panelRefs.current[id] = el;
          }}
          className={`sidebar-panel${isCollapsed ? " collapsed" : ""}`}
          style={isCollapsed ? undefined : { flex: `${panelState.sizes[id] ?? 1} 1 0px` }}
        >
          <div
            className={`panel-header${indicatorClass}${dragPanelId === id ? " dragging" : ""}`}
            onClick={() => togglePanelCollapsed(id)}
            onContextMenu={(e) => {
              const items = panelMoveMenuItems(id);
              if (items.length === 0) return;
              e.preventDefault();
              e.stopPropagation();
              onShowMenu(e.clientX, e.clientY, items);
            }}
            {...headerDragHandlers(id)}
          >
            <span className="chevron">
              <Icon name={isCollapsed ? "chevron-right" : "chevron-down"} />
            </span>
            <span className="sidebar-title" title={id === "files" ? panelTitle(id) : undefined}>
              {panelTitle(id)}
            </span>
            {id === "files" && filesBranch && (
              <button
                className="branch-pill"
                title={`Branch: ${filesBranch} - click to open lazygit`}
                onClick={(e) => {
                  // The header's own click toggles panel collapse.
                  e.stopPropagation();
                  onOpenLazygit();
                }}
              >
                {filesBranch}
              </button>
            )}
            <div
              className="sidebar-actions"
              ref={getActionsRefCallback(id)}
              onClick={(e) => e.stopPropagation()}
            >
              {panelActions(id)}
            </div>
          </div>
          {!isCollapsed && <div className="panel-content">{panelContent(id)}</div>}
        </div>
        {showSplitterAfter && (
          <div
            className="panel-splitter"
            onPointerDown={(e) => startPanelResize(e, id, nextId!)}
          />
        )}
      </Fragment>
    );
  };

  // The active tab's sections. panelState.order is shared by every tab and
  // may hold stale ids (a disabled extension's section, or one belonging to
  // another tab) — sectionsForTab filters rather than pruning, so nothing
  // is forgotten while an extension is still activating.
  const activeSections = activeTabId === null ? [] : sectionsOf(activeTabId);
  const activeContainer = containerTab(activeTabId);
  // Whether a pane the user hid still calls this tab home — then the tab
  // isn't empty, its panes are just hidden.
  const hasHiddenPanes = (tabId: string | null) =>
    tabId !== null &&
    panelState.order.some((id) => {
      const panel = panelsById.get(id);
      return !!panel && isPanelHidden(layout, panel) && tabOfPanel(layout, panel, tabEnv) === tabId;
    });
  // A tab is hovering this sidebar's panel area — dropping it here makes it
  // a section of the tab currently showing.
  const tabDropClass =
    tabDrag?.indicator?.edge === "body" && tabDrag.indicator.side === side ? " tab-drop-target" : "";
  // A tab whose only section is the extension panel that OWNS the tab keeps
  // the full-height, non-collapsible presentation it had before sections
  // could move; anything else is an accordion.
  const ownPanel = activeTabId === null ? undefined : extPanelById.get(activeTabId);
  const showsOwnPanelOnly =
    !!ownPanel && activeSections.length === 1 && activeSections[0] === activeTabId;

  const renderExtensionTab = (panel: RegisteredSidebarPanel) => {
    const PanelComponent = panel.component;
    return (
      <div className="sidebar-ext-tab">
        {/* Draggable and right-clickable like any section header, so a panel
            showing as its own tab can be moved into an accordion — the
            reverse of dropping a section onto this tab's icon. */}
        <div
          className={`panel-header ext-tab-header${dragPanelId === panel.id ? " dragging" : ""}`}
          onContextMenu={(e) => {
            const items = panelMoveMenuItems(panel.id);
            if (items.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            onShowMenu(e.clientX, e.clientY, items);
          }}
          {...headerDragHandlers(panel.id)}
        >
          <span className="sidebar-title">{panel.title}</span>
          <div
            className="sidebar-actions"
            ref={getActionsRefCallback(panel.id)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        <div className="panel-content ext-tab-content">
          <PanelComponent
            actionsTarget={extPanelActionsEls[panel.id] ?? null}
            showMenu={onShowMenu}
            confirmDialog={confirmDialog}
          />
        </div>
      </div>
    );
  };

  return (
    <aside
      className={`sidebar${side === "right" ? " sidebar-right" : ""}`}
      data-side={side}
      style={{ width }}
      onFocusCapture={() => setContextKey("sidebarFocus", true)}
      onBlurCapture={(e) => {
        // relatedTarget is null when focus leaves the document entirely
        // (e.g. to the browser chrome) — treat that as "left the sidebar"
        // too, so the key can't get stuck true.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setContextKey("sidebarFocus", false);
        }
      }}
    >
      <div className="sidebar-topbar">
        <SidebarTabStrip
          side={side}
          tabs={tabInfos}
          activeId={activeTabId ?? ""}
          onSelect={onSelectTab}
          onReorder={(id, index) => onReorderTab(id, side, index)}
          onMoveToSide={onMoveTab}
          onDropPanel={onMovePanel}
          isPanelTab={(tabId) => panelsById.has(tabId)}
          extraMenuItems={stripMenuItems}
          onShowMenu={onShowMenu}
          drag={tabDrag}
          onDragChange={onTabDragChange}
        />
      </div>
      {activeTabId === null ? (
        <div className="sidebar-empty">
          Drag a tab here from the other sidebar, or right-click a tab and choose “Move to{" "}
          {side === "right" ? "Right" : "Left"} Sidebar”.
        </div>
      ) : activeTabId === EXTENSIONS_TAB_ID ? (
        <ExtensionsPanel
          extensions={extensions}
          onReloadExtensions={onReloadExtensions}
          registries={extensionRegistries}
          onRegistriesChange={onExtensionRegistriesChange}
          defaultRegistry={defaultRegistry}
          registryCatalog={registryCatalog}
          registryLoading={registryLoading}
          onEnsureRegistryLoaded={onEnsureRegistryLoaded}
          onRefreshRegistry={onRefreshRegistry}
          onOpenExtensionPage={onOpenExtensionPage}
        />
      ) : showsOwnPanelOnly && ownPanel ? (
        <div className={`sidebar-body${tabDropClass}`} data-host-tab={activeTabId}>
          {renderExtensionTab(ownPanel)}
        </div>
      ) : (
        <div className={`sidebar-body sidebar-panels${tabDropClass}`} data-host-tab={activeTabId}>
          {activeSections.map((id, idx) => renderPanel(id, activeSections[idx + 1] ?? null))}
          {/* Hiding every pane of a tab is allowed, so the way back has to
              be on screen — the gear menu's Panes list is the only route. An
              extension container tab with nothing in it says how to fill it
              instead. */}
          {activeSections.length === 0 &&
            (activeContainer && !hasHiddenPanes(activeTabId) ? (
              <div className="sidebar-empty">
                {activeContainer.title} is empty. Drop a pane header on its icon, or right-click a pane header
                and choose Move to {activeContainer.title}.
              </div>
            ) : (
              <div className="sidebar-empty">
                All panes hidden. Use the gear menu&apos;s Panes list to show one.
              </div>
            ))}
        </div>
      )}
      {/* Layout controls and navigation live in the LEFT sidebar's footer
          only: one home for them, rather than a duplicate set in each
          sidebar. They sat in the header before, competing for width with a
          tab strip that scrolls once an extension or two contributes a tab. */}
      {side === "left" && showFooter && (
        <footer className="sidebar-footer">
          <div className="sidebar-footer-group">
            {/* Settings is the one control the status bar also carries (its
                phone-only Manage item), so the footer drops it there rather
                than offering the same menu twice within a thumb's reach. */}
            {!mobilePointer && (
              <button
                className="icon-button"
                title="Manage"
                aria-haspopup="menu"
                data-menu-trigger="true"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  // Anchored at the button's TOP edge: showMenu clamps into
                  // the viewport, so from down here the menu opens upward.
                  onShowMenu(rect.left, rect.top, manageMenuItems());
                }}
              >
                <Icon name="gear" />
              </button>
            )}
            <button
              className={`icon-button${panelVisible ? " active" : ""}`}
              title={`Toggle bottom panel${shortcutSuffix("panel.toggle")}`}
              aria-pressed={panelVisible}
              onClick={onTogglePanel}
            >
              {/* Filled while open, outline while closed — the same state
                  convention VS Code's own layout toggles use. */}
              <Icon name={panelVisible ? "layout-panel" : "layout-panel-off"} />
            </button>
            <button
              className="icon-button active"
              title={`Toggle left sidebar${shortcutSuffix("sidebar.toggle")}`}
              aria-pressed={true}
              onClick={onCollapse}
            >
              {/* Always filled: this only renders while the left sidebar is
                  open (its closed-state affordance is App's 4px reopen strip). */}
              <Icon name="layout-sidebar-left" />
            </button>
            <button
              className={`icon-button${rightSidebarVisible ? " active" : ""}`}
              title={`Toggle right sidebar${shortcutSuffix("sidebar.toggleRight")}`}
              aria-pressed={rightSidebarVisible}
              onClick={onToggleRightSidebar}
            >
              <Icon name={rightSidebarVisible ? "layout-sidebar-right" : "layout-sidebar-right-off"} />
            </button>
          </div>
          {/* Back/forward over the tabs you've been in — see
              useNavigationHistory. Disabled rather than hidden when there's
              nowhere to go, so the pair never shifts under the pointer. */}
          <div className="sidebar-footer-group">
            <button
              className="icon-button"
              title="Go Back"
              disabled={!canGoBack}
              onClick={onGoBack}
            >
              <Icon name="arrow-left" />
            </button>
            <button
              className="icon-button"
              title="Go Forward"
              disabled={!canGoForward}
              onClick={onGoForward}
            >
              <Icon name="arrow-right" />
            </button>
          </div>
        </footer>
      )}
    </aside>
  );
}

