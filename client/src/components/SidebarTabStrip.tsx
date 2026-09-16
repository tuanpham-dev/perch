import { useEffect, useRef, useState } from "react";
import type { TabDragState } from "../hooks/useSidebarLayout";
import { otherSide, type SidebarSide } from "../lib/sidebarLayout";
import type { MenuItem } from "../types";
import Icon from "./Icon";

export interface SidebarTabInfo {
  id: string;
  title: string;
  icon: string;
  badge?: number | null;
}

interface Props {
  side: SidebarSide;
  tabs: SidebarTabInfo[];
  activeId: string;
  onSelect: (id: string) => void;
  // Reorder within this strip: `toIndex` indexes this strip's own tabs.
  onReorder: (id: string, toIndex: number) => void;
  // Move a tab to a side at an index in that side's tabs — the same call
  // for a drop on the other strip and for the tab menu's "Move to … Sidebar".
  onMoveToSide: (id: string, side: SidebarSide, index: number) => void;
  // A panel header dropped onto a tab icon: rehome that section here.
  onDropPanel: (panelId: string, tabId: string) => void;
  // Whether a tab id is also a movable panel (an extension's own tab) — only
  // those can be dropped into a sidebar's panel area to become a section.
  isPanelTab: (tabId: string) => boolean;
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  // Extension-contributed right-click items for a tab, or for the strip's
  // empty area (null).
  extraMenuItems: (tabId: string | null) => MenuItem[];
  // Shared with the other strip, so whichever one is under the pointer
  // draws the drop indicator (and the source strip dims its dragged tab).
  drag: TabDragState | null;
  onDragChange: (drag: TabDragState | null) => void;
}

// Long-press delay (touch/pen) before a hold starts a drag instead of letting
// the gesture fall through to the strip's native horizontal scroll — mirrors
// TabBar's chip-drag thresholds (see plans/reorder-tab-groups.md).
const LONG_PRESS_MS = 300;
const MOVE_SLOP_PX = 8;
const MOUSE_DRAG_THRESHOLD_PX = 5;

// Panel-header drags use HTML5 DnD (that's what the accordion already
// does), so a tab icon accepts them as a plain drop target — must match
// Sidebar.tsx's PANEL_DRAG_TYPE.
const PANEL_DRAG_TYPE = "application/x-perch-panel";

// Where a tab drag would land: moved to a side at an index, or dropped into
// a tab's panel area to become one of its sections.
type DropTarget =
  | { kind: "side"; side: SidebarSide; index: number }
  | { kind: "panel"; tabId: string };

