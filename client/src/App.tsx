import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import BottomPanel from "./components/BottomPanel";
import ContextMenu from "./components/ContextMenu";
import Dialog from "./components/Dialog";
import FolderPickerDialog from "./components/FolderPickerDialog";
import ExtensionPageView from "./components/ExtensionPageView";
import Icon from "./components/Icon";
import KeyboardShortcutsView from "./components/KeyboardShortcutsView";
import QuickSwitcher, { type PaletteCommand } from "./components/QuickSwitcher";
import ImportSettingsDialog from "./components/settings/ImportSettingsDialog";
import SettingsView from "./components/SettingsView";
import Sidebar from "./components/Sidebar";
import SplitLayout from "./components/SplitLayout";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import TerminalView from "./components/TerminalView";
import {
  COMMANDS_TAB_ID,
  EXPLORER_TAB_ID,
  EXTENSIONS_TAB_ID,
  RUN_TAB_ID,
  type SidebarSide,
} from "./lib/sidebarLayout";
import { getContextGetter, setContextKey } from "./contextKeys";
import { listColorThemeOptions } from "./theme";
import {
  extensionTabGroupMenuItems,
  focusProjectsPanel,
  focusSidebarTab,
  requestTerminalRefocus,
  setExecuteCommandHandler,
  setExtensionSettingUpdater,
  setGetCommandsHandler,
  setKillSessionHandler,
  setDialogHandlers,
  setOpenSessionWindowHandler,
  resolveWindowActionIcon,
  useExtensionRegistry,
} from "./extensions";
import { useDialogs } from "./hooks/useDialogs";
import { useSidebarLayout } from "./hooks/useSidebarLayout";
import { useStatusBarLayout } from "./hooks/useStatusBarLayout";
import { useFileActions } from "./hooks/useFileActions";
import { useFileOpeners } from "./hooks/useFileOpeners";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings";
import { COMMANDS, formatBinding } from "./keybindings";
import { DEFAULT_SETTINGS } from "./settings";
import { evaluateWhen } from "./whenClause";
import { useBottomPanel } from "./hooks/useBottomPanel";
import { useOpenTarget } from "./hooks/useOpenTarget";
import { useSessionActions } from "./hooks/useSessionActions";
import { useSessions } from "./hooks/useSessions";
import { useWorktrees } from "./hooks/useWorktrees";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useNavigationHistory } from "./hooks/useNavigationHistory";
import { useWindowControlsOverlay } from "./hooks/useWindowControlsOverlay";
import { useTabGroups } from "./hooks/useTabGroups";
import { useTabs } from "./hooks/useTabs";
import { useGitRootDir } from "./hooks/useGitRootDir";
import { useThemeAssets } from "./hooks/useThemeAssets";
import type { MenuItem, MenuState, OpenTargetPayload, RegistrySourceResult, Tab, TerminalSession } from "./types";
import { groupKeyForTab, isRealTab } from "./lib/tabs";
import {
  bumpRecent,
  isLinkedWorktreePath,
  projectName,
  sessionNameForProject,
  withoutWorktreeRecents,
} from "./lib/projects";
import { leaves } from "./lib/splits";
import { emitPollTick } from "./lib/pollTick";
import { rewriteLocalUrl } from "./lib/openUrlRewrite";
import { compareVersions } from "./lib/version";
import { isAbsolutePath, parentPath } from "./lib/paths";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;

// The server templates the real app name (see APP_NAME in server/.env) into
// index.html's <title> before this module ever loads, so capturing it here
// — before the effect below overwrites it — picks up any custom name.
const APP_NAME = document.title;

