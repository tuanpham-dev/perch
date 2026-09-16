import { useEffect, useRef, useState } from "react";
import type { MenuItem, Tab, TabGroupState } from "../types";
import { adjustForContrast, GROUP_COLORS, groupColorHex } from "../utils/groupColor";
import { getFileIconResult, useIconThemeVersion } from "../utils/iconThemes";
import FileIcon from "./FileIcon";
import Icon from "./Icon";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  label: (tab: Tab) => string;
  activity: (tab: Tab) => boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  // sourceId (optional) tags who opened this menu — the chip arrow button
  // below passes its own tag so it can later tell whether its menu is the
  // one currently open (activeMenuSourceId) and toggle it closed.
  onShowMenu: (x: number, y: number, items: MenuItem[], sourceId?: string) => void;
  activeMenuSourceId: string | null;
  onCloseMenu: () => void;
  // This bar's own editor-group id — used only to build the chip arrow's
  // sourceId (so two panes showing the same session's chip don't confuse
  // each other's toggle state), not for scoping tabs (groupTabs is already
  // filtered by the caller).
  editorGroupId: string;
  tabMenuItems: (tab: Tab) => MenuItem[];
  // Reports the actions container's DOM element as it mounts/unmounts, so a
  // tab (e.g. an image viewer) can portal per-tab controls into it — VS
  // Code/code-server style editor-actions on the right of the tab strip.
  actionsRef: (el: HTMLDivElement | null) => void;
  // Extension window-action buttons for this bar's own active tab (e.g. a
  // "Preview Claude session" icon) — rendered just left of the actionsRef
  // portal target; null/undefined renders nothing. See App.tsx's
  // tabExtrasFor.
  extras?: React.ReactNode;
  onToggleSidebar: () => void;
  // Chrome-style tab groups (settings.tabGroupsBySession) — see
  // plans/tab-groups-by-session.md. groupKey returns null for a tab that
  // isn't grouped (settings/extension-viewer tabs).
  groupingEnabled: boolean;
  groupKey: (tab: Tab) => string | null;
  // Display label for a group key — the project's folder name (App resolves
  // a path key via projectName; a pathless session's key is its own name).
  groupLabel: (groupKey: string) => string;
  groupState: Record<string, TabGroupState>;
  onToggleGroupCollapsed: (sessionName: string) => void;
  groupMenuItems: (sessionName: string) => MenuItem[];
  // Populates the chip arrow button's dropdown — the session's windows,
  // opened as a new tab (or focused if already open) on click.
  windowMenuItems: (sessionName: string) => MenuItem[];
  // Drag-a-chip (or "Move Group Left/Right") reordering — see
  // plans/reorder-tab-groups.md. toIndex is a position among group keys
  // only (lib/tabs.ts's moveGroup), never a tab-array index. Kept entirely
  // local to this bar, unlike tab drag below.
  onReorderGroup: (groupKey: string, toIndex: number) => void;
  // A tab drag can land in a different split pane, so its gesture (start,
  // move, drop) is owned by SplitLayout's coordinator, not this bar — see
  // plans/vscode-editor-group-splits.md. This bar only reports pointer-down
  // on one of its own tabs and renders whatever drag/drop-indicator state
  // the coordinator computes for it.
  dragTabId: string | null;
  dropIndicator: { id: string; edge: "left" | "right" } | null;
  onTabPointerDown: (e: React.PointerEvent, tabId: string) => void;
  // Shared with the coordinator so a real drag's trailing native `click`
  // doesn't also activate the tab — same justDraggedRef pattern this file
  // already uses for its own (still-local) chip drag below.
  tabJustDraggedRef: React.MutableRefObject<boolean>;
  // Chrome-style "+" rendered right after the last tab, inside the scrolling
  // strip — creates a new window in this bar's last-active session and
  // opens it as a tab. Null hides the button (e.g. no sessions exist yet).
  onNewWindow: (() => void) | null;
}

// Long-press delay (touch/pen) before a hold starts a chip drag instead of
// letting the gesture fall through to the tab bar's native horizontal
// scroll.
const LONG_PRESS_MS = 300;
// Movement past this cancels a pending touch long-press (treated as a scroll)
// or, on mouse, arms a drag once exceeded.
const MOVE_SLOP_PX = 8;
const MOUSE_DRAG_THRESHOLD_PX = 5;