export default function SidebarTabStrip({
  side,
  tabs,
  activeId,
  onSelect,
  onReorder,
  onMoveToSide,
  onDropPanel,
  isPanelTab,
  onShowMenu,
  extraMenuItems,
  drag,
  onDragChange,
}: Props) {
  const [panelDropTabId, setPanelDropTabId] = useState<string | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const justDraggedRef = useRef(false);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const dragId = drag?.draggedId ?? null;
  const indicator = drag?.indicator ?? null;

  // Plain (unshifted) mouse wheel scrolls the strip horizontally too, not
  // just Shift+wheel (the browser's native horizontal-scroll gesture) —
  // matches TabBar's and BottomPanel's own tab strips. Native (non-passive)
  // listener: React's onWheel can't preventDefault a scroll that's already
  // begun.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Mutable drag session state — kept out of React state since it updates on
  // every pointermove and must be readable synchronously from window
  // listeners registered outside React's event system (same shape as
  // TabBar's sessionRef).
  const sessionRef = useRef<{
    pointerId: number;
    tabId: string;
    pointerType: string;
    startX: number;
    startY: number;
    dragging: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    drop: DropTarget | null;
  } | null>(null);

  // Where the pointer currently is, in layout terms: which strip (or which
  // empty side's drop edge) it's over, and where in it. Hit-tested through
  // the DOM rather than this strip's own tab rects, because a drag can end
  // on the OTHER sidebar's strip — or on the edge zone standing in for a
  // sidebar that isn't mounted yet.
  const hitTest = (
    clientX: number,
    clientY: number,
    draggedId: string,
  ): { indicator: TabDragState["indicator"]; drop: DropTarget } | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const edge = el?.closest<HTMLElement>(".sidebar-drop-edge");
    if (edge) {
      const edgeSide = edge.dataset.side === "right" ? "right" : "left";
      return {
        indicator: { side: edgeSide, tabId: null, edge: "end" },
        drop: { kind: "side", side: edgeSide, index: Number.MAX_SAFE_INTEGER },
      };
    }
    const strip = el?.closest<HTMLElement>(".sidebar-tabs");
    if (!strip) {
      const sidebar = el?.closest<HTMLElement>(".sidebar[data-side]");
      if (!sidebar) return null;
      const bodySide = sidebar.dataset.side === "right" ? "right" : "left";
      // Over a sidebar's panel area, with a tab that is itself a panel: this
      // is the "make it a section of what's showing here" drop.
      // data-host-tab, not data-tab-id: the latter marks the strip's own tab
      // buttons, and one attribute meaning two things invites a stray match.
      const body = el?.closest<HTMLElement>(".sidebar-body[data-host-tab]");
      const hostTabId = body?.dataset.hostTab;
      if (hostTabId && hostTabId !== draggedId && isPanelTab(draggedId)) {
        return {
          indicator: { side: bodySide, tabId: hostTabId, edge: "body" },
          drop: { kind: "panel", tabId: hostTabId },
        };
      }
      // Anywhere else in the sidebar (its header, or an empty sidebar's
      // body) moves the tab to that side, at the end.
      return {
        indicator: { side: bodySide, tabId: null, edge: "end" },
        drop: { kind: "side", side: bodySide, index: Number.MAX_SAFE_INTEGER },
      };
    }
    const stripSide = strip.dataset.side === "right" ? "right" : "left";
    const buttons = [...strip.querySelectorAll<HTMLElement>("[data-tab-id]")].filter(
      (b) => b.dataset.tabId !== draggedId,
    );
    if (buttons.length === 0) {
      return {
        indicator: { side: stripSide, tabId: null, edge: "end" },
        drop: { kind: "side", side: stripSide, index: 0 },
      };
    }
    for (let i = 0; i < buttons.length; i++) {
      const rect = buttons[i].getBoundingClientRect();
      const tabId = buttons[i].dataset.tabId!;
      if (clientX < rect.left + rect.width / 2) {
        return {
          indicator: { side: stripSide, tabId, edge: "left" },
          drop: { kind: "side", side: stripSide, index: i },
        };
      }
      if (clientX < rect.right) {
        return {
          indicator: { side: stripSide, tabId, edge: "right" },
          drop: { kind: "side", side: stripSide, index: i + 1 },
        };
      }
    }
    const lastId = buttons[buttons.length - 1].dataset.tabId!;
    return {
      indicator: { side: stripSide, tabId: lastId, edge: "right" },
      drop: { kind: "side", side: stripSide, index: buttons.length },
    };
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
    document.body.classList.remove("sidebar-tab-dragging");
    onDragChange(null);
  };

  // Safety net: if the strip unmounts mid-drag, the gesture's own
  // pointerup/pointercancel will never fire to remove these — tear them
  // down here directly (no setState — the component is gone).
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (!session) return;
      if (session.longPressTimer) clearTimeout(session.longPressTimer);
      removeWindowListeners();
      sessionRef.current = null;
      document.body.classList.remove("sidebar-tab-dragging");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDragging = () => {
    const session = sessionRef.current;
    if (!session || session.dragging) return;
    session.dragging = true;
    // Reveals the drop edges for whichever side has no sidebar mounted, so
    // a second sidebar is discoverable exactly when it's usable.
    document.body.classList.add("sidebar-tab-dragging");
    onDragChange({ draggedId: session.tabId, indicator: null });
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
        // pending drag so a horizontal swipe keeps scrolling the strip.
        if (Math.hypot(dx, dy) >= MOVE_SLOP_PX) {
          endSession();
          return;
        }
        return;
      }
    }

    const hit = hitTest(e.clientX, e.clientY, session.tabId);
    // Off every strip and edge: keep the last indicator rather than
    // flickering it away as the pointer crosses the terminal.
    if (!hit) return;
    session.drop = hit.drop;
    onDragChange({ draggedId: session.tabId, indicator: hit.indicator });
  };

  const onPointerUpWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    removeWindowListeners();
    if (session.dragging && session.drop) {
      justDraggedRef.current = true;
      const drop = session.drop;
      if (drop.kind === "panel") onDropPanel(session.tabId, drop.tabId);
      else if (drop.side === side) onReorder(session.tabId, drop.index);
      else onMoveToSide(session.tabId, drop.side, drop.index);
    }
    endSession();
  };

  const onPointerCancelWindow = (e: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    removeWindowListeners();
    endSession();
  };

  const handlePointerDown = (e: React.PointerEvent, tabId: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;

    sessionRef.current = {
      pointerId: e.pointerId,
      tabId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      longPressTimer: null,
      drop: null,
    };

    if (e.pointerType !== "mouse") {
      sessionRef.current.longPressTimer = setTimeout(() => {
        if (sessionRef.current?.tabId === tabId) startDragging();
      }, LONG_PRESS_MS);
    }

    window.addEventListener("pointermove", onPointerMoveWindow);
    window.addEventListener("pointerup", onPointerUpWindow);
    window.addEventListener("pointercancel", onPointerCancelWindow);
  };

  const handleClick = (tabId: string) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    onSelect(tabId);
  };

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const target = otherSide(side);
    const extra = extraMenuItems(tabId);
    onShowMenu(e.clientX, e.clientY, [
      {
        label: target === "right" ? "Move to Right Sidebar" : "Move to Left Sidebar",
        onClick: () => onMoveToSide(tabId, target, Number.MAX_SAFE_INTEGER),
      },
      ...(extra.length > 0 ? [{ label: "", separator: true, onClick: () => {} }, ...extra] : []),
    ]);
  };

  // The strip's empty area has no built-in actions; it shows a menu only
  // when an extension contributes one.
  const handleStripContextMenu = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const extra = extraMenuItems(null);
    if (extra.length === 0) return;
    e.preventDefault();
    onShowMenu(e.clientX, e.clientY, extra);
  };

  // A tab icon doubles as a drop target for a panel-header drag, which is
  // how a section is moved into another tab. The Extensions tab is excluded:
  // its body is the extension manager, not an accordion.
  const acceptsPanelDrop = (tabId: string) => tabId !== "extensions-view";

  const panelDragHandlers = (tabId: string) =>
    acceptsPanelDrop(tabId)
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(PANEL_DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setPanelDropTabId(tabId);
          },
          onDragLeave: (e: React.DragEvent) => {
            if (e.currentTarget === e.target) setPanelDropTabId(null);
          },
          onDrop: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(PANEL_DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            const panelId = e.dataTransfer.getData(PANEL_DRAG_TYPE);
            setPanelDropTabId(null);
            if (panelId) onDropPanel(panelId, tabId);
          },
        }
      : {};

  useEffect(() => {
    tabRefs.current.get(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div
      className="sidebar-tabs"
      role="tablist"
      aria-label="Sidebar views"
      data-side={side}
      ref={stripRef}
      onContextMenu={handleStripContextMenu}
    >
      {tabs.map((tab) => {
        const showsIndicator =
          indicator?.side === side && indicator.edge !== "body" && indicator.tabId === tab.id;
        const indicatorClass = showsIndicator ? ` drop-indicator-${indicator.edge}` : "";
        const draggingClass = dragId === tab.id ? " dragging" : "";
        const panelDropClass = panelDropTabId === tab.id ? " panel-drop-target" : "";
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el);
              else tabRefs.current.delete(tab.id);
            }}
            role="tab"
            type="button"
            data-tab-id={tab.id}
            aria-selected={tab.id === activeId}
            title={tab.title}
            className={`sidebar-tab${tab.id === activeId ? " active" : ""}${indicatorClass}${draggingClass}${panelDropClass}`}
            onPointerDown={(e) => handlePointerDown(e, tab.id)}
            onClick={() => handleClick(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
            {...panelDragHandlers(tab.id)}
          >
            <Icon name={tab.icon} />
            {!!tab.badge && <span className="sidebar-tab-badge">{tab.badge}</span>}
          </button>
        );
      })}
      {/* Trailing drop zone: a drag past the last tab (or onto an empty
          strip) lands at the end rather than nowhere. */}
      {indicator?.side === side && indicator.tabId === null && (
        <span className="sidebar-tabs-end-indicator" aria-hidden="true" />
      )}
    </div>
  );
}