// Commands that exist for Settings → Keyboard (rebindable) and their own
// component's direct dispatch, but make no sense as a palette entry to
// "run" — see paletteCommands' comment below.
const NON_PALETTE_IDS = new Set([
  "quickSwitcher.selectNext",
  "quickSwitcher.selectPrevious",
  ...Array.from({ length: 9 }, (_, i) => `tab.focus${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `group.focus${i + 1}`),
]);

export default function App() {
  // Declared first so useSessions (which needs showError) and the files
  // concern below (filesRefreshKey, driven by mutation actions — the poll
  // itself now drives FileTree via pollTick, not this state) are both
  // available before that hook call.
  const [error, setError] = useState<string | null>(null);
  const showError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  // Browser-opener bridge (plans/browser-opener-bridge.md): the server
  // relays a pane's "open a URL" attempt (the $BROWSER shim) over SSE; the
  // app tab that currently has focus opens it — riding the transient user
  // activation left by the keypress that triggered the open. When the popup
  // is blocked anyway, a clickable banner is the fallback. Unfocused tabs
  // ignore the event, so N open tabs never produce N popups.
  const [openUrlBanner, setOpenUrlBanner] = useState<string | null>(null);
  useEffect(() => {
    if (!openUrlBanner) return;
    const t = setTimeout(() => setOpenUrlBanner(null), 15000);
    return () => clearTimeout(t);
  }, [openUrlBanner]);
  // `perch open` bridge (plans/cli-open-command.md): populated below,
  // once openProject/extFileViewers/etc are all in scope, via the same
  // ref-bridge pattern refreshClipboardMirrorRef uses — this effect (and the
  // EventSource it owns) mounts long before useOpenTarget's callback exists.
  const openTargetRef = useRef<(payload: OpenTargetPayload) => void>(() => {});
  useEffect(() => {
    // Prefetched (not per-event) so the open itself never awaits a fetch —
    // transient activation only lasts a few seconds.
    let proxyDomain: string | null = null;
    fetch("/api/proxy-config")
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg: { domain?: string | null } | null) => {
        proxyDomain = cfg?.domain ?? null;
      })
      .catch(() => {});
    const es = new EventSource("/api/open-url/events");
    es.onmessage = (e: MessageEvent<string>) => {
      if (!document.hasFocus()) return;
      let payload: { url?: unknown; serverPort?: unknown };
      try {
        payload = JSON.parse(e.data) as { url?: unknown; serverPort?: unknown };
      } catch {
        return;
      }
      if (typeof payload.url !== "string" || typeof payload.serverPort !== "number") return;
      const target = rewriteLocalUrl(payload.url, window.location.origin, proxyDomain, payload.serverPort);
      if (!target) return;
      const opened = window.open(target, "_blank", "noopener,noreferrer");
      if (!opened) setOpenUrlBanner(target);
    };
    // In-app navigation, not a popup — every connected tab handles it (no
    // document.hasFocus() gate); openProject/openWindowTab are idempotent,
    // so N tabs handling the same event just re-focuses each one.
    es.addEventListener("open-target", (e) => {
      const evt = e as MessageEvent<string>;
      try {
        openTargetRef.current(JSON.parse(evt.data) as OpenTargetPayload);
      } catch {
        // malformed payload; drop it
      }
    });
    return () => es.close();
  }, []);

  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  // refreshClipboardMirror itself comes from useFileActions, called much
  // later in this component (it needs setFilesRefreshKey, declared here) —
  // a ref bridges that ordering gap, same pattern as useBottomPanel's
  // panelRef: populated every render, read from the stable callback below.
  const refreshClipboardMirrorRef = useRef<() => void>(() => {});
  // Piggybacks on the session poll so git status badges in the FILES panel
  // (and, via the ref above, the FILES-tree cut-clipboard mirror) stay live
  // without a second timer. emitPollTick fans out to every subscribed
  // FileTree directly (see lib/pollTick.ts) — deliberately NOT App state
  // (filesRefreshKey stays reserved for mutation-driven refreshes below):
  // bumping state here would re-render this entire component tree on every
  // idle 3s tick even when nothing changed. Must be a stable useCallback,
  // not an inline arrow — an unstable identity here would change
  // useSessions' internal `refresh` callback's identity every render,
  // retriggering its mount effect (and firing a fresh fetch) on every
  // render instead of once every 3s.
  const onSessionsRefreshed = useCallback(() => {
    emitPollTick();
    refreshClipboardMirrorRef.current();
  }, []);

  const { sessions, refresh, sessionsLoadedRef } = useSessions(showError, onSessionsRefreshed);

  // Which repository each session folder belongs to, and that repository's
  // worktrees — the PROJECTS tree's middle level. Mounted once here so the
  // sidebar's tree and the status bar's terminals popover read one poll
  // rather than two. See plans/worktrees-into-projects.md.
  const sessionPaths = useMemo(() => sessions.map((s) => s.path).filter(Boolean), [sessions]);
  const { repoIndex } = useWorktrees(sessionPaths);

  const [menu, setMenu] = useState<MenuState | null>(null);
  // Each editor group's own TabBar right-side actions container — an image
  // tab portals its zoom toolbar into its own group's bar while active (VS
  // Code/code-server editor-actions placement). State (not a plain ref)
  // because the portaling viewer needs to re-render once its group's element
  // becomes non-null on first mount. Keyed by groupId — mirrors Sidebar.tsx's
  // extPanelActionsEls/getActionsRefCallback pattern for the same reason: a
  // fresh inline ref closure per render would re-trigger the state update
  // every render and loop forever (caught live there, not by inspection).
  const [groupActionsEls, setGroupActionsEls] = useState<Record<string, HTMLDivElement | null>>({});
  const groupActionsRefCallbacks = useRef<Record<string, (el: HTMLDivElement | null) => void>>({});
  const getGroupActionsRef = useCallback((groupId: string) => {
    let cb = groupActionsRefCallbacks.current[groupId];
    if (!cb) {
      cb = (el) => {
        setGroupActionsEls((prev) => (prev[groupId] === el ? prev : { ...prev, [groupId]: el }));
      };
      groupActionsRefCallbacks.current[groupId] = cb;
    }
    return cb;
  }, []);
  // Each editor group's own content-area rect, in viewport pixels — every
  // tab's actual content component (terminal/viewer/settings) renders in a
  // flat, never-reshaping list (see the tabs.map(...) below) positioned via
  // this rect, rather than nested inside SplitLayout's recursive tree.
  // SplitLayout's tree reshapes (leaf <-> branch) as groups split/merge,
  // which changes the rendered element TYPE at that tree position — React
  // can't reconcile across a type change, so it unmounts and rebuilds the
  // whole subtree, and even a stable DOM node "identity" (e.g. a portal
  // target inside that subtree) doesn't survive since the node itself gets
  // destroyed. Content therefore only ever lives in App's own flat list,
  // and .split-leaf-content (still nested in the tree) is a pure layout
  // spacer we measure, not a mount point — caught live via a dirty CSV
  // tab's edit resetting on its very first split, not by inspection.
  const [groupContentRects, setGroupContentRects] = useState<Record<string, DOMRect | null>>({});
  const groupContentObservers = useRef<Record<string, ResizeObserver>>({});
  // Live measure closures, keyed like the observers — so the scroll-settle
  // effect below can re-run them: a scroll-only correction moves the spacers
  // without resizing them, which no ResizeObserver ever reports.
  const groupContentMeasures = useRef<Record<string, () => void>>({});
  // Cached per groupId, same as getGroupActionsRef above — a fresh inline
  // ref closure every render makes React detach+reattach the ref (identity
  // changed) on every render, which re-triggers the ResizeObserver
  // setup/measure below every time and loops forever (caught live as a
  // "Maximum update depth exceeded" crash, not by inspection).
  const groupContentSlotRefCallbacks = useRef<Record<string, (el: HTMLDivElement | null) => void>>({});
  const getGroupContentSlotRef = useCallback((groupId: string) => {
    let cb = groupContentSlotRefCallbacks.current[groupId];
    if (!cb) {
      cb = (el) => {
        groupContentObservers.current[groupId]?.disconnect();
        delete groupContentObservers.current[groupId];
        delete groupContentMeasures.current[groupId];
        if (!el) {
          setGroupContentRects((prev) => (prev[groupId] == null ? prev : { ...prev, [groupId]: null }));
          return;
        }
        const measure = () => {
          // Never cache a rect measured against a scrolled page: the content
          // hosts consuming it are position:fixed (scroll-immune), so a
          // scroll-shifted rect strands them off their spacer. The app is
          // pinned to 0,0 (visualViewport effect below); during the
          // transient scrolls of the on-screen-keyboard transition, keep the
          // last good rect and let the scroll-settle effect re-measure.
          if (window.scrollX !== 0 || window.scrollY !== 0) return;
          setGroupContentRects((prev) => ({ ...prev, [groupId]: el.getBoundingClientRect() }));
        };
        groupContentMeasures.current[groupId] = measure;
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        groupContentObservers.current[groupId] = observer;
        measure();
      };
      groupContentSlotRefCallbacks.current[groupId] = cb;
    }
    return cb;
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("sidebarWidth"));
    return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : 260;
  });

  useEffect(() => {
    localStorage.setItem("sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  const [sidebarVisible, setSidebarVisible] = useState(() => {
    const stored = localStorage.getItem("sidebarVisible");
    if (stored !== null) return stored !== "false";
    // No stored preference means a first visit. On a phone the sidebar is a
    // drawer over the terminal, so opening it by default hides the very
    // thing the app is for; on a desktop it shares the width and starts
    // open, as it always has. An explicit choice above always wins.
    return !window.matchMedia("(pointer: coarse) and (hover: none)").matches;
  });
  // The right (secondary) sidebar mirrors the left one's width/visibility
  // state; it simply renders nothing until a tab is dragged onto it.
  const [sidebarRightWidth, setSidebarRightWidth] = useState(() => {
    const stored = Number(localStorage.getItem("sidebarRightWidth"));
    return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : 260;
  });
  // Defaults to CLOSED (unlike the left one): it starts empty, so showing it
  // uninvited would just take space from the editor.
  const [rightSidebarVisible, setRightSidebarVisible] = useState(
    () => localStorage.getItem("sidebarRightVisible") === "true",
  );

  // The Open Folder dialog (FolderPickerDialog) — opened by the PROJECTS
  // panel's "+", the recent-projects dropdown's "Open Folder…", the
  // "Project: New…" command ("project" mode: a pick lands in openProject),
  // and the bottom panel's "New Project…" ("panelTerminal" mode: a pick
  // opens a panel terminal in the picked project instead).
  const [folderPickerMode, setFolderPickerMode] = useState<null | "project" | "panelTerminal">(null);

  // The settings bundle waiting on its import preview. Held here, and
  // rendered at the app root below beside every other dialog, because
  // SettingsView lives inside a .split-content-host - a stacking context with
  // hidden overflow, which would trap the dialog in that tab's own layer.
  const [importBundle, setImportBundle] = useState<api.SettingsBundle | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // The settings import's file input, beside the dialog and the bundle state
  // it feeds. At the app root rather than in the settings tab because a tab's
  // content is unmounted whenever its measured rect is missing (see
  // `if (!rect) return null` below), and a file input must outlive its own
  // picker. Rendered off-screen rather than display:none, since a
  // display:none input cannot be opened programmatically in every browser.
  const importInputRef = useRef<HTMLInputElement>(null);

  // Parsed here so a file that is not JSON at all fails before any dialog
  // opens. Whether it is a *bundle* is the server's call, reported inside the
  // dialog itself.
  const pickImportFile = useCallback(async (file: File) => {
    setImportError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setImportError(`${file.name} is not a JSON file.`);
      return;
    }
    // Valid JSON can still be null, a number or an array, and a falsy value
    // would open no dialog and report nothing - a dead-end click.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setImportError(`${file.name} does not contain a settings bundle.`);
      return;
    }
    setImportBundle(parsed as api.SettingsBundle);
  }, []);

  useEffect(() => {
    localStorage.setItem("sidebarVisible", String(sidebarVisible));
  }, [sidebarVisible]);

  useEffect(() => {
    localStorage.setItem("sidebarRightWidth", String(sidebarRightWidth));
  }, [sidebarRightWidth]);

  useEffect(() => {
    localStorage.setItem("sidebarRightVisible", String(rightSidebarVisible));
  }, [rightSidebarVisible]);

  // Lets focusSidebarTab (driven by sidebar.focusExplorer and every
  // extension panel's own focusBinding command) reveal a hidden sidebar, or
  // hide it again when re-pressed on the already-active tab. A ref keeps
  // isVisible() fresh for the mount-once-registered handler, matching
  // useGlobalKeybindings' bindingsRef freshness pattern.
  const sidebarVisibleRef = useRef(sidebarVisible);
  useEffect(() => {
    sidebarVisibleRef.current = sidebarVisible;
  }, [sidebarVisible]);

  // Keep the app exactly as tall as the visible viewport. dvh plus the
  // interactive-widget meta should do this alone, but on Android they
  // don't dependably shrink when the on-screen keyboard opens (notably in
  // installed PWAs) — the app then paints taller than the screen: prompt
  // and touch key bar behind the keyboard until something else forces a
  // re-layout. visualViewport is authoritative everywhere, so mirror its
  // height into --app-height (consumed by .app) and undo any pan the
  // browser applied to reveal the focused field — this is a fixed layout
  // that must stay pinned at 0,0.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      // height × scale recovers the layout-viewport height, so a
      // pinch-zoom leaves the app alone while the keyboard/URL-bar case
      // (scale 1) tracks the visible height exactly. No scale bail-out: a
      // device stuck at a not-quite-1 scale would otherwise never get the
      // variable set at all.
      const h = Math.round(vv.height * vv.scale);
      document.documentElement.style.setProperty("--app-height", `${h}px`);
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    // Some browsers move the keyboard/orientation resize through window
    // resize without a matching visualViewport event — listen to both.
    window.addEventListener("resize", apply);
    // Android's keyboard-open focus-reveal scrolls the page through a plain
    // window scroll, sometimes with no visualViewport event at all — pin
    // straight back. Non-capture: element scrolls (terminal scrollback, the
    // sidebar) don't bubble to window, only real page scrolls land here.
    window.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);

  // Re-measure the split spacers when a page scroll settles: the corrective
  // scrollTo(0,0) above is a scroll-only change — it moves every spacer
  // without resizing anything, so the ResizeObservers in
  // getGroupContentSlotRef stay silent and the position:fixed content hosts
  // would keep coordinates cached against the scrolled page.
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        for (const measure of Object.values(groupContentMeasures.current)) measure();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // A fast horizontal flick anywhere toggles the sidebar on touch devices
  // (where the sidebar.toggle keybinding isn't reachable): left→right
  // opens, right→left closes. Deliberately a passive observer — slower
  // horizontal drags keep belonging to whatever they're over (terminal
  // hscroll, tree marquee, tab drag); the velocity gate is what separates
  // a flick from those. Capture phase so the decision still sees the
  // touchend the terminal swallows after one of its own scrolls.
  useEffect(() => {
    const MIN_DX_PX = 60;
    const MIN_VELOCITY_PX_PER_MS = 1;
    // Walk up from the touched node: if any ancestor can scroll horizontally
    // (tab bars, the sidebar tab strip, a terminal's hscroll), the flick
    // belongs to that element, not to the sidebar toggle.
    const startsInHorizontalScroller = (target: EventTarget | null): boolean => {
      let el = target instanceof Element ? target : null;
      while (el && el !== document.body) {
        if (el.scrollWidth > el.clientWidth) {
          const overflowX = getComputedStyle(el).overflowX;
          if (overflowX === "auto" || overflowX === "scroll") return true;
        }
        el = el.parentElement;
      }
      return false;
    };
    // Explicit opt-out for UI whose own gesture is a free horizontal drag
    // rather than a scroll, so the scroller walk above can't detect it —
    // notably the touch-keys extension's floating one-handed toggle, which
    // is dragged anywhere on screen with exactly the motion this gesture
    // watches for. Any element (core or extension) can carry the attribute;
    // extensions render their own DOM, and a document-level capture listener
    // can't be preempted from inside it.
    const optsOutOfSwipe = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest("[data-no-sidebar-swipe]") !== null;
    let start: { x: number; y: number; t: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      start =
        e.touches.length === 1 && !startsInHorizontalScroller(e.target) && !optsOutOfSwipe(e.target)
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now() }
          : null;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const g = start;
      start = null;
      // Only a clean single-finger gesture counts: no fingers left down,
      // exactly one lifted.
      if (!g || e.touches.length > 0 || e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - g.x;
      const dy = e.changedTouches[0].clientY - g.y;
      const dt = Math.max(1, performance.now() - g.t);
      if (Math.abs(dx) < MIN_DX_PX) return;
      if (Math.abs(dx) < Math.abs(dy) * 2) return;
      if (Math.abs(dx) / dt < MIN_VELOCITY_PX_PER_MS) return;
      // Left→right: show the left sidebar, or close the right drawer if
      // that's what's open. Right→left is the mirror image, and only opens
      // the right drawer when it has tabs to show.
      if (dx > 0) {
        if (rightSidebarVisibleRef.current && rightHasTabsRef.current) {
          setSidebarSideVisible("right", false);
        } else if (!sidebarVisibleRef.current) setSidebarSideVisible("left", true);
      } else if (dx < 0) {
        if (sidebarVisibleRef.current) setSidebarSideVisible("left", false);
        else if (rightHasTabsRef.current && !rightSidebarVisibleRef.current) {
          setSidebarSideVisible("right", true);
        }
      }
    };
    const onTouchCancel = () => {
      start = null;
    };
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    document.addEventListener("touchcancel", onTouchCancel, true);
    return () => {
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchend", onTouchEnd, true);
      document.removeEventListener("touchcancel", onTouchCancel, true);
    };
  }, []);

  // Whether the right sidebar has anything to show — the flick gesture must
  // not open an empty drawer.
  const rightHasTabsRef = useRef(false);
  const rightSidebarVisibleRef = useRef(rightSidebarVisible);
  useEffect(() => {
    rightSidebarVisibleRef.current = rightSidebarVisible;
  }, [rightSidebarVisible]);

  // Both sides' visibility as one value for useSidebarLayout, which passes
  // it through to extensions.ts's layout bridge (so "reveal Source Control"
  // can un-hide whichever sidebar now holds it).
  const sidebarVisibility = useMemo(
    () => ({ left: sidebarVisible, right: rightSidebarVisible }),
    [sidebarVisible, rightSidebarVisible],
  );
  // Drawer mode: the sidebars float over the terminal instead of sharing
  // its width (styles.css's coarse-pointer block).
  const isMobileDrawer = () => window.matchMedia("(pointer: coarse) and (hover: none)").matches;
  const setSidebarSideVisible = useCallback((side: SidebarSide, visible: boolean) => {
    if (side === "left") {
      setSidebarVisible(visible);
      // On a phone both sidebars are drawers over the terminal, so two open
      // at once would overlap each other. Opening one closes the other —
      // on a desktop they share the width and both can stay open.
      if (visible && isMobileDrawer()) setRightSidebarVisible(false);
    } else {
      setRightSidebarVisible(visible);
      if (visible && isMobileDrawer()) setSidebarVisible(false);
    }
  }, []);

  // Extension-registered commands/viewers/panels (extensions.ts) — commands
  // join the built-in list inside useSettingsSync (always "global" scope in
  // v1, namespaced ext.<extensionId>.<cmd> so they can't collide with a
  // built-in id); fileViewers/sidebarPanels are consumed further down.
  const {
    commands: extCommands,
    fileViewers: extFileViewers,
    sidebarPanels: extSidebarPanels,
    sidebarTabs: extSidebarTabs,
    sidebarTabMenuItems: extSidebarTabMenuItems,
    extensionsSettled,
    windowActions: extWindowActions,
    appOverlays: extAppOverlays,
  } = useExtensionRegistry();

  // Real phone/tablet detection for app-global overlays (registerAppOverlay),
  // the same MQ TerminalView uses for its per-terminal accessories — an
  // overlay's "auto" visibility means touch devices only.
  const [mobilePointer, setMobilePointer] = useState(
    () => window.matchMedia("(pointer: coarse) and (hover: none)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse) and (hover: none)");
    const onChange = () => setMobilePointer(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // The bottom-anchored positioning context app overlays render into (see the
  // .app-overlay-layer in the editor area below).
  const overlayLayerRef = useRef<HTMLDivElement | null>(null);
  const appOverlayContext = useMemo(
    () => ({ mobilePointer, containerRef: overlayLayerRef }),
    [mobilePointer],
  );

  const {
    settings,
    setSettings,
    settingsRef,
    keybindingOverrides,
    setKeybindingOverrides,
    resolvedBindings,
    bindingsRef,
    overridesRef,
    extensionSettings,
    setExtensionSettings,
    extensionSettingsRef,
    projects,
    setProjects,
    commandUsage,
    setCommandUsage,
    extensionRegistries,
    setExtensionRegistries,
    sidebarLayout: syncedSidebarLayout,
    setSidebarLayout: setSyncedSidebarLayout,
    statusBarLayout: syncedStatusBarLayout,
    setStatusBarLayout: setSyncedStatusBarLayout,
    sidebarPanels: syncedSidebarPanels,
    setSidebarPanels: setSyncedSidebarPanels,
  } = useSettingsSync(extCommands);

  // Both sidebars' tabs, their per-side order, and which tab each section
  // calls home — one owner for both sides (see useSidebarLayout). Also
  // registers the layout bridge extensions.ts's reveal/focus helpers use.
  const {
    layout: sidebarLayout,
    view: sidebarView,
    panelState: sidebarPanelState,
    setPanelState: setSidebarPanelState,
    panelsById: sidebarPanelsById,
    env: sidebarTabEnv,
    selectTab: selectSidebarTabById,
    moveTab: moveSidebarTab,
    reorderTab: reorderSidebarTab,
    movePanel: moveSidebarPanel,
    togglePanel: toggleSidebarPane,
    tabDrag: sidebarTabDrag,
    setTabDrag: setSidebarTabDrag,
  } = useSidebarLayout(
    extSidebarPanels,
    extSidebarTabs,
    extensionsSettled,
    syncedSidebarLayout,
    setSyncedSidebarLayout,
    syncedSidebarPanels,
    setSyncedSidebarPanels,
    sidebarVisibility,
    setSidebarSideVisible,
  );

  useEffect(() => {
    rightHasTabsRef.current = sidebarView.right.tabs.length > 0;
  }, [sidebarView.right.tabs.length]);

  // What rendering consumers see (TerminalView, useThemeAssets, extension
  // viewers): on a real phone/tablet with fontSizeMobile set (≥ 8, the
  // smallest real size — 0 means "follow fontSize"), fontSize is swapped
  // for it. The raw `settings` keeps flowing to SettingsView and
  // useSettingsSync — persistence and the Settings UI must see the stored
  // values, or saving would clobber fontSize with the mobile value.
  const effectiveSettings = useMemo(
    () =>
      mobilePointer && settings.fontSizeMobile >= 8
        ? { ...settings, fontSize: settings.fontSizeMobile }
        : settings,
    [settings, mobilePointer],
  );

  // Backs ctx.settings.set — extensions write their own configuration
  // values into the same server-synced store the Settings UI edits.
  useEffect(() => {
    setExtensionSettingUpdater((extId, key, value) => {
      setExtensionSettings((prev) => ({
        ...prev,
        [extId]: { ...prev[extId], [key]: value },
      }));
    });
    return () => setExtensionSettingUpdater(null);
  }, [setExtensionSettings]);

  const { extensions, reloadExtensions, activeTerminalTheme, fontsVersion } =
    useThemeAssets(effectiveSettings, extensionSettings, extensionSettingsRef);

  // The status bar's arrangement and which of its widgets the user switched
  // off. Owned here, not in StatusBar: the gear menu's Status Bar list has to
  // be buildable even with the bar itself turned off in Settings, when that
  // component isn't mounted.
  const {
    layout: statusBarLayout,
    setLayout: setStatusBarLayout,
    visibleSlots: statusBarSlots,
    menuItems: statusBarMenuItems,
  } = useStatusBarLayout({
    extensions,
    extensionSettings,
    setExtensionSettings,
    mobilePointer,
    syncedLayout: syncedStatusBarLayout,
    onLayoutChange: setSyncedStatusBarLayout,
  });

  // Extension registry catalog (server/src/registry.ts) — fetched lazily on
  // the Extensions sidebar tab's first activation (see ensureRegistryLoaded)
  // rather than eagerly here, so a session that never opens that tab never
  // pays for it. Lives at this App level (not inside ExtensionsPanel) so the
  // extension detail-page tab below can read the same fetched catalog
  // without a second, redundant request for the same data.
  const [registryCatalog, setRegistryCatalog] = useState<RegistrySourceResult[]>([]);
  const [registryLoading, setRegistryLoading] = useState(false);
  const registryFetchedRef = useRef(false);

  // The app's built-in default registry (server EXTENSION_REGISTRY env, else
  // the shipped GitHub Pages catalog), fetched once. It's never persisted into
  // extensionRegistries — merged ahead of the user's own sources below — so an
  // env change always takes effect and "Reset Settings" can't strip it.
  const [defaultRegistry, setDefaultRegistry] = useState<string | null>(null);
  useEffect(() => {
    api.fetchDefaultRegistry().then(setDefaultRegistry).catch(() => {});
  }, []);

  // The user's configured registries with the default prepended (deduped) —
  // the effective source list the catalog is fetched against and filtered by.
  // setExtensionRegistries still persists only the user list, never the
  // default (the server adds the default back on its own, see registry.ts).
  const effectiveRegistries = useMemo(
    () =>
      defaultRegistry && !extensionRegistries.includes(defaultRegistry)
        ? [defaultRegistry, ...extensionRegistries]
        : extensionRegistries,
    [defaultRegistry, extensionRegistries],
  );

  // `sourcesOverride` lets a just-added/removed registry source refresh
  // immediately against the list being persisted, not extensionRegistries'
  // current (pre-edit) closure value — see ExtensionsPanel's addRegistry and
  // api.fetchRegistry's doc comment.
  const refreshRegistry = useCallback((refresh: boolean, sourcesOverride?: string[]) => {
    setRegistryLoading(true);
    api
      .fetchRegistry(refresh, sourcesOverride ?? effectiveRegistries)
      .then((sources) => {
        setRegistryCatalog(sources);
        registryFetchedRef.current = true;
      })
      .catch(() => {})
      .finally(() => setRegistryLoading(false));
  }, [effectiveRegistries]);

  const ensureRegistryLoaded = useCallback(() => {
    if (registryFetchedRef.current) return;
    refreshRegistry(false);
  }, [refreshRegistry]);

  // Available-updates count (registry version > installed version) — the
  // Extensions tab's badge, visible even before that tab is ever opened this
  // session as long as registryCatalog has already been fetched. Scoped to
  // extensionRegistries' current membership so a just-removed source's
  // still-cached catalog entries (stale until the next refetch) can't keep
  // counting toward the badge — mirrors ExtensionsPanel's liveRegistryCatalog.
  const extensionUpdatesCount = useMemo(() => {
    let count = 0;
    for (const src of registryCatalog) {
      if (!effectiveRegistries.includes(src.source)) continue;
      for (const entry of src.entries) {
        const installed = extensions.find((e) => e.id === entry.id);
        if (installed && compareVersions(entry.version, installed.version) > 0) count++;
      }
    }
    return count;
  }, [registryCatalog, extensions, effectiveRegistries]);

  // The extension detail page's "Extension Settings" shortcut — see
  // SettingsView's pendingFocusExtensionId prop doc.
  const [pendingFocusExtensionId, setPendingFocusExtensionId] = useState<string | null>(null);

  const { dialog, confirmDialog, promptDialog, pickDialog } = useDialogs();
  // Lets extensions use the same dialogs (ctx.app.confirmDialog & co.).
  useEffect(() => {
    setDialogHandlers({ confirm: confirmDialog, prompt: promptDialog, pick: pickDialog });
    return () => setDialogHandlers(null);
  }, [confirmDialog, promptDialog, pickDialog]);

  // Any editor-side activation — a tab opened from the sidebar/palette, a tab
  // bar click, a group-focus chord — hands keyboard focus back to the editor,
  // even when the bottom panel currently holds it. A pointer-down straight
  // into an editor pane is already covered by the content hosts' own handler;
  // this catches every path that activates a tab *without* clicking into it,
  // which would otherwise open a terminal in the editor while the user's
  // keystrokes kept going to the panel (caught live in QA, not by inspection).
  // Nothing on the panel side touches activeTabId/activeGroupId, so a change
  // here is always editor-driven.
  const editorSelectionRef = useRef<string | null>(null);

  const {
    tabs,
    setTabs,
    tabsRef,
    activeTabId,
    setActiveTabId,
    activeTabIdRef,
    lastRealTabIdRef,
    mruTabIdsRef,
    dirtyTabsRef,
    insertTab,
    openSession,
    openExtViewerTab,
    closeExtViewerTab,
    openSettingsTab,
    openKeyboardShortcutsTab,
    openExtensionPageTab,
    openWindowTab,
    openAllWindows,
    closeTab,
    cycleTab,
    moveTab,
    closeOtherTabs,
    reopenClosedTab,
    activeTab,
    activeRealTab,
    activeSession,
    activeWindow,
    filesRootDir,
    tabLabel,
    tabActivity,
    projectLabelForSession,
    projectKeyForSession,
    openSwitchedSession,
    activeGroupTabs,
    splitTree,
    activeGroupId,
    groupActive,
    focusGroup,
    resizeBranch,
    splitGroup,
    moveTabToGroup,
    moveTabToAdjacentGroup,
    splitGroupAndMoveTab,
  } = useTabs(
    sessions,
    sessionsLoadedRef,
    showError,
    confirmDialog,
    settingsRef,
    extFileViewers,
    extensions,
    registryCatalog,
  );

  // Back/forward over the tabs you've been in — the sidebar footer's two
  // arrows. setActiveTabId resolves a tab's editor group from the tab
  // itself, so navigating also brings the right split pane forward.
  const { canGoBack, canGoForward, goBack, goForward } = useNavigationHistory(
    activeTabId,
    setActiveTabId,
    tabsRef,
  );

  // FILES-tree root mode (the panel header's switch): "project" roots the
  // tree (and quick-switcher file search) at the active project's fixed
  // folder so `cd` can't drag it elsewhere; "cwd" follows the active
  // terminal's live directory instead. Device-local view preference, like
  // the sidebar panel layout.
  const [filesRootMode, setFilesRootMode] = useState<"project" | "cwd">(
    () => (localStorage.getItem("filesRootMode") === "cwd" ? "cwd" : "project"),
  );
  useEffect(() => {
    localStorage.setItem("filesRootMode", filesRootMode);
  }, [filesRootMode]);

  // Project mode: the active session's own folder (session_path); a session
  // with no reported path falls back to the git repo containing the active
  // terminal's cwd (then the cwd itself when it isn't a repo). Cwd mode:
  // the live cwd, verbatim. lazygit and the extension active-context keep
  // the raw cwd regardless.
  const gitRootFallback = useGitRootDir(
    filesRootMode === "project" && !activeSession?.path ? filesRootDir : null,
  );
  const resolvedFilesRootDir =
    filesRootMode === "cwd"
      ? filesRootDir
      : activeSession?.path
        ? activeSession.path
        : gitRootFallback;

  // Extension window-action buttons for a group's own active tab, rendered
  // in that group's tab bar (see TabBar.tsx's extras slot) — the tab-bar
  // counterpart to the SESSIONS-row icon (Sidebar.tsx), reusing the exact
  // same isVisible(ctx)/onClick(ctx) registration, just gated on
  // showInTabBar and evaluated against whichever window the group's active
  // tab currently points at instead of a row. A whole-session tab (no
  // windowIndex) resolves to that session's active window, mirroring
  // useTabs' own activeWindow fallback. Plain per-render computation, not
  // memoized against a ref — cheap (a handful of tabs/windows), and unlike
  // getGroupActionsRef above this returns nodes, not a DOM ref callback, so
  // there's no re-render-loop risk from a fresh closure identity.
  const tabExtrasFor = useCallback(
    (groupId: string): React.ReactNode => {
      if (extWindowActions.length === 0) return null;
      const activeId = groupActive[groupId];
      const tab = activeId ? tabs.find((t) => t.id === activeId) : undefined;
      if (!tab || !isRealTab(tab)) return null;
      const session = sessions.find((s) => s.name === tab.sessionName);
      if (!session) return null;
      const window =
        tab.windowIndex !== undefined
          ? session.windows.find((w) => w.index === tab.windowIndex)
          : session.windows.find((w) => w.active);
      if (!window) return null;
      const ctx = { sessionName: session.name, windowIndex: window.index, cwd: window.cwd, command: window.command };
      const actions = extWindowActions.filter((a) => a.showInTabBar && a.isVisible(ctx));
      if (actions.length === 0) return null;
      return (
        <>
          {actions.map((action) => (
            <button
              key={action.id}
              className="tab-bar-window-action"
              title={action.title}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick(ctx);
              }}
            >
              <Icon name={resolveWindowActionIcon(action, ctx)} />
            </button>
          ))}
        </>
      );
    },
    [extWindowActions, groupActive, tabs, sessions],
  );

  // A merged-away editor group's DOM node unmounting already disconnects its
  // ResizeObserver and nulls its rect (getGroupContentSlotRef's ref callback
  // above), but the callback closure itself and the null rect entry are never
  // removed — without this, groupContentSlotRefCallbacks/groupContentRects
  // grow by one dead entry per group id ever created for the page's
  // lifetime. Deletes only ids no longer in the live tree, so surviving
  // groups' ref-callback identities stay stable (required — see
  // getGroupContentSlotRef's comment on the re-render loop that an unstable
  // identity would cause).
  useEffect(() => {
    const live = new Set(leaves(splitTree));
    for (const groupId of Object.keys(groupContentSlotRefCallbacks.current)) {
      if (live.has(groupId)) continue;
      groupContentObservers.current[groupId]?.disconnect();
      delete groupContentObservers.current[groupId];
      delete groupContentSlotRefCallbacks.current[groupId];
    }
    setGroupContentRects((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [groupId, rect] of Object.entries(prev)) {
        if (live.has(groupId)) next[groupId] = rect;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [splitTree]);

  const {
    openPreviewViewerTab,
    isPreviewable,
    fileHoverAction,
    openFileInEditor,
    openFileOrViewer,
    openFileOrViewerSecondary,
  } = useFileOpeners(
    activeRealTab,
    extFileViewers,
    showError,
    refresh,
    openWindowTab,
    setActiveTabId,
    openExtViewerTab,
    closeExtViewerTab,
    setFilesRefreshKey,
    settings.editor,
  );

  // Group key/label with the project resolver baked in — one chip per
  // project folder (see plans/project-first-ui.md); a pathless session's
  // key is its own name, so its chip label passes through unchanged.
  const tabGroupKey = useCallback(
    (tab: Tab) => groupKeyForTab(tab, projectKeyForSession),
    [projectKeyForSession],
  );
  const groupLabelForKey = useCallback(
    (key: string) => (isAbsolutePath(key) ? projectName(key) : key),
    [],
  );

  const { tabGroupState, toggleGroupCollapsed, closeGroupTabs, groupMenuItems, moveGroup } = useTabGroups(
    tabs,
    tabsRef,
    setTabs,
    activeTabId,
    setActiveTabId,
    mruTabIdsRef,
    dirtyTabsRef,
    sessions,
    sessionsLoadedRef,
    settingsRef,
    settings.tabGroupsBySession,
    confirmDialog,
    projectKeyForSession,
  );

  // The project the bottom panel is currently scoped to — same identity the
  // editor's own tab groups use (useTabs' projectKeyForSession), so a
  // project's panel tabs and its editor tab group agree on what counts as
  // "this project". null when there's no active editor tab at all (the panel
  // then shows nothing and relies on requestPanelTerminal's project picker).
  const activeProjectKey = activeRealTab ? projectKeyForSession(activeRealTab.sessionName) : null;

  // The bottom terminal panel (plans/bottom-terminal-panel.md) — its own state
  // model, separate from the editor's tabs/split tree, since it only ever
  // holds terminals and only ever splits side-by-side.
  const {
    panel,
    visibleTabs: panelVisibleTabs,
    activeTabId: panelActiveTabId,
    panelFocused,
    setPanelFocused,
    togglePanel,
    showPanel,
    hidePanel,
    setHeight: setPanelHeight,
    selectTab: selectPanelTab,
    selectPane: selectPanelPane,
    resizePanes: resizePanelPanes,
    newTerminal,
    attachWindow: attachPanelWindow,
    splitActivePane,
    closeTab: closePanelTab,
    removePane: removePanelPane,
  } = useBottomPanel(sessions, sessionsLoadedRef, showError, activeProjectKey, projectKeyForSession);

  // See editorSelectionRef's comment above. Skips its own first run, so the
  // panel keeps focus across a reload that restores it.
  useEffect(() => {
    const selection = `${activeGroupId}:${activeTabId ?? ""}`;
    if (editorSelectionRef.current === null) {
      editorSelectionRef.current = selection;
      return;
    }
    if (editorSelectionRef.current === selection) return;
    editorSelectionRef.current = selection;
    setPanelFocused(false);
  }, [activeGroupId, activeTabId, setPanelFocused]);

  // null = closed; otherwise the string to seed the switcher's input with —
  // "" for a plain tab/window/session switch, ">" for the command palette.
  const [switcherQuery, setSwitcherQuery] = useState<string | null>(null);

  // Right-click anywhere without a dedicated context menu (empty terminal
  // space, tab bar gaps, etc.) would otherwise show the browser's native
  // menu, which has no useful actions in this app.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Only the FILES panel is a real drop target; it calls preventDefault +
  // stopPropagation on valid drops, so this never runs for those. Without it,
  // a file dropped anywhere else (terminal, tab bar, sidebar top bar) hits no
  // handler at all and the browser falls back to its default action —
  // navigating the whole tab away to the dropped file.
  useEffect(() => {
    const blockStrayFileDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", blockStrayFileDrop);
    window.addEventListener("drop", blockStrayFileDrop);
    return () => {
      window.removeEventListener("dragover", blockStrayFileDrop);
      window.removeEventListener("drop", blockStrayFileDrop);
    };
  }, []);

  // One handler for both sidebars: the right one measures from the window's
  // right edge instead of its left.
  const startSidebarResize = useCallback((e: React.MouseEvent, side: SidebarSide) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const raw = side === "left" ? ev.clientX : window.innerWidth - ev.clientX;
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw));
      if (side === "left") setSidebarWidth(width);
      else setSidebarRightWidth(width);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const showMenu = useCallback((x: number, y: number, items: MenuItem[], sourceId?: string) => {
    setMenu({ x, y, items, sourceId });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  // Opens a panel terminal, resolving which session its new window goes
  // in: the active real tab's session when there is one, otherwise a picker at
  // `anchor` (the + button, or the panel's own top-left for the keyboard
  // command) — the panel never guesses a session on the user's behalf.
  const requestPanelTerminal = useCallback(
    (anchor: { x: number; y: number }) => {
      if (activeRealTab) {
        newTerminal(activeRealTab.sessionName);
        return;
      }
      // One entry per project (not per session): a merged project's entry
      // targets its primary session, same rule as everywhere else.
      const seen = new Set<string>();
      const projectItems: MenuItem[] = [];
      for (const s of sessions) {
        const key = projectKeyForSession(s.name);
        if (seen.has(key)) continue;
        seen.add(key);
        projectItems.push({ label: projectLabelForSession(s.name), onClick: () => newTerminal(s.name) });
      }
      const items: MenuItem[] = [
        ...projectItems,
        { label: "New Project…", onClick: () => setFolderPickerMode("panelTerminal") },
      ];
      showMenu(anchor.x, anchor.y, items);
    },
    [activeRealTab, sessions, newTerminal, projectLabelForSession, projectKeyForSession, showMenu],
  );

  // The panel's "Attach Window…" dropdown: every window not already
  // surfaced somewhere — open as an editor window-tab or attached as a panel
  // pane — offered for attaching as a new panel tab. Labels match the panel's
  // own tab labels (session:window-name).
  const requestPanelAttachWindow = useCallback(
    (anchor: { x: number; y: number }) => {
      const openKeys = new Set<string>();
      for (const t of tabs) {
        if (t.windowIndex !== undefined) openKeys.add(`${t.sessionName}:${t.windowIndex}`);
      }
      for (const t of panel.tabs) {
        for (const p of t.panes) openKeys.add(`${p.sessionName}:${p.windowIndex}`);
      }
      const items: MenuItem[] = [];
      for (const s of sessions) {
        for (const w of s.windows) {
          if (openKeys.has(`${s.name}:${w.index}`)) continue;
          items.push({
            label: `${s.name}:${w.name}`,
            onClick: () => attachPanelWindow(s.name, w.index),
          });
        }
      }
      if (items.length === 0) {
        items.push({ label: "No windows to attach", disabled: true, onClick: () => {} });
      }
      showMenu(anchor.x, anchor.y, items);
    },
    [tabs, panel.tabs, sessions, attachPanelWindow, showMenu],
  );

  const {
    closeProject,
    killSessionNow,
    createWindow,
    selectWindowInSession,
    renameWindow,
    killWindow,
    togglePinSession,
    openProject,
    projectMenuItems,
    worktreeMenuItems,
    createWorktreeSession,
    loadWorktreeBranches,
    openWorktree,
    newTerminalInProject,
    newTerminalInWorktree,
    cleanUpWorktrees,
    recentProjectMenuItems,
    windowMenuItems,
    tabMenuItems,
  } = useSessionActions(
    refresh,
    showError,
    confirmDialog,
    promptDialog,
    settingsRef,
    tabs,
    setTabs,
    sessions,
    openSession,
    openWindowTab,
    openAllWindows,
    closeTab,
    closeOtherTabs,
    projects,
    setProjects,
    splitGroup,
    moveTabToAdjacentGroup,
    resolvedFilesRootDir,
    repoIndex,
  );

  // Linked worktrees stopped being recorded as recent projects; this sweeps
  // out the ones recorded before that, as each repository's listing arrives.
  // Pins stay. withoutWorktreeRecents hands back the same array when there is
  // nothing to drop, so a quiet tick costs no re-render and no settings sync.
  useEffect(() => {
    setProjects((prev) => withoutWorktreeRecents(prev, repoIndex, settings.worktreeLocation));
  }, [repoIndex, setProjects, settings.worktreeLocation]);

  // `perch open` bridge (plans/cli-open-command.md): openProject is
  // only available past this point, so the SSE listener declared above
  // reaches it through this ref, refreshed every render.
  const { handleOpenTarget } = useOpenTarget(
    openProject,
    extFileViewers,
    openExtViewerTab,
    openWindowTab,
    refresh,
    showError,
    settings.editor,
  );
  openTargetRef.current = handleOpenTarget;

  // code-server-style deep links: `?folder=<path>` opens a project,
  // `?file=<path>[&line=N][&action=editor|preview]` opens a file — the
  // no-connected-client fallback `perch open` prints. Runs once, after
  // the first session list is in (openProject's live-session lookup needs
  // it to avoid a spurious duplicate create), then strips the params so a
  // reload/share of the URL can't re-fire the open.
  const deepLinkConsumedRef = useRef(false);
  useEffect(() => {
    if (deepLinkConsumedRef.current || !sessionsLoadedRef.current) return;
    const params = new URLSearchParams(location.search);
    const folder = params.get("folder");
    const file = params.get("file");
    if (!folder && !file) return;
    deepLinkConsumedRef.current = true;
    const lineParam = params.get("line");
    const line = lineParam && /^\d+$/.test(lineParam) ? Number(lineParam) : undefined;
    const actionParam = params.get("action");
    const action = actionParam === "editor" || actionParam === "preview" ? actionParam : undefined;
    (async () => {
      try {
        if (folder) {
          const listing = await api.listDir(folder);
          await handleOpenTarget({ kind: "dir", path: listing.path, projectCwd: listing.path });
        } else if (file) {
          const dirname = parentPath(file) ?? file;
          const gitRoot = await api.getGitRoot(dirname);
          await handleOpenTarget({ kind: "file", path: file, projectCwd: gitRoot.root, line, action });
        }
      } catch (err) {
        showError(err);
      }
    })();
    const url = new URL(location.href);
    for (const key of ["folder", "file", "line", "action"]) url.searchParams.delete(key);
    history.replaceState(null, "", url);
  }, [sessions, handleOpenTarget, showError]);

  // The bottom panel's "New Project…": ensure the picked folder's session
  // exists (created exactly there, named after it — same rules as
  // openProject), record it into recents, then attach a fresh panel
  // terminal to it. Unlike openProject this never opens an editor tab —
  // the pick came from the panel, so the panel is where the terminal goes.
  const openPanelTerminalInProject = useCallback(
    async (cwd: string) => {
      try {
        let target = sessions.find((s) => s.path === cwd)?.name;
        if (!target) {
          const created = await api.createSession(
            sessionNameForProject(cwd, sessions.map((s) => s.name)),
            cwd,
            true,
          );
          target = created.name;
          await refresh();
        }
        if (!isLinkedWorktreePath(repoIndex, cwd, settingsRef.current.worktreeLocation)) {
          setProjects((prev) => bumpRecent(prev, cwd));
        }
        newTerminal(target);
      } catch (err) {
        showError(err);
      }
    },
    [sessions, refresh, setProjects, newTerminal, showError, repoIndex, settingsRef],
  );

  // ctx.app.openSessionWindow / ctx.app.killSession (extensions.ts) — the
  // session-level counterparts of the openFileTab/openViewerTab bridges in
  // useFileOpeners. Both route through the same hooks the sidebar's own menu
  // items use, so an extension can't diverge from core's tab bookkeeping.
  useEffect(() => {
    setOpenSessionWindowHandler((sessionName, createCwd, windowIndex) => {
      void (async () => {
        // Queried fresh rather than read off `sessions`: an extension
        // typically calls this immediately after creating the worktree/dir
        // the session belongs to, and React state here can still predate the
        // most recent poll (same rationale as findActiveWindowIndex in
        // useSessionActions).
        let existing: TerminalSession | undefined;
        try {
          existing = (await api.fetchSessions()).find((s) => s.name === sessionName);
        } catch (err) {
          showError(err);
          return;
        }
        if (existing) {
          // A requested window that still exists wins over the active one.
          const requested =
            windowIndex !== undefined ? existing.windows.find((w) => w.index === windowIndex)?.index : undefined;
          const activeIndex = requested ?? existing.windows.find((w) => w.active)?.index;
          await refresh();
          if (activeIndex !== undefined) await openWindowTab(sessionName, activeIndex);
          return;
        }
        // create-at-cwd → refresh → open the new window as a tab. The
        // extension names the session itself (e.g. a worktree branch), so
        // this stays name-based — unlike openProject, whose sessions are
        // named after their folder.
        if (createCwd) {
          const created = await api.createSession(sessionName, createCwd);
          await refresh();
          const activeIndex = created.windows.find((w) => w.active)?.index;
          if (activeIndex !== undefined) await openWindowTab(created.name, activeIndex);
          return;
        }
        showError(new Error(`No session named "${sessionName}"`));
      })();
    });
    setKillSessionHandler((sessionName) => {
      void killSessionNow(sessionName);
    });
  }, [refresh, openWindowTab, killSessionNow, showError]);

  // Session-windows dropdown for a tab-group chip's arrow button. Scoped per
  // editor group (like groupMenuItems), since "checked" below means "already
  // open as a tab in this bar" — a window open only in a different split
  // pane shouldn't show as checked here, since clicking it here would still
  // open a fresh tab in this pane (see useTabs.ts's openWindowTab, whose own
  // dedupe is scoped the same way, to the focused editor group). Defined
  // after useSessionActions since the trailing "New Window" item reuses its
  // createWindow (which also opens the new window as a tab). Not to be
  // confused with useSessionActions' windowMenuItems, which builds a single
  // window row's right-click menu (rename/kill/etc.) in the sidebar.
  const chipWindowMenuItems = useCallback(
    (editorGroupId: string, chipKey: string): MenuItem[] => {
      // Every session mapping to this chip's group key — a merged project's
      // chip reaches all of its backing sessions' terminals; the first is
      // the primary (same rule as projectRows).
      const members = sessions.filter((s) => (s.path || s.name) === chipKey);
      const primary = members[0];
      const primaryWindows = primary?.windows ?? [];
      // Extension contributions (registerTabGroupMenuItem), appended to this
      // dropdown behind a separator. Read from the module-level registry at
      // menu-open time rather than captured in this callback's deps, and a
      // throwing isVisible hides only its own item — same contract as the
      // FILES-tree menu's contributions. sessionName/cwd come from the
      // primary session, keeping the extension-facing shape unchanged.
      const groupCtx = {
        sessionName: primary?.name ?? chipKey,
        cwd: (primaryWindows.find((w) => w.active) ?? primaryWindows[0])?.cwd ?? null,
      };
      const contributed: MenuItem[] = extensionTabGroupMenuItems
        .filter((item) => {
          try {
            return item.isVisible(groupCtx);
          } catch {
            return false;
          }
        })
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
        .map((item) => ({
          label: item.label,
          icon: item.icon,
          onClick: () => item.onClick(groupCtx),
        }));
      const withContributions = (items: MenuItem[]): MenuItem[] =>
        contributed.length > 0
          ? [...items, { label: "", separator: true, onClick: () => {} }, ...contributed]
          : items;
      const entries = members.flatMap((m) => m.windows.map((w) => ({ session: m, window: w })));
      if (entries.length === 0) {
        return withContributions([{ label: "No terminals", disabled: true, onClick: () => {} }]);
      }
      // A window-tab pins a specific index; a whole-session tab (no
      // windowIndex) instead shows whichever window the session currently has
      // active for its session — so it "opens" (and can be the "active *"
      // one for) that one. Open/active tracking is per (session, index)
      // since a merged chip spans sessions.
      const groupTabs = tabs.filter(
        (t) => t.groupId === editorGroupId && groupKeyForTab(t, projectKeyForSession) === chipKey,
      );
      const activeGroupTabId = groupActive[editorGroupId];
      const openKeys = new Set<string>();
      let activeKey: string | undefined;
      for (const t of groupTabs) {
        const member = members.find((m) => m.name === t.sessionName);
        const index = t.windowIndex ?? member?.windows.find((w) => w.active)?.index;
        if (index === undefined) continue;
        const k = `${t.sessionName}:${index}`;
        openKeys.add(k);
        if (t.id === activeGroupTabId) activeKey = k;
      }
      return withContributions([
        ...entries.map(({ session: m, window: w }) => ({
          label: `${w.name}${`${m.name}:${w.index}` === activeKey ? " *" : ""}`,
          checked: openKeys.has(`${m.name}:${w.index}`),
          onClick: () => openWindowTab(m.name, w.index),
        })),
        { separator: true, label: "", onClick: () => {} },
        { label: "New Terminal", icon: "add", onClick: () => createWindow(primary?.name ?? chipKey) },
      ]);
    },
    [sessions, tabs, groupActive, openWindowTab, createWindow, projectKeyForSession],
  );

  // Chrome-style "+" in a tab bar (TabBar.tsx's tab-new-btn) — creates a new
  // window in the clicked pane's own last-active session, falling back to
  // the app-global last-active session (activeSession, tracked via
  // lastRealTabIdRef) when the pane's active tab isn't a real session tab
  // (e.g. a settings/viewer tab), same resolution the FILES sidebar uses.
  const newWindowInGroup = useCallback(
    (editorGroupId: string) => {
      const activeGroupTabId = groupActive[editorGroupId];
      const activeGroupTab = tabs.find((t) => t.id === activeGroupTabId);
      const sessionName =
        (activeGroupTab && isRealTab(activeGroupTab) ? activeGroupTab.sessionName : undefined) ??
        activeSession?.name ??
        sessions[0]?.name;
      if (sessionName) createWindow(sessionName);
    },
    [groupActive, tabs, activeSession, sessions, createWindow],
  );

  // Session/window commands need an active real tab (a session/window, not a
  // settings/viewer tab) to act on; window.* additionally needs the derived
  // active window (see useTabs' activeWindow — falls back to the session's
  // own active window when the tab isn't pinned to one specific window).
  // Both the keyboard dispatcher (handlers below) and the palette (built
  // further down) share these same guards, so a bound chord fired with no
  // context and a palette row with no context behave identically: a no-op.
  const globalHandlers = useMemo<Record<string, () => void>>(
    () => ({
      "sidebar.toggle": () => setSidebarSideVisible("left", !sidebarVisibleRef.current),
      "sidebar.toggleRight": () => setSidebarSideVisible("right", !rightSidebarVisibleRef.current),
      "sidebar.focusExplorer": () => focusSidebarTab(EXPLORER_TAB_ID),
      "sidebar.focusRun": () => focusSidebarTab(RUN_TAB_ID),
      "sidebar.focusCommands": () => focusSidebarTab(COMMANDS_TAB_ID),
      "sidebar.focusExtensions": () => focusSidebarTab(EXTENSIONS_TAB_ID),
      "sidebar.focusProjects": () => focusProjectsPanel(),
      "quickSwitcher.toggle": () => setSwitcherQuery((q) => (q === null ? "" : null)),
      "commandPalette.toggle": () => setSwitcherQuery((q) => (q === null ? ">" : null)),
      "tab.next": () => cycleTab(1),
      "tab.previous": () => cycleTab(-1),
      "tab.close": () => {
        if (activeTabId) closeTab(activeTabId);
      },
      "tab.closeOthers": () => {
        if (activeTabId) closeOtherTabs(activeTabId);
      },
      "settings.open": openSettingsTab,
      "settings.openKeyboardShortcuts": openKeyboardShortcutsTab,
      "session.new": () => setFolderPickerMode("project"),
      "session.kill": () => {
        if (activeRealTab) closeProject(activeRealTab.sessionName);
      },
      "session.togglePin": () => {
        if (activeRealTab) togglePinSession(activeRealTab.sessionName);
      },
      "window.new": () => {
        if (activeRealTab) createWindow(activeRealTab.sessionName);
      },
      "window.kill": () => {
        if (activeRealTab && activeWindow) killWindow(activeRealTab.sessionName, activeWindow.index);
      },
      "window.rename": () => {
        if (activeRealTab && activeWindow) renameWindow(activeRealTab.sessionName, activeWindow);
      },
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `tab.focus${i + 1}`,
          () => {
            const t = activeGroupTabs[i];
            if (t) setActiveTabId(t.id);
          },
        ]),
      ),
      "tab.moveLeft": () => {
        if (!activeTabId) return;
        // moveTab's toIndex is relative to the dragged tab's own editor
        // group, not the flat tabs array — see useTabs.ts's moveTab.
        const idx = activeGroupTabs.findIndex((t) => t.id === activeTabId);
        if (idx > 0) moveTab(activeTabId, idx - 1);
      },
      "tab.moveRight": () => {
        if (!activeTabId) return;
        const idx = activeGroupTabs.findIndex((t) => t.id === activeTabId);
        if (idx !== -1 && idx < activeGroupTabs.length - 1) moveTab(activeTabId, idx + 1);
      },
      "tab.reopenClosed": reopenClosedTab,
      // On a real phone/tablet with the mobile override active, these adjust
      // fontSizeMobile — the size actually on screen there (effectiveSettings
      // above) — instead of invisibly changing the desktop value. The MQ is
      // evaluated inline rather than closing over mobilePointer so a
      // memoized handler map can't hold a stale device class.
      "terminal.fontSizeIncrease": () => {
        setSettings((prev) =>
          window.matchMedia("(pointer: coarse) and (hover: none)").matches && prev.fontSizeMobile >= 8
            ? { ...prev, fontSizeMobile: Math.min(32, prev.fontSizeMobile + 1) }
            : { ...prev, fontSize: Math.min(32, prev.fontSize + 1) },
        );
      },
      "terminal.fontSizeDecrease": () => {
        setSettings((prev) =>
          window.matchMedia("(pointer: coarse) and (hover: none)").matches && prev.fontSizeMobile >= 8
            ? { ...prev, fontSizeMobile: Math.max(8, prev.fontSizeMobile - 1) }
            : { ...prev, fontSize: Math.max(8, prev.fontSize - 1) },
        );
      },
      "terminal.fontSizeReset": () => {
        // Reset on mobile clears the override (back to following fontSize)
        // rather than resetting the desktop value.
        setSettings((prev) =>
          window.matchMedia("(pointer: coarse) and (hover: none)").matches && prev.fontSizeMobile >= 8
            ? { ...prev, fontSizeMobile: 0 }
            : { ...prev, fontSize: DEFAULT_SETTINGS.fontSize },
        );
      },
      "split.right": () => splitGroup("right"),
      "split.down": () => splitGroup("down"),
      "split.left": () => splitGroup("left"),
      "split.up": () => splitGroup("up"),
      "group.focusNext": () => {
        const order = leaves(splitTree);
        const idx = order.indexOf(activeGroupId);
        if (idx === -1 || order.length < 2) return;
        focusGroup(order[(idx + 1) % order.length]);
      },
      "group.focusPrevious": () => {
        const order = leaves(splitTree);
        const idx = order.indexOf(activeGroupId);
        if (idx === -1 || order.length < 2) return;
        focusGroup(order[(idx - 1 + order.length) % order.length]);
      },
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          `group.focus${i + 1}`,
          () => {
            const groupId = leaves(splitTree)[i];
            if (groupId) focusGroup(groupId);
          },
        ]),
      ),
      "tab.moveToNextGroup": () => {
        if (!activeTabId) return;
        moveTabToAdjacentGroup(activeTabId, "next");
      },
      "tab.moveToPreviousGroup": () => {
        if (!activeTabId) return;
        moveTabToAdjacentGroup(activeTabId, "previous");
      },
      "panel.toggle": togglePanel,
      "panel.new": () => {
        // Reveals first, so the picker (when there's no active session) has a
        // panel to anchor against — its own top-left corner, since the +
        // button it would otherwise anchor to may not be on screen yet.
        showPanel();
        requestPanelTerminal({ x: sidebarVisible ? sidebarWidth : 0, y: window.innerHeight - panel.height });
      },
      "panel.split": splitActivePane,
    }),
    [
      activeRealTab,
      activeWindow,
      activeTabId,
      activeGroupTabs,
      activeGroupId,
      splitTree,
      setActiveTabId,
      moveTab,
      reopenClosedTab,
      setSettings,
      closeTab,
      closeOtherTabs,
      cycleTab,
      openSettingsTab,
      openKeyboardShortcutsTab,
      closeProject,
      togglePinSession,
      createWindow,
      killWindow,
      renameWindow,
      splitGroup,
      focusGroup,
      moveTabToAdjacentGroup,
      togglePanel,
      showPanel,
      splitActivePane,
      requestPanelTerminal,
      panel.height,
      sidebarVisible,
      sidebarWidth,
    ],
  );

  // Mirrors this component's own state into the module-level context-key
  // store (contextKeys.ts) so when-clause bindings can read it from the
  // dispatchers below, which live outside React (mount-once listeners).
  useEffect(() => {
    setContextKey("sidebarVisible", sidebarVisible);
  }, [sidebarVisible]);
  useEffect(() => {
    setContextKey("rightSidebarVisible", rightSidebarVisible);
  }, [rightSidebarVisible]);
  useEffect(() => {
    setContextKey("panelFocus", panelFocused);
  }, [panelFocused]);
  useEffect(() => {
    setContextKey("quickSwitcherOpen", switcherQuery !== null);
    // Only the switcher's initial mode is tracked — typing/deleting the ">"
    // prefix inside an already-open switcher doesn't update this, since the
    // live query isn't lifted up to App.
    setContextKey("commandPaletteOpen", switcherQuery?.startsWith(">") ?? false);
  }, [switcherQuery]);
  useEffect(() => {
    setContextKey("activeSession", activeRealTab !== null);
  }, [activeRealTab]);
  useEffect(() => {
    setContextKey("activeWindow", activeWindow !== undefined);
  }, [activeWindow]);

  useGlobalKeybindings(bindingsRef, overridesRef, globalHandlers, extCommands);

  // Bridges ctx.app.executeCommand/getCommands (extensions.ts) to the same
  // globalHandlers + extension-command map the keyboard dispatcher runs, so an
  // extension can invoke or list commands. Only ids present in globalHandlers
  // (the runnable global subset) plus extension commands are exposed —
  // terminal/files/sessions-scoped ids aren't dispatchable this way.
  useEffect(() => {
    setExecuteCommandHandler((id) => {
      const fn = globalHandlers[id] ?? extCommands.find((c) => c.id === id)?.run;
      fn?.();
    });
    setGetCommandsHandler(() => {
      const labels = new Map(COMMANDS.map((c) => [c.id, c.label]));
      return [
        ...Object.keys(globalHandlers).map((id) => ({ id, label: labels.get(id) ?? id })),
        ...extCommands.map((c) => ({ id: c.id, label: c.label })),
      ];
    });
    return () => {
      setExecuteCommandHandler(null);
      setGetCommandsHandler(null);
    };
  }, [globalHandlers, extCommands]);

  // Formatted "sidebar.toggle" binding for the collapsed sidebar's reopen
  // strip's tooltip (below) — Sidebar.tsx formats its own copy of this same
  // binding for the button shown while expanded.
  const sidebarToggleBinding = formatBinding(resolvedBindings["sidebar.toggle"]?.[0]?.key ?? "");
  const rightSidebarToggleBinding = formatBinding(
    resolvedBindings["sidebar.toggleRight"]?.[0]?.key ?? "",
  );

  // Bumps commandUsage[id] on every palette-invoked run (not chord
  // dispatches — see paletteCommands' comment on recording scope). Read by
  // the memo below for the always-on "pin last-used to row 1" behavior and
  // the opt-in paletteSortByUsage sort.
  const recordCommandUsage = useCallback(
    (id: string) => {
      setCommandUsage((prev) => ({
        ...prev,
        [id]: { count: (prev[id]?.count ?? 0) + 1, last: Date.now() },
      }));
    },
    [setCommandUsage],
  );

  // Palette entries mirror globalHandlers 1:1 for the built-in commands, plus
  // extension commands — terminal.* is excluded since those are dispatched
  // from the terminal's own key handler (see useGlobalKeybindings' module comment)
  // and make no sense invoked from an overlay that has stolen focus.
  // quickSwitcher.selectNext/Previous are excluded for the same reason: they
  // only mean anything as a keypress while the switcher's own input owns
  // focus (QuickSwitcher compares its `bindings` prop directly — see its
  // onKeyDown), so "running" them from the list they navigate would be a
  // no-op with no globalHandlers entry to back it.
  //
  // Ordering: only palette-invoked runs are recorded (a chord-run favorite
  // shouldn't crowd out what you actually pick from the list), so usage
  // reflects palette habits specifically. The single most-recently-run
  // command always pins to row 0 — ties on `last` (only possible via a
  // hand-edited settings doc) break by higher `count`, then static order.
  // paletteSortByUsage additionally reorders everything else by `count` desc
  // (stable, so ties keep the static COMMANDS order).
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const hasSession = activeRealTab !== null;
    const hasWindow = activeWindow !== undefined;
    // Render-fresh for activeSession/activeWindow: the context-key store's
    // mirroring effects run after render, so reading it for these two here
    // would be one render stale right when it matters most (opening the
    // palette immediately after creating/killing a session or window).
    // Everything else falls through to the store.
    const storeGet = getContextGetter();
    const paletteGet = (key: string) => {
      if (key === "activeSession") return hasSession;
      if (key === "activeWindow") return hasWindow;
      return storeGet(key);
    };
    const builtins = COMMANDS.filter((c) => c.scope === "global" && !NON_PALETTE_IDS.has(c.id)).map((c) => ({
      id: c.id,
      label: c.label,
      binding: formatBinding(resolvedBindings[c.id]?.[0]?.key ?? ""),
      enabled: c.enablement ? evaluateWhen(c.enablement, paletteGet) : true,
      run: () => {
        recordCommandUsage(c.id);
        globalHandlers[c.id]?.();
      },
    }));
    const extEntries = extCommands.map((c) => ({
      id: c.id,
      label: c.label,
      binding: formatBinding(resolvedBindings[c.id]?.[0]?.key ?? ""),
      enabled: true,
      run: () => {
        recordCommandUsage(c.id);
        c.run();
      },
    }));
    const all = [...builtins, ...extEntries];

    const sorted = settings.paletteSortByUsage
      ? [...all].sort((a, b) => (commandUsage[b.id]?.count ?? 0) - (commandUsage[a.id]?.count ?? 0))
      : all;

    let lastUsedIndex = -1;
    for (let i = 0; i < sorted.length; i++) {
      const usage = commandUsage[sorted[i].id];
      if (!usage) continue;
      if (lastUsedIndex === -1) {
        lastUsedIndex = i;
        continue;
      }
      const best = commandUsage[sorted[lastUsedIndex].id];
      if (
        usage.last > best.last ||
        (usage.last === best.last && usage.count > best.count)
      ) {
        lastUsedIndex = i;
      }
    }
    if (lastUsedIndex <= 0) return sorted;
    const lastUsed = sorted[lastUsedIndex];
    return [lastUsed, ...sorted.slice(0, lastUsedIndex), ...sorted.slice(lastUsedIndex + 1)];
  }, [
    activeRealTab,
    activeWindow,
    resolvedBindings,
    globalHandlers,
    extCommands,
    commandUsage,
    settings.paletteSortByUsage,
    recordCommandUsage,
  ]);

  // Branch pill in the FILES panel header: find-or-create the active
  // session's lazygit window (started in the file tree's root when created)
  // and bring it up as a window tab.
  const openLazygit = async () => {
    if (!activeRealTab) return;
    try {
      const { index } = await api.openLazygit(activeRealTab.sessionName, filesRootDir ?? undefined);
      // Refresh before opening the tab: the vanished-window sweep below
      // closes any window-tab whose window isn't in `sessions` yet, and a
      // just-created lazygit window won't be until the next poll otherwise.
      await refresh();
      await openWindowTab(activeRealTab.sessionName, index);
    } catch (err) {
      showError(err);
    }
  };

  const {
    uploadProgress,
    prunePath,
    fsClipboard,
    handleUpload,
    handleFileTreeDrop,
    fileTreeRootMenuItems,
    fileMenuItems,
    fileMultiMenuItems,
    deleteFileEntry,
    deleteFileEntries,
    renameFileEntry,
    findInFolder,
    createFileInDir,
    createFolderInDir,
    copyFilePaths,
    copyFileRelativePaths,
    copyEntries,
    cutEntries,
    pasteIntoDir,
    clearClipboard,
    refreshClipboardMirror,
    transferEntries,
  } = useFileActions(
    showError,
    confirmDialog,
    promptDialog,
    settingsRef,
    setFilesRefreshKey,
    extFileViewers,
    openFileInEditor,
    openPreviewViewerTab,
  );
  refreshClipboardMirrorRef.current = refreshClipboardMirror;
  const cutPaths = fsClipboard?.mode === "cut" ? new Set(fsClipboard.paths) : null;

  const windowTitle = activeTab ? `${tabLabel(activeTab)} - ${APP_NAME}` : APP_NAME;
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);

  // The installed app's own title bar, once its browser title bar is hidden
  // (plans/pwa-custom-title-bar.md). Never on a phone: the overlay is a
  // desktop-only browser feature, and the check keeps emulation honest.
  const windowControlsOverlay = useWindowControlsOverlay();
  const showTitleBar = windowControlsOverlay.visible && settings.customTitleBar && !mobilePointer;

  // The Manage menu, shared by the sidebar's gear button and (on a phone,
  // where that button is behind a closed drawer) the status bar's own. Built
  // here rather than in Sidebar because it spans the whole app: the palette,
  // the three full-tab views, both sidebars, every pane, and the theme.
  const manageMenuItems = useCallback((): MenuItem[] => {
    // A pane's stable name — the FILES header doubles as a breadcrumb and
    // reads out a whole path, which is no way to name a checkbox.
    const paneName = (id: string): string => {
      if (id === "projects") return "Projects";
      if (id === "files") return "Explorer";
      return extSidebarPanels.find((p) => p.id === id)?.title ?? id;
    };
    const paneItems: MenuItem[] = [...sidebarPanelsById.values()]
      .map((panel) => ({
        label: paneName(panel.id),
        // Tracks the user's own setting, not effective visibility: a pane an
        // extension is hiding for context would otherwise show an unchecked
        // box whose toggle appears to do nothing.
        checked: !sidebarLayout.hiddenPanels.includes(panel.id),
        onClick: () => toggleSidebarPane(panel.id),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const themeItems: MenuItem[] = listColorThemeOptions(extensions).map((opt) => ({
      label: opt.label,
      checked: settings.colorTheme === opt.value,
      onClick: () => setSettings((prev) => ({ ...prev, colorTheme: opt.value })),
    }));
    const sidebarItems: MenuItem[] = [
      {
        label: "Left Sidebar",
        checked: sidebarVisible,
        shortcutCommand: "sidebar.toggle",
        onClick: () => setSidebarSideVisible("left", !sidebarVisible),
      },
      {
        label: "Right Sidebar",
        checked: rightSidebarVisible,
        shortcutCommand: "sidebar.toggleRight",
        // With nothing on that side there is nothing to show — the tab menu
        // and a drag are how a tab gets there.
        disabled: sidebarView.right.tabs.length === 0,
        onClick: () => setSidebarSideVisible("right", !rightSidebarVisible),
      },
      {
        label: "Bottom Panel",
        checked: panel.visible,
        shortcutCommand: "panel.toggle",
        onClick: togglePanel,
      },
    ];
    return [
      {
        label: "Command Palette",
        icon: "search",
        shortcutCommand: "commandPalette.toggle",
        onClick: () => setSwitcherQuery(">"),
      },
      { label: "", separator: true, onClick: () => {} },
      { label: "Settings", icon: "gear", shortcutCommand: "settings.open", onClick: openSettingsTab },
      {
        label: "Extensions",
        icon: "extensions",
        shortcutCommand: "sidebar.focusExtensions",
        onClick: () => focusSidebarTab(EXTENSIONS_TAB_ID),
      },
      {
        label: "Keyboard Shortcuts",
        icon: "keyboard",
        shortcutCommand: "settings.openKeyboardShortcuts",
        onClick: openKeyboardShortcutsTab,
      },
      { label: "", separator: true, onClick: () => {} },
      { label: "Sidebars", icon: "layout", onClick: () => {}, submenu: sidebarItems },
      {
        label: "Panes",
        icon: "layout-sidebar-left",
        onClick: () => {},
        submenu: paneItems.length > 0 ? paneItems : [{ label: "No panes", disabled: true, onClick: () => {} }],
      },
      {
        label: "Status Bar",
        icon: "layout-statusbar",
        onClick: () => {},
        submenu: statusBarMenuItems(),
      },
      {
        label: "Theme",
        icon: "paintcan",
        onClick: () => {},
        submenu:
          themeItems.length > 0
            ? themeItems
            : [{ label: "No themes installed", disabled: true, onClick: () => {} }],
      },
    ];
  }, [
    extSidebarPanels,
    sidebarPanelsById,
    sidebarLayout.hiddenPanels,
    toggleSidebarPane,
    extensions,
    settings.colorTheme,
    setSettings,
    sidebarVisible,
    rightSidebarVisible,
    sidebarView.right.tabs.length,
    setSidebarSideVisible,
    panel.visible,
    togglePanel,
    statusBarMenuItems,
    openSettingsTab,
    openKeyboardShortcutsTab,
  ]);

  // The agents the New Worktree form offers, from the one registry.
  //
  // There used to be a `worktreeRunCommands` setting here - a JSON list the
  // user maintained by hand, which the registry then had to be reconciled
  // with. It is gone: the agents ARE the list, so there is nothing to keep in
  // sync and nothing to hand-edit.
  //
  // Fetched rather than read from `settings.agents`, because that key holds
  // only the user's per-agent enabled overrides now - the agents themselves
  // come from whatever extensions contribute, which only the server knows.
  // Re-fetched when an agent is toggled or the Yolo/Manual choice changes,
  // since both change what this list should say.
  const agentSignature = settings.agents.map((a) => `${a.id}:${a.enabled}`).join(",");
  const [worktreeAgents, setWorktreeAgents] = useState<api.AgentLaunchOption[]>([]);
  useEffect(() => {
    let live = true;
    api
      .fetchAgentLaunchOptions()
      .then((list) => {
        if (live) setWorktreeAgents(list);
      })
      .catch(() => {
        // An empty list hides the picker, which is the right failure: better
        // than offering a command that cannot be resolved.
        if (live) setWorktreeAgents([]);
      });
    return () => {
      live = false;
    };
  }, [agentSignature, settings.agentPermissions]);

  const projectListProps = useMemo(
    () => ({
      sessions,
      activeSessionName: activeRealTab?.sessionName ?? null,
      activeWindow:
        activeRealTab?.windowIndex !== undefined
          ? { sessionName: activeRealTab.sessionName, index: activeRealTab.windowIndex }
          : null,
      onOpenAllWindows: openAllWindows,
      onOpenWindow: openWindowTab,
      onKillWindow: killWindow,
      onKillSession: closeProject,
      onRenameWindow: renameWindow,
      onTogglePinSession: togglePinSession,
      onNewWindowInSession: createWindow,
      onOpenProject: openProject,
      onOpenWorktree: openWorktree,
      onNewTerminalInProject: newTerminalInProject,
      onNewTerminalInWorktree: newTerminalInWorktree,
      onCreateWorktree: createWorktreeSession,
      onCleanUpWorktrees: cleanUpWorktrees,
      loadBranches: loadWorktreeBranches,
      worktreeAgents,
      onShowMenu: showMenu,
      repoIndex,
      projectMenuItems,
      worktreeMenuItems,
      windowMenuItems,
      extensionWindowActions: extWindowActions,
      resolvedBindings,
    }),
    [
      sessions,
      activeRealTab,
      openAllWindows,
      openWindowTab,
      killWindow,
      closeProject,
      renameWindow,
      togglePinSession,
      createWindow,
      openProject,
      openWorktree,
      newTerminalInProject,
      newTerminalInWorktree,
      createWorktreeSession,
      cleanUpWorktrees,
      loadWorktreeBranches,
      worktreeAgents,
      settings.agentPermissions,
      showMenu,
      repoIndex,
      projectMenuItems,
      worktreeMenuItems,
      windowMenuItems,
      extWindowActions,
      resolvedBindings,
    ],
  );

  // The sidebar tree shows pins, so it gets the registry;
  // the status bar's terminals popover deliberately passes none.
  const sidebarProjectListProps = useMemo(
    () => ({ ...projectListProps, projects }),
    [projectListProps, projects],
  );

  return (
    <div className="app">
      {showTitleBar && (
        <TitleBar
          rect={windowControlsOverlay.rect}
          emulated={windowControlsOverlay.emulated}
          focused={windowControlsOverlay.focused}
          title={windowTitle}
          commandCenterLabel={settings.commandCenterAction === "commandPalette" ? "Command Palette" : "Quick Switcher"}
          commandCenterCommand={
            settings.commandCenterAction === "commandPalette" ? "commandPalette.toggle" : "quickSwitcher.toggle"
          }
          onCommandCenter={() => setSwitcherQuery(settings.commandCenterAction === "commandPalette" ? ">" : "")}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={goBack}
          onGoForward={goForward}
          panelVisible={panel.visible}
          onTogglePanel={togglePanel}
          leftSidebarVisible={sidebarVisible}
          onToggleLeftSidebar={() => setSidebarSideVisible("left", !sidebarVisible)}
          rightSidebarVisible={rightSidebarVisible}
          onToggleRightSidebar={() => setSidebarSideVisible("right", !rightSidebarVisible)}
          onManage={(anchor) => showMenu(anchor.left, anchor.bottom, manageMenuItems())}
          resolvedBindings={resolvedBindings}
        />
      )}
      <div className="app-body">
      {/* Everything both sidebars render identically. Width, side, the
          layout slice, and the hide button differ per instance. */}
      {(() => null)()}
      {sidebarVisible ? (
        <>
          <div className="sidebar-backdrop" onClick={() => setSidebarSideVisible("left", false)} />
          <Sidebar
            width={sidebarWidth}
            side="left"
            layout={sidebarLayout}
            tabs={sidebarView.left.tabs}
            activeTabId={sidebarView.left.activeTabId}
            panelsById={sidebarPanelsById}
            tabEnv={sidebarTabEnv}
            sidebarTabs={extSidebarTabs}
            sidebarTabMenuItems={extSidebarTabMenuItems}
            panelState={sidebarPanelState}
            setPanelState={setSidebarPanelState}
            onSelectTab={selectSidebarTabById}
            manageMenuItems={manageMenuItems}
            rightSidebarVisible={rightSidebarVisible}
            onToggleRightSidebar={() => setSidebarSideVisible("right", !rightSidebarVisible)}
            onReorderTab={reorderSidebarTab}
            onMoveTab={moveSidebarTab}
            onMovePanel={moveSidebarPanel}
            tabDrag={sidebarTabDrag}
            onTabDragChange={setSidebarTabDrag}
            onCollapse={() => setSidebarSideVisible("left", false)}
            mobilePointer={mobilePointer}
            showFooter={!showTitleBar}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onGoBack={goBack}
            onGoForward={goForward}
    projectListProps={sidebarProjectListProps}
    onOpenLazygit={openLazygit}
    onShowMenu={showMenu}
    onAddProject={() => setFolderPickerMode("project")}
    recentProjectsMenu={() => recentProjectMenuItems(() => setFolderPickerMode("project"))}
    panelVisible={panel.visible}
    onTogglePanel={togglePanel}
    filesRootDir={resolvedFilesRootDir}
    filesRootMode={filesRootMode}
    onFilesRootModeChange={setFilesRootMode}
    onDropFiles={handleFileTreeDrop}
    filesRefreshKey={filesRefreshKey}
    onOpenFile={openFileOrViewer}
    onPreviewFile={openPreviewViewerTab}
    onEditFile={openFileInEditor}
    isPreviewable={isPreviewable}
    fileHoverAction={fileHoverAction}
    fileMenuItems={fileMenuItems}
    fileTreeRootMenuItems={fileTreeRootMenuItems}
    fileMultiMenuItems={fileMultiMenuItems}
    deleteFileEntry={deleteFileEntry}
    deleteFileEntries={deleteFileEntries}
    renameFileEntry={renameFileEntry}
    onFindInFolder={findInFolder}
    onCreateFile={createFileInDir}
    onCreateFolder={createFolderInDir}
    onCopyPath={copyFilePaths}
    onCopyRelativePath={copyFileRelativePaths}
    prunePath={prunePath}
    cutPaths={cutPaths}
    onCopyEntries={copyEntries}
    onCutEntries={cutEntries}
    onPasteInto={pasteIntoDir}
    onClearClipboard={clearClipboard}
    onTransferEntries={transferEntries}
    extensionPanels={extSidebarPanels}
    extensionWindowActions={extWindowActions}
    extensions={extensions}
    onReloadExtensions={reloadExtensions}
    extensionRegistries={extensionRegistries}
    onExtensionRegistriesChange={setExtensionRegistries}
    defaultRegistry={defaultRegistry}
    registryCatalog={registryCatalog}
    registryLoading={registryLoading}
    onEnsureRegistryLoaded={ensureRegistryLoaded}
    onRefreshRegistry={refreshRegistry}
    onOpenExtensionPage={openExtensionPageTab}
    extensionUpdatesCount={extensionUpdatesCount}
    resolvedBindings={resolvedBindings}
    confirmDialog={confirmDialog}
          />
          <div className="resize-handle" onMouseDown={(e) => startSidebarResize(e, "left")} />
        </>
      ) : (
        <div
          className="sidebar-reopen"
          title={`Show sidebar${sidebarToggleBinding ? ` (${sidebarToggleBinding})` : ""}`}
          onClick={() => setSidebarSideVisible("left", true)}
        />
      )}
      {/* Drop zone standing in for a sidebar that isn't on screen — only
          visible mid-drag (body.sidebar-tab-dragging), so a second sidebar
          is discoverable exactly when it can be used. */}
      {!sidebarVisible && <div className="sidebar-drop-edge" data-side="left" />}
      <main className="main">
        <SplitLayout
          tree={splitTree}
          tabs={tabs}
          activeGroupId={activeGroupId}
          groupActive={groupActive}
          label={tabLabel}
          activity={tabActivity}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onShowMenu={showMenu}
          activeMenuSourceId={menu?.sourceId ?? null}
          onCloseMenu={closeMenu}
          tabMenuItems={tabMenuItems}
          onReorder={moveTab}
          onMoveTabToGroup={moveTabToGroup}
          onSplitAndMoveTab={splitGroupAndMoveTab}
          onToggleSidebar={() => setSidebarSideVisible("left", !sidebarVisible)}
          groupingEnabled={settings.tabGroupsBySession}
          groupKey={tabGroupKey}
          groupLabel={groupLabelForKey}
          groupState={tabGroupState}
          onToggleGroupCollapsed={toggleGroupCollapsed}
          groupMenuItems={groupMenuItems}
          windowMenuItems={chipWindowMenuItems}
          onReorderGroup={moveGroup}
          onNewWindow={sessions.length > 0 ? newWindowInGroup : null}
          onFocusGroup={focusGroup}
          onResizeBranch={resizeBranch}
          actionsRefFor={getGroupActionsRef}
          tabExtrasFor={tabExtrasFor}
          contentSlotRefFor={getGroupContentSlotRef}
        />
        {tabs.map((tab) => {
          if (tab.groupId === undefined) return null;
          const groupId = tab.groupId;
          const rect = groupContentRects[groupId];
          if (!rect) return null;
          const visible = groupActive[groupId] === tab.id;
          // The bottom panel's terminals compete for the same keyboard focus,
          // so an editor terminal only claims it while the panel doesn't hold
          // it (see useBottomPanel's panelFocused).
          const focused = visible && groupId === activeGroupId && !panelFocused;
          let content: React.ReactNode;
          if (tab.settingsView) {
            content = (
              <SettingsView
                active={visible}
                settings={settings}
                onSettingsChange={setSettings}
                extensions={extensions}
                onReloadExtensions={reloadExtensions}
                extensionSettings={extensionSettings}
                onExtensionSettingsChange={setExtensionSettings}
                pendingFocusExtensionId={pendingFocusExtensionId}
                onFocusExtensionHandled={() => setPendingFocusExtensionId(null)}
                onRequestImport={() => importInputRef.current?.click()}
                importError={importError}
              />
            );
          } else if (tab.keyboardView) {
            content = (
              <KeyboardShortcutsView
                active={visible}
                keybindingOverrides={keybindingOverrides}
                onKeybindingOverridesChange={setKeybindingOverrides}
              />
            );
          } else if (tab.extensionPageId !== undefined) {
            content = (
              <ExtensionPageView
                active={visible}
                extensionId={tab.extensionPageId}
                source={tab.extensionPageSource}
                extensions={extensions}
                registryCatalog={registryCatalog}
                onReloadExtensions={reloadExtensions}
                onOpenExtensionSettings={(id) => {
                  setPendingFocusExtensionId(id);
                  openSettingsTab();
                }}
              />
            );
          } else if (tab.extViewerPath !== undefined) {
            // The registered viewer that opened this tab may have been
            // unregistered since (extension disabled/uninstalled) — the tab
            // still exists but has nothing left to render.
            const viewer = extFileViewers.find((v) => v.id === tab.extViewerId);
            if (!viewer) {
              content = (
                <div className={`settings-host${visible ? "" : " hidden"}`}>
                  <div className="file-tree-empty">This viewer's extension is no longer active.</div>
                </div>
              );
            } else {
              const ViewerComponent = viewer.component;
              content = (
                <ViewerComponent
                  filePath={tab.extViewerPath}
                  active={visible}
                  toolbarTarget={groupActionsEls[groupId] ?? null}
                  openInEditor={openFileInEditor}
                  showMenu={showMenu}
                  fontSize={effectiveSettings.fontSize}
                  reloadKey={tab.extViewerReloadKey}
                  setDirty={(dirty) => {
                    if (dirty) dirtyTabsRef.current.add(tab.id);
                    else dirtyTabsRef.current.delete(tab.id);
                  }}
                  setTitle={(title) => {
                    setTabs((prev) =>
                      prev.some((t) => t.id === tab.id && t.extViewerTitle !== title)
                        ? prev.map((t) => (t.id === tab.id ? { ...t, extViewerTitle: title } : t))
                        : prev,
                    );
                  }}
                />
              );
            }
          } else if (tab.imagePath !== undefined || tab.previewPath !== undefined) {
            // A legacy imagePath/previewPath tab restored from localStorage
            // before this extraction shipped, not yet converted to
            // extViewerId/extViewerPath by the migration effect above —
            // resolves itself once extension activation populates the
            // registry (see the plan's "accept the flash" decision).
            content = (
              <div className={`settings-host${visible ? "" : " hidden"}`}>
                <div className="file-tree-empty">Loading…</div>
              </div>
            );
          } else {
            // Same session/window lookup tabExtrasFor uses above — window
            // absent (session not live yet, or index stale mid-reconcile)
            // just leaves image paste/drop disabled for this render; it
            // self-heals on the next sessions poll.
            const paneSession = sessions.find((s) => s.name === tab.sessionName);
            const paneWindow =
              tab.windowIndex !== undefined
                ? paneSession?.windows.find((w) => w.index === tab.windowIndex)
                : paneSession?.windows.find((w) => w.active);
            content = (
              <TerminalView
                attachName={tab.attachName}
                visible={visible}
                focused={focused}
                settings={effectiveSettings}
                theme={activeTerminalTheme}
                fontsVersion={fontsVersion}
                bindings={resolvedBindings}
                onExit={() => closeTab(tab.id)}
                onError={showError}
                // A window switch made from inside the terminal itself — the
                // server already reverted the synthetic session to its pin;
                // surface the window the user actually picked.
                onWindowSwitch={(windowIndex) => openWindowTab(tab.sessionName, windowIndex)}
                onSessionSwitch={openSwitchedSession}
                onOpenFile={openFileOrViewer}
                onOpenFileSecondary={openFileOrViewerSecondary}
                showMenu={showMenu}
                onPreviewFile={openPreviewViewerTab}
                isPreviewable={isPreviewable}
                cwd={paneWindow?.cwd}
              />
            );
          }
          return (
            <div
              key={tab.id}
              className="split-content-host"
              style={{
                position: "fixed",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                display: visible ? undefined : "none",
              }}
              onPointerDownCapture={() => {
                focusGroup(groupId);
                setPanelFocused(false);
              }}
            >
              {content}
            </div>
          );
        })}
        {tabs.length === 0 &&
          leaves(splitTree).map((groupId) => {
            const rect = groupContentRects[groupId];
            if (!rect) return null;
            return (
              <div
                key={`placeholder-${groupId}`}
                className="split-content-host"
                style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                onPointerDownCapture={() => {
                  focusGroup(groupId);
                  setPanelFocused(false);
                }}
              >
                <div className="placeholder">Select a session from the sidebar to open a terminal</div>
              </div>
            );
          })}
        {extAppOverlays.length > 0 && (
          <div className="app-overlay-layer" ref={overlayLayerRef}>
            {extAppOverlays.map((o) => (
              <o.component key={o.id} context={appOverlayContext} />
            ))}
          </div>
        )}
      </main>
      {/* Openable even with no tabs — it then shows a hint and its own empty
          tab strip as a drop target, which is what makes the second sidebar
          discoverable at all (VS Code's secondary sidebar behaves the same). */}
      {rightSidebarVisible ? (
        <>
          <div className="sidebar-backdrop" onClick={() => setSidebarSideVisible("right", false)} />
          <div className="resize-handle" onMouseDown={(e) => startSidebarResize(e, "right")} />
          <Sidebar
            width={sidebarRightWidth}
            side="right"
            layout={sidebarLayout}
            tabs={sidebarView.right.tabs}
            activeTabId={sidebarView.right.activeTabId}
            panelsById={sidebarPanelsById}
            tabEnv={sidebarTabEnv}
            sidebarTabs={extSidebarTabs}
            sidebarTabMenuItems={extSidebarTabMenuItems}
            panelState={sidebarPanelState}
            setPanelState={setSidebarPanelState}
            onSelectTab={selectSidebarTabById}
            manageMenuItems={manageMenuItems}
            rightSidebarVisible={rightSidebarVisible}
            onToggleRightSidebar={() => setSidebarSideVisible("right", !rightSidebarVisible)}
            onReorderTab={reorderSidebarTab}
            onMoveTab={moveSidebarTab}
            onMovePanel={moveSidebarPanel}
            tabDrag={sidebarTabDrag}
            onTabDragChange={setSidebarTabDrag}
            onCollapse={() => setSidebarSideVisible("right", false)}
            mobilePointer={mobilePointer}
            showFooter={!showTitleBar}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onGoBack={goBack}
            onGoForward={goForward}
    projectListProps={sidebarProjectListProps}
    onOpenLazygit={openLazygit}
    onShowMenu={showMenu}
    onAddProject={() => setFolderPickerMode("project")}
    recentProjectsMenu={() => recentProjectMenuItems(() => setFolderPickerMode("project"))}
    panelVisible={panel.visible}
    onTogglePanel={togglePanel}
    filesRootDir={resolvedFilesRootDir}
    filesRootMode={filesRootMode}
    onFilesRootModeChange={setFilesRootMode}
    onDropFiles={handleFileTreeDrop}
    filesRefreshKey={filesRefreshKey}
    onOpenFile={openFileOrViewer}
    onPreviewFile={openPreviewViewerTab}
    onEditFile={openFileInEditor}
    isPreviewable={isPreviewable}
    fileHoverAction={fileHoverAction}
    fileMenuItems={fileMenuItems}
    fileTreeRootMenuItems={fileTreeRootMenuItems}
    fileMultiMenuItems={fileMultiMenuItems}
    deleteFileEntry={deleteFileEntry}
    deleteFileEntries={deleteFileEntries}
    renameFileEntry={renameFileEntry}
    onFindInFolder={findInFolder}
    onCreateFile={createFileInDir}
    onCreateFolder={createFolderInDir}
    onCopyPath={copyFilePaths}
    onCopyRelativePath={copyFileRelativePaths}
    prunePath={prunePath}
    cutPaths={cutPaths}
    onCopyEntries={copyEntries}
    onCutEntries={cutEntries}
    onPasteInto={pasteIntoDir}
    onClearClipboard={clearClipboard}
    onTransferEntries={transferEntries}
    extensionPanels={extSidebarPanels}
    extensionWindowActions={extWindowActions}
    extensions={extensions}
    onReloadExtensions={reloadExtensions}
    extensionRegistries={extensionRegistries}
    onExtensionRegistriesChange={setExtensionRegistries}
    defaultRegistry={defaultRegistry}
    registryCatalog={registryCatalog}
    registryLoading={registryLoading}
    onEnsureRegistryLoaded={ensureRegistryLoaded}
    onRefreshRegistry={refreshRegistry}
    onOpenExtensionPage={openExtensionPageTab}
    extensionUpdatesCount={extensionUpdatesCount}
    resolvedBindings={resolvedBindings}
    confirmDialog={confirmDialog}
          />
        </>
      ) : (
        <>
          <div className="sidebar-drop-edge" data-side="right" />
          {sidebarView.right.tabs.length > 0 && (
            <div
              className="sidebar-reopen sidebar-reopen-right"
              title={`Show right sidebar${rightSidebarToggleBinding ? ` (${rightSidebarToggleBinding})` : ""}`}
              onClick={() => setSidebarSideVisible("right", true)}
            />
          )}
        </>
      )}
      </div>
      {/* Outside .app-body deliberately: the bottom panel spans the whole
          window, under both sidebars, rather than only the editor column. */}
      {panel.visible && (
        <BottomPanel
          panel={panel}
          visibleTabs={panelVisibleTabs}
          activeTabId={panelActiveTabId}
          panelFocused={panelFocused}
          sessions={sessions}
          settings={effectiveSettings}
          theme={activeTerminalTheme}
          fontsVersion={fontsVersion}
          bindings={resolvedBindings}
          onSelectTab={selectPanelTab}
          onSelectPane={selectPanelPane}
          onCloseTab={closePanelTab}
          onResizePanes={resizePanelPanes}
          // The attach is already gone (shell exited, or the window was
          // killed) — drop the pane without a detach call.
          onPaneExit={(tabId, paneId) => removePanelPane(tabId, paneId, false)}
          onRequestTerminal={requestPanelTerminal}
          onRequestAttachWindow={requestPanelAttachWindow}
          onSplit={splitActivePane}
          onHide={hidePanel}
          onSetHeight={setPanelHeight}
          onError={showError}
          onOpenFile={openFileOrViewer}
          onOpenFileSecondary={openFileOrViewerSecondary}
          // A window switch made inside a panel pane surfaces the picked
          // window in the *editor* area; the pane itself snaps back to the
          // window it's pinned to (the server already reverted it).
          onWindowSwitch={(session, windowIndex) => openWindowTab(session, windowIndex)}
          onSessionSwitch={openSwitchedSession}
        />
      )}
      {settings.showStatusBar && (
        <StatusBar
          sessions={sessions}
          slots={statusBarSlots}
          layout={statusBarLayout}
          setLayout={setStatusBarLayout}
          widgetMenuItems={statusBarMenuItems}
          projectListProps={projectListProps}
          showMenu={showMenu}
          manageMenuItems={manageMenuItems}
          confirmDialog={confirmDialog}
          mobilePointer={mobilePointer}
        />
      )}
      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} resolvedBindings={resolvedBindings} />
      )}
      {folderPickerMode !== null && (
        <FolderPickerDialog
          initialPath={settings.defaultProjectsFolder || "~"}
          onPick={(path) => {
            const mode = folderPickerMode;
            setFolderPickerMode(null);
            if (mode === "panelTerminal") void openPanelTerminalInProject(path);
            else void openProject(path);
          }}
          onCancel={() => setFolderPickerMode(null)}
        />
      )}
      <input
        ref={importInputRef}
        id="settings-import-file"
        className="settings-file-input"
        type="file"
        accept="application/json,.json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file twice in a row still fires.
          e.target.value = "";
          if (file) void pickImportFile(file);
        }}
      />
      {importBundle && (
        <ImportSettingsDialog bundle={importBundle} onClose={() => setImportBundle(null)} />
      )}
      {dialog && <Dialog dialog={dialog} />}
      {switcherQuery !== null && (
        <QuickSwitcher
          sessions={sessions}
          tabs={tabs}
          tabLabel={tabLabel}
          projectLabel={projectLabelForSession}
          filesRootDir={resolvedFilesRootDir}
          initialQuery={switcherQuery}
          commands={paletteCommands}
          bindings={resolvedBindings}
          onActivateTab={setActiveTabId}
          onOpenWindow={openWindowTab}
          onOpenSession={openSession}
          onOpenFile={openFileOrViewer}
          onOpenFileSecondary={openFileOrViewerSecondary}
          onClose={() => {
            setSwitcherQuery(null);
            // Every close path — Escape, overlay click, and entry
            // activation (runEntry closes before running) — otherwise
            // strands keyboard focus on <body> once the switcher's input
            // unmounts. Guarded so an entry that opened a dialog (rename,
            // kill confirm, folder picker) keeps the dialog's autofocus.
            requestTerminalRefocus({ onlyIfUnowned: true });
          }}
        />
      )}
      {uploadProgress && (
        <div className="upload-banner">
          <div className="upload-banner-label">
            Uploading{uploadProgress.currentName ? ` - ${uploadProgress.currentName}` : "…"}
          </div>
          <div className="upload-banner-track">
            <div
              className="upload-banner-fill"
              style={{
                width: `${
                  uploadProgress.totalBytes > 0
                    ? Math.min(100, (uploadProgress.loadedBytes / uploadProgress.totalBytes) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {openUrlBanner && (
        <div className="open-url-banner">
          <a
            href={openUrlBanner}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpenUrlBanner(null)}
          >
            Open {openUrlBanner}
          </a>
          <button
            className="open-url-banner-dismiss"
            aria-label="Dismiss"
            onClick={() => setOpenUrlBanner(null)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