export default function TabBar({
  tabs,
  activeTabId,
  label,
  activity,
  onActivate,
  onClose,
  onShowMenu,
  activeMenuSourceId,
  onCloseMenu,
  editorGroupId,
  tabMenuItems,
  actionsRef,
  extras,
  onToggleSidebar,
  groupingEnabled,
  groupKey,
  groupLabel,
  groupState,
  onToggleGroupCollapsed,
  groupMenuItems,
  windowMenuItems,
  onReorderGroup,
  dragTabId,
  dropIndicator,
  onTabPointerDown,
  tabJustDraggedRef,
  onNewWindow,
}: Props) {
  // Re-renders the strip when the active icon theme changes — getFileIconResult
  // reads module-level state directly, same subscribe-to-force-render shape
  // FileTree uses (see utils/iconThemes.ts's useIconThemeVersion).
  useIconThemeVersion();

  const [dragGroupKey, setDragGroupKey] = useState<string | null>(null);
  const [groupDropIndicator, setGroupDropIndicator] = useState<{ id: string; edge: "left" | "right" } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const justDraggedRef = useRef(false);

  // The distinct group keys among `tabs`, in first-appearance order — the
  // single source of truth chip hit-testing (computeGroupInsertion below)
  // and the render loop's chip order both derive from. Derived through the
  // `groupKey` prop (not lib/tabs' orderedGroupKeys directly) so the
  // project-key resolver App bakes into that prop applies here too.
  const groupOrder: string[] = [];
  if (groupingEnabled) {
    for (const tab of tabs) {
      const key = groupKey(tab);
      if (key !== null && !groupOrder.includes(key)) groupOrder.push(key);
    }
  }

  // Resolved tab-bar background, used to contrast-adjust group colors
  // against whatever the active color theme actually renders (a fixed
  // palette tuned for the bundled dark theme could otherwise wash out
  // against a light one) — see utils/groupColor's adjustForContrast.
  // Recomputed on mount and whenever a color theme applies its CSS vars
  // (theme.ts's applyColorThemeCssVars sets them directly on
  // document.documentElement.style, so observing that attribute catches
  // every theme swap without new props threaded down from App).
  const [barBg, setBarBg] = useState("#21252b");
  useEffect(() => {
    const recompute = () => {
      const el = tabBarRef.current;
      if (el) setBarBg(getComputedStyle(el).backgroundColor);
    };
    recompute();
    const observer = new MutationObserver(recompute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, []);

  // Mutable chip-drag session state — kept out of React state since it
  // updates on every pointermove and must be readable synchronously from
  // window listeners registered outside React's event system.
  const sessionRef = useRef<{
    pointerId: number;
    sessionName: string;
    pointerType: string;
    startX: number;
    startY: number;
    dragging: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    insertIndex: number;
  } | null>(null);

  // Hit-tests against chipRefs and groupOrder — a chip can only reorder
  // relative to other chips in this same bar.
  const computeGroupInsertion = (clientX: number, draggedKey: string): { id: string; edge: "left" | "right" } | null => {
    const order = groupOrder.filter((k) => k !== draggedKey);
    if (order.length === 0) return null;
    for (const key of order) {
      const el = chipRefs.current.get(key);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return { id: key, edge: "left" };
      if (clientX < rect.right) return { id: key, edge: "right" };
    }
    return { id: order[order.length - 1], edge: "right" };
  };

  const groupIndicatorToIndex = (indicator: { id: string; edge: "left" | "right" }, draggedKey: string): number => {
    const order = groupOrder.filter((k) => k !== draggedKey);
    const idx = order.findIndex((k) => k === indicator.id);
    return indicator.edge === "left" ? idx : idx + 1;
  };

  const removeWindowListeners = () => {
    window.removeEventListener("pointermove", onPointerMoveWindow);
    window.removeEventListener("pointerup", onPointerUpWindow);
    window.removeEventListener("pointercancel", onPointerCancelWindow);
  };

  const endSession = () => {
    const session = sessionRef.current;
    if (session?.longPressTimer) clearTimeout(session.longPressTimer);
    sessionRef.current = null;
    setDragGroupKey(null);
    setGroupDropIndicator(null);
  };

  // Safety net: if TabBar unmounts mid-drag (session still active), the
  // gesture's own pointerup/pointercancel will never fire to remove these —
  // tear them down here directly (no setState — the component is gone).
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (!session) return;
      if (session.longPressTimer) clearTimeout(session.longPressTimer);
      removeWindowListeners();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDragging = () => {
    const session = sessionRef.current;
    if (!session || session.dragging) return;
    session.dragging = true;
    setDragGroupKey(session.sessionName);
  };

  const onPointerMoveWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    const dx = e.clientX - session.startX;
    const dy = e.clientY - session.startY;

    if (!session.dragging) {
      if (session.pointerType === "mouse") {
        if (Math.hypot(dx, dy) >= MOUSE_DRAG_THRESHOLD_PX) startDragging();
        else return;
      } else {
        // Touch/pen: movement before the long-press timer fires cancels the
        // pending drag so a horizontal swipe keeps scrolling the bar.
        if (Math.hypot(dx, dy) >= MOVE_SLOP_PX) {
          endSession();
          return;
        }
        return;
      }
    }

    const indicator = computeGroupInsertion(e.clientX, session.sessionName);
    setGroupDropIndicator(indicator);
    if (indicator) session.insertIndex = groupIndicatorToIndex(indicator, session.sessionName);
  };

  const onPointerUpWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    removeWindowListeners();
    if (session.dragging) {
      justDraggedRef.current = true;
      onReorderGroup(session.sessionName, session.insertIndex);
    }
    endSession();
  };

  const onPointerCancelWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    removeWindowListeners();
    endSession();
  };

  const handleChipPointerDown = (e: React.PointerEvent, sessionName: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;

    sessionRef.current = {
      pointerId: e.pointerId,
      sessionName,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      longPressTimer: null,
      insertIndex: groupOrder.indexOf(sessionName),
    };

    if (e.pointerType !== "mouse") {
      sessionRef.current.longPressTimer = setTimeout(() => {
        if (sessionRef.current?.sessionName === sessionName) startDragging();
      }, LONG_PRESS_MS);
    }

    window.addEventListener("pointermove", onPointerMoveWindow);
    window.addEventListener("pointerup", onPointerUpWindow);
    window.addEventListener("pointercancel", onPointerCancelWindow);
  };

  // Suppresses native touch scrolling only while a drag is actually in
  // progress (this bar's own chip drag, or a cross-bar-aware tab drag owned
  // by the coordinator) — must be a non-passive listener since React's
  // onTouchMove can't preventDefault a scroll that's already begun.
  const handleBarTouchMove = (e: React.TouchEvent) => {
    if (sessionRef.current?.dragging || dragTabId !== null) e.preventDefault();
  };

  // Plain (unshifted) mouse wheel scrolls the strip horizontally too, not
  // just Shift+wheel (the browser's native horizontal-scroll gesture).
  // Native (non-passive) listener: React's onWheel can't preventDefault a
  // scroll that's already begun.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handleTabClick = (id: string) => {
    if (tabJustDraggedRef.current) {
      tabJustDraggedRef.current = false;
      return;
    }
    onActivate(id);
  };

  const handleChipClick = (sessionName: string) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    onToggleGroupCollapsed(sessionName);
  };

  useEffect(() => {
    if (!activeTabId) return;
    barRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs]);

  // Per-group contrast-adjusted line color and aggregated activity — one
  // pass over `tabs`, computed only while grouping is on.
  const groupColorFor: Record<string, string> = {};
  const groupHasActivity: Record<string, boolean> = {};
  if (groupingEnabled) {
    for (const tab of tabs) {
      const key = groupKey(tab);
      if (key === null) continue;
      if (!(key in groupColorFor)) {
        groupColorFor[key] = adjustForContrast(groupColorHex(groupState[key]?.color ?? GROUP_COLORS[0].key), barBg);
      }
      if (activity(tab)) groupHasActivity[key] = true;
    }
  }

  const renderTab = (tab: Tab, groupLineColor?: string) => {
    const indicatorClass =
      dropIndicator?.id === tab.id ? ` drop-indicator-${dropIndicator.edge}` : "";
    const draggingClass = dragTabId === tab.id ? " dragging" : "";
    const groupedClass = groupLineColor ? " grouped" : "";
    return (
      <div
        key={tab.id}
        data-tab-id={tab.id}
        className={`tab${tab.id === activeTabId ? " active" : ""}${indicatorClass}${draggingClass}${groupedClass}`}
        style={groupLineColor ? ({ "--group-color": groupLineColor } as React.CSSProperties) : undefined}
        onPointerDown={(e) => onTabPointerDown(e, tab.id)}
        onClick={() => handleTabClick(tab.id)}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest(".tab-close")) return;
          onToggleSidebar();
        }}
        onAuxClick={(e) => {
          if (e.button === 1) onClose(tab.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onShowMenu(e.clientX, e.clientY, tabMenuItems(tab));
        }}
      >
        {activity(tab) && <span className="activity-dot" />}
        {tab.settingsView && <Icon name="settings-gear" className="tab-type-icon" />}
        {tab.keyboardView && <Icon name="keyboard" className="tab-type-icon" />}
        {tab.extensionPageId !== undefined && <Icon name="extensions" className="tab-type-icon" />}
        {tab.extViewerPath && (
          <FileIcon
            className="tab-file-icon"
            result={getFileIconResult(tab.extViewerPath.split("/").pop() ?? tab.extViewerPath)}
          />
        )}
        <span className="tab-title">{label(tab)}</span>
        <button
          className="tab-close"
          title="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
        >
          <Icon name="close" />
        </button>
      </div>
    );
  };

  const renderChip = (sessionName: string) => {
    const state = groupState[sessionName];
    const collapsed = state?.collapsed ?? false;
    const rawColor = groupColorHex(state?.color ?? GROUP_COLORS[0].key);
    const indicatorClass =
      groupDropIndicator?.id === sessionName ? ` drop-indicator-${groupDropIndicator.edge}` : "";
    const draggingClass = dragGroupKey === sessionName ? " dragging" : "";
    return (
      <div
        key={`group:${sessionName}`}
        ref={(el) => {
          if (el) chipRefs.current.set(sessionName, el);
          else chipRefs.current.delete(sessionName);
        }}
        className={`tab-group-chip${indicatorClass}${draggingClass}`}
        style={{ background: rawColor }}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={`${groupLabel(sessionName)} tab group, ${collapsed ? "collapsed" : "expanded"}`}
        onPointerDown={(e) => handleChipPointerDown(e, sessionName)}
        onClick={() => handleChipClick(sessionName)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onToggleGroupCollapsed(sessionName);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onShowMenu(e.clientX, e.clientY, groupMenuItems(sessionName));
        }}
      >
        <button
          className="tab-group-chip-window-btn"
          title="Project terminals"
          aria-haspopup="menu"
          aria-label={`${groupLabel(sessionName)} terminals`}
          data-menu-trigger="true"
          onClick={(e) => {
            e.stopPropagation();
            if (justDraggedRef.current) {
              justDraggedRef.current = false;
              return;
            }
            const sourceId = `chip-windows:${editorGroupId}:${sessionName}`;
            if (activeMenuSourceId === sourceId) {
              onCloseMenu();
              return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            onShowMenu(rect.left, rect.bottom + 2, windowMenuItems(sessionName), sourceId);
          }}
        >
          <Icon name="chevron-down" />
        </button>
        <span className="tab-group-chip-label">{groupLabel(sessionName)}</span>
        {groupHasActivity[sessionName] && <span className="activity-dot" />}
      </div>
    );
  };

  const nodes: React.ReactNode[] = [];
  const chippedGroups = new Set<string>();
  for (const tab of tabs) {
    const key = groupingEnabled ? groupKey(tab) : null;
    if (key === null) {
      nodes.push(renderTab(tab));
      continue;
    }
    if (!chippedGroups.has(key)) {
      chippedGroups.add(key);
      nodes.push(renderChip(key));
    }
    if (!(groupState[key]?.collapsed ?? false)) {
      nodes.push(renderTab(tab, groupColorFor[key]));
    }
  }

  return (
    <div className="tab-bar" ref={tabBarRef}>
      <div
        className="tab-strip"
        ref={barRef}
        onTouchMove={handleBarTouchMove}
      >
        {nodes}
        {onNewWindow && (
          <button className="tab-new-btn" title="New Window" onClick={onNewWindow}>
            <Icon name="add" />
          </button>
        )}
      </div>
      {extras && <div className="tab-bar-extras">{extras}</div>}
      <div className="tab-bar-actions" ref={actionsRef} />
    </div>
  );
}
