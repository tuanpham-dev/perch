import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { BranchNode, SplitDirection, SplitNode } from "../lib/splits";
import type { AppSettings } from "../settings";
import type { MenuItem, Tab, TabGroupState } from "../types";
import {
  decodeDragPayload,
  encodeDragPayload,
  TAB_DRAG_CHIP_TYPE,
  TAB_DRAG_DIRTY_TYPE,
  TAB_DRAG_TYPE,
  WINDOW_INSTANCE_ID,
  type TabDragPayload,
} from "../lib/detachedWindows";
import TabBar, { type DragSource } from "./TabBar";

// Where a tab-drag would land if dropped right now — computed by the
// coordinator's hit-test and consumed both to apply the drop and to render
// this render pass's indicator/overlay. "bar": within some bar's own tab
// strip, at flat position `index` among that bar's tabs (excluding the
// dragged one); indicatorId/indicatorEdge locate the visual insertion line
// (null indicatorId only for a bar with no other tabs). "zone": one of a
// group's content-area 5 zones (VS Code's drop overlay) — center moves the
// tab into that group, an edge splits it.
// "chipBar": a chip drag over some bar's strip, at position `index` among
// that bar's chips (excluding the dragged one) - the only target a chip
// can land on (plans/cross-window-tab-drag.md).
export type DropTarget =
  | { kind: "bar"; groupId: string; index: number; indicatorId: string | null; indicatorEdge: "left" | "right" }
  | { kind: "zone"; groupId: string; zone: "center" | "left" | "right" | "top" | "bottom" }
  | { kind: "chipBar"; groupId: string; index: number; indicatorKey: string | null; indicatorEdge: "left" | "right" };

// What the source window learns when its native drag ends, before deciding
// between "taken by another window", "cancelled" and "torn off".
export interface NativeDragEndInfo {
  handledLocally: boolean;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

interface SharedProps {
  tabs: Tab[];
  activeGroupId: string;
  groupActive: Record<string, string | null>;
  label: (tab: Tab) => string;
  activity: (tab: Tab) => boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  // sourceId (optional) tags who opened this menu — only the tab-group
  // chip's windows-dropdown trigger sets it, so it can tell whether its own
  // menu is the one currently open (see activeMenuSourceId/onCloseMenu).
  onShowMenu: (x: number, y: number, items: MenuItem[], sourceId?: string) => void;
  // The currently open menu's sourceId, or null if none/untagged — lets the
  // chip arrow button (TabBar) decide whether a click should toggle its own
  // menu closed instead of reopening it.
  activeMenuSourceId: string | null;
  onCloseMenu: () => void;
  tabMenuItems: (tab: Tab) => MenuItem[];
  // The tab bar's own empty-space menu. Editor group id first, like
  // groupMenuItems below: its items act on the pane that was clicked.
  tabBarMenuItems: (editorGroupId: string) => MenuItem[];
  onToggleSidebar: () => void;
  groupingEnabled: boolean;
  groupKey: (tab: Tab) => string | null;
  groupLabel: (groupKey: string) => string;
  groupState: Record<string, TabGroupState>;
  // settings.tabBarScope, already forced to "all" by App while grouping is
  // off — every bar shares it, but each resolves its own active project.
  scope: AppSettings["tabBarScope"];
  onToggleGroupCollapsed: (sessionName: string) => void;
  // Editor group id first, like groupMenuItems below: a chip activates a tab
  // in its own pane, never another's.
  onActivateGroup: (editorGroupId: string, sessionName: string) => void;
  // Both take the editor group id first — a session chip's order/position
  // and "Close Group" are scoped to one split pane's own tab bar; Leaf binds
  // its own groupId before handing these to TabBar (see useTabGroups.ts).
  groupMenuItems: (editorGroupId: string, sessionName: string) => MenuItem[];
  // The chip arrow's windows dropdown. Takes the editor group id first, like
  // groupMenuItems above, since a window's "checked" state means "already
  // open as a tab in this pane" (see App.tsx's chipWindowMenuItems) — the
  // window data itself is the same regardless of which pane's chip is
  // clicked, but which ones are open as tabs is scoped per pane.
  windowMenuItems: (editorGroupId: string, sessionName: string) => MenuItem[];
  onReorderGroup: (editorGroupId: string, groupKey: string, toIndex: number) => void;
  // Chrome-style "+" in the tab strip — takes the editor group id, like
  // groupMenuItems/windowMenuItems above, so each pane's button creates a
  // window in that pane's own last-active session. Null hides the button
  // (App.tsx passes null when no sessions exist).
  onNewWindow: ((editorGroupId: string) => void) | null;
  onFocusGroup: (groupId: string) => void;
  actionsRefFor: (groupId: string) => (el: HTMLDivElement | null) => void;
  // Extension window-action buttons for this group's own active tab (e.g. a
  // "Preview Claude session" icon) — rendered in the bar's extras slot,
  // ahead of actionsRefFor's portal target. See App.tsx's tabExtrasFor.
  tabExtrasFor: (groupId: string) => ReactNode;
  // A leaf's content is NOT rendered here — App.tsx portals each tab's actual
  // content component into this slot from a flat, never-reshaping list (see
  // App.tsx's groupContentEls). Rendering content directly inside the
  // recursive Leaf/Branch tree would remount it (WS reconnect, lost
  // in-memory edits) the moment the tree's shape changes — e.g. a group's
  // very first split turns a leaf into a branch at that same tree position,
  // which changes the rendered element TYPE there and forces React to tear
  // down and rebuild the whole subtree, since keys can't rescue a reused
  // component across a parent type change.
  contentSlotRefFor: (groupId: string) => (el: HTMLDivElement | null) => void;
  // A branch's own sash drag/double-click reports the new sizes for the
  // branch it belongs to, addressed by the sequence of child indices from
  // the root (lib/splits.ts's setBranchSizes contract).
  onResizeBranch: (path: number[], sizes: number[]) => void;
  // Tab-drag coordinator state, computed once at the SplitLayout root (a
  // drag can cross between bars) and threaded down so every Leaf can derive
  // its own slice: which tab (if any) is mid-drag, where it would land, and
  // the raw pointer-down reporter each bar's TabBar calls into.
  dragTabId: string | null;
  dropTarget: DropTarget | null;
  onTabPointerDown: (e: React.PointerEvent, tabId: string, sourceGroupId: string) => void;
  tabJustDraggedRef: React.MutableRefObject<boolean>;
  // Native drag and drop for the mouse (plans/cross-window-tab-drag.md) -
  // the coordinator's, threaded to every bar like the pointer state above.
  nativeDrag: boolean;
  nativeDragGroupKey: string | null;
  onDragSourceStart: (e: React.DragEvent, source: DragSource, sourceGroupId: string) => void;
  onDragSourceEnd: (e: React.DragEvent, source: DragSource, sourceGroupId: string) => void;
}

interface CoordinatorProps {
  onReorder: (draggedId: string, toIndex: number) => void;
  onMoveTabToGroup: (tabId: string, targetGroupId: string, index?: number) => void;
  onSplitAndMoveTab: (targetGroupId: string, direction: SplitDirection, tabId: string) => void;
  // Builds the payload a native drag carries (App knows the tabs, the pane
  // size and which tabs have unsaved changes).
  dragPayloadFor: (source: DragSource, editorGroupId: string) => { payload: TabDragPayload; dirty: boolean };
  // A drop from another window landed here.
  onForeignDrop: (payload: TabDragPayload, target: DropTarget) => void;
  // This window's own native drag ended somewhere (maybe in another window).
  onNativeDragEnd: (payload: TabDragPayload, info: NativeDragEndInfo) => void;
}

interface Props
  extends Omit<
      SharedProps,
      | "dragTabId"
      | "dropTarget"
      | "onTabPointerDown"
      | "tabJustDraggedRef"
      | "nativeDragGroupKey"
      | "onDragSourceStart"
      | "onDragSourceEnd"
    >,
    CoordinatorProps {
  tree: SplitNode;
}

const FLEX_MIN: CSSProperties = { minWidth: 0, minHeight: 0 };
// Matches Sidebar.tsx's MIN_PANEL_HEIGHT — a sash can't shrink either
// neighbor below this, in either orientation.
const MIN_LEAF_PX = 120;
// Long-press delay (touch/pen) before a hold starts a tab drag.
const LONG_PRESS_MS = 300;
const MOVE_SLOP_PX = 8;
const MOUSE_DRAG_THRESHOLD_PX = 5;
// Fraction of a group's content area, from each edge, that counts as a
// split zone rather than the center "move here" zone — VS Code's own drop
// overlay proportions.
const EDGE_ZONE_FRACTION = 0.3;

function Leaf({
  groupId,
  flexStyle,
  innerRef,
  tabs,
  activeGroupId,
  groupActive,
  label,
  activity,
  onActivate,
  onClose,
  onShowMenu,
  activeMenuSourceId,
  onCloseMenu,
  tabMenuItems,
  tabBarMenuItems,
  onToggleSidebar,
  groupingEnabled,
  groupKey,
  groupLabel,
  groupState,
  scope,
  onToggleGroupCollapsed,
  onActivateGroup,
  groupMenuItems,
  windowMenuItems,
  onReorderGroup,
  onNewWindow,
  onFocusGroup,
  actionsRefFor,
  tabExtrasFor,
  contentSlotRefFor,
  dragTabId,
  dropTarget,
  onTabPointerDown,
  tabJustDraggedRef,
  nativeDrag,
  nativeDragGroupKey,
  onDragSourceStart,
  onDragSourceEnd,
}: SharedProps & { groupId: string; flexStyle: CSSProperties; innerRef: (el: HTMLDivElement | null) => void }) {
  // Memoized so a re-render that leaves `tabs` referentially unchanged (e.g.
  // the 3s session poll, which always swaps in a fresh `sessions` array even
  // when nothing relevant changed) doesn't hand TabBar a new-but-equal
  // array — that was resetting its own scrollIntoView effect (keyed on
  // `tabs`) and snapping a mid-scroll tab strip back to the active tab.
  const groupTabs = useMemo(() => tabs.filter((t) => t.groupId === groupId), [tabs, groupId]);
  const dropIndicator =
    dropTarget?.kind === "bar" && dropTarget.groupId === groupId && dropTarget.indicatorId
      ? { id: dropTarget.indicatorId, edge: dropTarget.indicatorEdge }
      : null;
  const chipDropIndicator =
    dropTarget?.kind === "chipBar" && dropTarget.groupId === groupId && dropTarget.indicatorKey
      ? { id: dropTarget.indicatorKey, edge: dropTarget.indicatorEdge }
      : null;
  return (
    <div
      ref={innerRef}
      data-group-id={groupId}
      className={`split-leaf${groupId === activeGroupId ? "" : " split-leaf-inactive"}`}
      style={{ ...flexStyle, ...FLEX_MIN }}
      onPointerDownCapture={() => onFocusGroup(groupId)}
    >
      <TabBar
        tabs={groupTabs}
        activeTabId={groupActive[groupId] ?? null}
        label={label}
        activity={activity}
        onActivate={onActivate}
        onClose={onClose}
        onShowMenu={onShowMenu}
        activeMenuSourceId={activeMenuSourceId}
        onCloseMenu={onCloseMenu}
        editorGroupId={groupId}
        tabMenuItems={tabMenuItems}
        barMenuItems={() => tabBarMenuItems(groupId)}
        actionsRef={actionsRefFor(groupId)}
        extras={tabExtrasFor(groupId)}
        onToggleSidebar={onToggleSidebar}
        groupingEnabled={groupingEnabled}
        groupKey={groupKey}
        groupLabel={groupLabel}
        groupState={groupState}
        scope={scope}
        onToggleGroupCollapsed={onToggleGroupCollapsed}
        onActivateGroup={(sessionName) => onActivateGroup(groupId, sessionName)}
        groupMenuItems={(sessionName) => groupMenuItems(groupId, sessionName)}
        windowMenuItems={(sessionName) => windowMenuItems(groupId, sessionName)}
        onReorderGroup={(sessionKey, toIndex) => onReorderGroup(groupId, sessionKey, toIndex)}
        onNewWindow={onNewWindow ? () => onNewWindow(groupId) : null}
        dragTabId={dragTabId}
        dropIndicator={dropIndicator}
        onTabPointerDown={(e, tabId) => onTabPointerDown(e, tabId, groupId)}
        tabJustDraggedRef={tabJustDraggedRef}
        nativeDrag={nativeDrag}
        chipDropIndicator={chipDropIndicator}
        nativeDragGroupKey={nativeDragGroupKey}
        onDragSourceStart={(e, source) => onDragSourceStart(e, source, groupId)}
        onDragSourceEnd={(e, source) => onDragSourceEnd(e, source, groupId)}
      />
      <div className="split-leaf-content" ref={contentSlotRefFor(groupId)} />
    </div>
  );
}

function Branch({
  node,
  flexStyle,
  path,
  innerRef,
  ...shared
}: SharedProps & { node: BranchNode; flexStyle: CSSProperties; path: number[]; innerRef: (el: HTMLDivElement | null) => void }) {
  const childRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const isRow = node.orientation === "row";

  const handleSashPointerDown = (e: React.PointerEvent, index: number) => {
    e.preventDefault();
    const leftEl = childRefs.current.get(index);
    const rightEl = childRefs.current.get(index + 1);
    if (!leftEl || !rightEl) return;
    const sashEl = e.currentTarget as HTMLDivElement;
    const leftRect = leftEl.getBoundingClientRect();
    const rightRect = rightEl.getBoundingClientRect();
    const leftPx0 = isRow ? leftRect.width : leftRect.height;
    const rightPx0 = isRow ? rightRect.width : rightRect.height;
    const totalPx = leftPx0 + rightPx0;
    const totalWeight = node.sizes[index] + node.sizes[index + 1];
    const startPos = isRow ? e.clientX : e.clientY;

    const onMove = (ev: PointerEvent) => {
      const delta = (isRow ? ev.clientX : ev.clientY) - startPos;
      const leftPx = Math.max(MIN_LEAF_PX, Math.min(totalPx - MIN_LEAF_PX, leftPx0 + delta));
      const rightPx = totalPx - leftPx;
      const newSizes = [...node.sizes];
      newSizes[index] = (leftPx / totalPx) * totalWeight;
      newSizes[index + 1] = (rightPx / totalPx) * totalWeight;
      shared.onResizeBranch(path, newSizes);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      sashEl.classList.remove("dragging");
      document.body.classList.remove("resizing");
      document.body.style.cursor = "";
    };
    sashEl.classList.add("dragging");
    document.body.classList.add("resizing");
    document.body.style.cursor = isRow ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleSashDoubleClick = (index: number) => {
    const totalWeight = node.sizes[index] + node.sizes[index + 1];
    const newSizes = [...node.sizes];
    newSizes[index] = totalWeight / 2;
    newSizes[index + 1] = totalWeight / 2;
    shared.onResizeBranch(path, newSizes);
  };

  const nodes: ReactNode[] = [];
  node.children.forEach((child, i) => {
    const childPath = [...path, i];
    const setChildRef = (el: HTMLDivElement | null) => {
      if (el) childRefs.current.set(i, el);
      else childRefs.current.delete(i);
    };
    nodes.push(
      <RenderNode
        key={child.type === "leaf" ? child.groupId : childPath.join(".")}
        node={child}
        flexStyle={{ flex: `${node.sizes[i]} 1 0` }}
        path={childPath}
        innerRef={setChildRef}
        {...shared}
      />,
    );
    if (i < node.children.length - 1) {
      nodes.push(
        <div
          key={`sash-${i}`}
          className={`split-sash ${isRow ? "split-sash-row" : "split-sash-column"}`}
          onPointerDown={(e) => handleSashPointerDown(e, i)}
          onDoubleClick={() => handleSashDoubleClick(i)}
        />,
      );
    }
  });

  return (
    <div
      ref={innerRef}
      className="split-branch"
      style={{ ...flexStyle, ...FLEX_MIN, display: "flex", flexDirection: isRow ? "row" : "column" }}
    >
      {nodes}
    </div>
  );
}

function RenderNode({
  node,
  flexStyle,
  path,
  innerRef,
  ...shared
}: SharedProps & { node: SplitNode; flexStyle: CSSProperties; path: number[]; innerRef: (el: HTMLDivElement | null) => void }) {
  if (node.type === "leaf") {
    return <Leaf groupId={node.groupId} flexStyle={flexStyle} innerRef={innerRef} {...shared} />;
  }
  return <Branch node={node} flexStyle={flexStyle} path={path} innerRef={innerRef} {...shared} />;
}

// Hit-tests the viewport point against the rendered DOM directly (rather
// than maintaining a parallel ref registry across every bar) — a tab strip
// hit yields a "bar" target (position among that bar's own tabs, excluding
// the dragged one); a leaf's content area otherwise yields a "zone" target
// from its 5-way split (center/left/right/top/bottom). Returns null over
// anything else (sidebar, no leaf at all).
function hitTest(clientX: number, clientY: number, draggedTabId: string): DropTarget | null {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const stripEl = el.closest<HTMLElement>(".tab-strip");
  if (stripEl) {
    const leafEl = stripEl.closest<HTMLElement>(".split-leaf");
    const groupId = leafEl?.dataset.groupId;
    if (!groupId) return null;
    const tabEls = Array.from(stripEl.querySelectorAll<HTMLElement>(".tab")).filter(
      (t) => t.dataset.tabId !== draggedTabId,
    );
    if (tabEls.length === 0) {
      return { kind: "bar", groupId, index: 0, indicatorId: null, indicatorEdge: "left" };
    }
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      const id = tabEls[i].dataset.tabId!;
      if (clientX < rect.left + rect.width / 2) {
        return { kind: "bar", groupId, index: i, indicatorId: id, indicatorEdge: "left" };
      }
      if (clientX < rect.right) {
        return { kind: "bar", groupId, index: i + 1, indicatorId: id, indicatorEdge: "right" };
      }
    }
    const last = tabEls[tabEls.length - 1];
    return { kind: "bar", groupId, index: tabEls.length, indicatorId: last.dataset.tabId!, indicatorEdge: "right" };
  }
  const leafEl = el.closest<HTMLElement>(".split-leaf");
  if (!leafEl) return null;
  const groupId = leafEl.dataset.groupId;
  if (!groupId) return null;
  const contentEl = leafEl.querySelector<HTMLElement>(".split-leaf-content") ?? leafEl;
  const rect = contentEl.getBoundingClientRect();
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  if (relX < EDGE_ZONE_FRACTION) return { kind: "zone", groupId, zone: "left" };
  if (relX > 1 - EDGE_ZONE_FRACTION) return { kind: "zone", groupId, zone: "right" };
  if (relY < EDGE_ZONE_FRACTION) return { kind: "zone", groupId, zone: "top" };
  if (relY > 1 - EDGE_ZONE_FRACTION) return { kind: "zone", groupId, zone: "bottom" };
  return { kind: "zone", groupId, zone: "center" };
}

// The chip counterpart of hitTest: a position among the chips of the strip
// under the point (excluding the dragged chip's own key), null anywhere
// else - a chip never lands on a pane zone.
function hitTestChip(clientX: number, clientY: number, draggedKey: string | null): DropTarget | null {
  const el = document.elementFromPoint(clientX, clientY);
  const stripEl = el?.closest<HTMLElement>(".tab-strip");
  if (!stripEl) return null;
  const groupId = stripEl.closest<HTMLElement>(".split-leaf")?.dataset.groupId;
  if (!groupId) return null;
  const chipEls = Array.from(stripEl.querySelectorAll<HTMLElement>(".tab-group-chip")).filter(
    (c) => c.dataset.groupKey !== draggedKey,
  );
  if (chipEls.length === 0) return { kind: "chipBar", groupId, index: 0, indicatorKey: null, indicatorEdge: "left" };
  for (let i = 0; i < chipEls.length; i++) {
    const rect = chipEls[i].getBoundingClientRect();
    const key = chipEls[i].dataset.groupKey!;
    if (clientX < rect.left + rect.width / 2) {
      return { kind: "chipBar", groupId, index: i, indicatorKey: key, indicatorEdge: "left" };
    }
    if (clientX < rect.right) {
      return { kind: "chipBar", groupId, index: i + 1, indicatorKey: key, indicatorEdge: "right" };
    }
  }
  const last = chipEls[chipEls.length - 1];
  return { kind: "chipBar", groupId, index: chipEls.length, indicatorKey: last.dataset.groupKey!, indicatorEdge: "right" };
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A hovering drag keeps firing dragover on the window under it - about
// every 350 ms while the pointer is still (the spec's cadence), faster while
// it moves. Silence this long means the drag left or ended elsewhere, since
// no event tells a window that; QA showed 250 ms clears a still pointer's
// indicator.
const DRAGOVER_SILENCE_MS = 700;

const ZONE_DIRECTION: Record<"left" | "right" | "top" | "bottom", SplitDirection> = {
  left: "left",
  right: "right",
  top: "up",
  bottom: "down",
};

export default function SplitLayout({
  tree,
  onReorder,
  onMoveTabToGroup,
  onSplitAndMoveTab,
  dragPayloadFor,
  onForeignDrop,
  onNativeDragEnd,
  ...shared
}: Props) {
  const dragSessionRef = useRef<{
    tabId: string;
    sourceGroupId: string;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    dragging: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const tabJustDraggedRef = useRef(false);

  const applyDrop = (tabId: string, sourceGroupId: string, target: DropTarget) => {
    if (target.kind === "bar") {
      if (target.groupId === sourceGroupId) onReorder(tabId, target.index);
      else onMoveTabToGroup(tabId, target.groupId, target.index);
      return;
    }
    // A chip target never applies to a single tab (see hitTestChip).
    if (target.kind === "chipBar") return;
    if (target.zone === "center") {
      if (target.groupId === sourceGroupId) return;
      onMoveTabToGroup(tabId, target.groupId);
      return;
    }
    onSplitAndMoveTab(target.groupId, ZONE_DIRECTION[target.zone], tabId);
  };

  const endDragSession = () => {
    const session = dragSessionRef.current;
    if (session?.longPressTimer) clearTimeout(session.longPressTimer);
    dragSessionRef.current = null;
    setDragTabId(null);
    setDropTarget(null);
    document.body.classList.remove("tab-dragging");
  };

  const startDragTab = () => {
    const session = dragSessionRef.current;
    if (!session || session.dragging) return;
    session.dragging = true;
    setDragTabId(session.tabId);
    // App.tsx's content hosts are DOM siblings of this tree (not descendants
    // of .split-leaf), painted on top of it — without this, hitTest's
    // elementFromPoint would hit a pane's rendered terminal/viewer instead of
    // the .split-leaf underneath it, and every drop zone over actual content
    // (i.e. most of a pane) would silently miss.
    document.body.classList.add("tab-dragging");
  };

  const onPointerMoveWindow = (e: PointerEvent) => {
    const session = dragSessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    const dx = e.clientX - session.startX;
    const dy = e.clientY - session.startY;
    if (!session.dragging) {
      if (session.pointerType === "mouse") {
        if (Math.hypot(dx, dy) >= MOUSE_DRAG_THRESHOLD_PX) startDragTab();
        else return;
      } else {
        if (Math.hypot(dx, dy) >= MOVE_SLOP_PX) {
          endDragSession();
          return;
        }
        return;
      }
    }
    setDropTarget(hitTest(e.clientX, e.clientY, session.tabId));
  };

  const onPointerUpWindow = (e: PointerEvent) => {
    const session = dragSessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    window.removeEventListener("pointermove", onPointerMoveWindow);
    window.removeEventListener("pointerup", onPointerUpWindow);
    window.removeEventListener("pointercancel", onPointerCancelWindow);
    if (session.dragging) {
      tabJustDraggedRef.current = true;
      const target = hitTest(e.clientX, e.clientY, session.tabId);
      if (target) applyDrop(session.tabId, session.sourceGroupId, target);
    }
    endDragSession();
  };

  const onPointerCancelWindow = (e: PointerEvent) => {
    const session = dragSessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    window.removeEventListener("pointermove", onPointerMoveWindow);
    window.removeEventListener("pointerup", onPointerUpWindow);
    window.removeEventListener("pointercancel", onPointerCancelWindow);
    endDragSession();
  };

  const handleTabPointerDown = (e: React.PointerEvent, tabId: string, sourceGroupId: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".tab-close")) return;

    dragSessionRef.current = {
      tabId,
      sourceGroupId,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      longPressTimer: null,
    };

    if (e.pointerType !== "mouse") {
      dragSessionRef.current.longPressTimer = setTimeout(() => {
        if (dragSessionRef.current?.tabId === tabId) startDragTab();
      }, LONG_PRESS_MS);
    }

    window.addEventListener("pointermove", onPointerMoveWindow);
    window.addEventListener("pointerup", onPointerUpWindow);
    window.addEventListener("pointercancel", onPointerCancelWindow);
  };

  // Safety net: if SplitLayout unmounts mid-drag, tear down window listeners
  // directly (no setState — the component is gone).
  useEffect(() => {
    return () => {
      const session = dragSessionRef.current;
      if (!session) return;
      if (session.longPressTimer) clearTimeout(session.longPressTimer);
      window.removeEventListener("pointermove", onPointerMoveWindow);
      window.removeEventListener("pointerup", onPointerUpWindow);
      window.removeEventListener("pointercancel", onPointerCancelWindow);
      dragSessionRef.current = null;
      document.body.classList.remove("tab-dragging");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Native drag and drop (mouse) ----------------------------------------
  // The source side: what this window's own drag carries, its pane, and
  // whether the drop was already applied here (an in-window drop).
  const nativeRef = useRef<{ payload: TabDragPayload; sourceGroupId: string; handledLocally: boolean } | null>(null);
  const [nativeDragGroupKey, setNativeDragGroupKey] = useState<string | null>(null);
  // Latest callbacks for the document listeners below, which subscribe once.
  const latestRef = useRef({ applyDrop, onForeignDrop, onReorderGroup: shared.onReorderGroup });
  latestRef.current = { applyDrop, onForeignDrop, onReorderGroup: shared.onReorderGroup };

  const handleDragSourceStart = (e: React.DragEvent, source: DragSource, sourceGroupId: string) => {
    const { payload, dirty } = dragPayloadFor(source, sourceGroupId);
    e.dataTransfer.setData(TAB_DRAG_TYPE, encodeDragPayload(payload));
    if (dirty) e.dataTransfer.setData(TAB_DRAG_DIRTY_TYPE, "1");
    if (payload.kind === "chip") e.dataTransfer.setData(TAB_DRAG_CHIP_TYPE, "1");
    e.dataTransfer.effectAllowed = "move";
    nativeRef.current = { payload, sourceGroupId, handledLocally: false };
    if (source.kind === "tab") setDragTabId(source.tabId);
    else setNativeDragGroupKey(source.groupKey);
    document.body.classList.add("tab-dragging");
  };

  const handleDragSourceEnd = (e: React.DragEvent, source: DragSource) => {
    const local = nativeRef.current;
    nativeRef.current = null;
    setDragTabId(null);
    setNativeDragGroupKey(null);
    setDropTarget(null);
    document.body.classList.remove("tab-dragging");
    if (!local) return;
    if (source.kind === "tab") tabJustDraggedRef.current = true;
    onNativeDragEnd(local.payload, {
      handledLocally: local.handledLocally,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
    });
  };

  useEffect(() => {
    if (!shared.nativeDrag) return;
    let silence: number | null = null;
    const clearTarget = () => {
      setDropTarget(null);
      // The body class belongs to the source while its drag lasts.
      if (!nativeRef.current) document.body.classList.remove("tab-dragging");
    };
    const armSilence = () => {
      if (silence !== null) window.clearTimeout(silence);
      silence = window.setTimeout(clearTarget, DRAGOVER_SILENCE_MS);
    };
    const targetFor = (e: DragEvent, chip: boolean): DropTarget | null => {
      const local = nativeRef.current;
      if (chip) {
        const key = local?.payload.kind === "chip" ? (local.payload.groupKey ?? null) : null;
        const t = hitTestChip(e.clientX, e.clientY, key);
        // In-window chip drags stay within their own bar, as the touch path does.
        if (local && t && t.groupId !== local.sourceGroupId) return null;
        return t;
      }
      return hitTest(e.clientX, e.clientY, local?.payload.tabs[0]?.id ?? "");
    };
    const onDragOver = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types || !types.includes(TAB_DRAG_TYPE)) return;
      const local = nativeRef.current;
      // An unsaved tab from another window may not land here (spec R9).
      if (!local && types.includes(TAB_DRAG_DIRTY_TYPE)) {
        setDropTarget(null);
        return;
      }
      const chip = local ? local.payload.kind === "chip" : types.includes(TAB_DRAG_CHIP_TYPE);
      // Before hit-testing: the class lifts the content hosts out of
      // elementFromPoint's way (see startDragTab), and a foreign drag has no
      // dragstart here to have set it. The silence timer takes it back.
      document.body.classList.add("tab-dragging");
      const target = targetFor(e, chip);
      if (target) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
      }
      setDropTarget((prev) => (sameTarget(prev, target) ? prev : target));
      armSilence();
    };
    const onDrop = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(TAB_DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      if (silence !== null) window.clearTimeout(silence);
      const payload = decodeDragPayload(raw);
      const local = nativeRef.current;
      const target = payload ? targetFor(e, payload.kind === "chip") : null;
      if (payload && target) {
        if (payload.windowId === WINDOW_INSTANCE_ID && local) {
          if (payload.kind === "chip") {
            if (target.kind === "chipBar" && payload.groupKey !== undefined) {
              latestRef.current.onReorderGroup(target.groupId, payload.groupKey, target.index);
            }
          } else if (target.kind !== "chipBar") {
            latestRef.current.applyDrop(payload.tabs[0].id, local.sourceGroupId, target);
          }
          local.handledLocally = true;
        } else if (payload.windowId !== WINDOW_INSTANCE_ID) {
          latestRef.current.onForeignDrop(payload, target);
        }
      }
      clearTarget();
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) clearTarget();
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragleave", onDragLeave);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragleave", onDragLeave);
      if (silence !== null) window.clearTimeout(silence);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared.nativeDrag]);

  // The zone overlay's pixel rect is measured (not computed from the
  // fractional tree) since it must line up with the actually-rendered DOM,
  // including any in-progress sash resize.
  const [zoneOverlayRect, setZoneOverlayRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!dropTarget || dropTarget.kind !== "zone") {
      setZoneOverlayRect(null);
      return;
    }
    const contentEl = document.querySelector<HTMLElement>(
      `.split-leaf[data-group-id="${dropTarget.groupId}"] .split-leaf-content`,
    );
    if (!contentEl) {
      setZoneOverlayRect(null);
      return;
    }
    const rect = contentEl.getBoundingClientRect();
    switch (dropTarget.zone) {
      case "center":
        setZoneOverlayRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
        break;
      case "left":
        setZoneOverlayRect({ top: rect.top, left: rect.left, width: rect.width / 2, height: rect.height });
        break;
      case "right":
        setZoneOverlayRect({ top: rect.top, left: rect.left + rect.width / 2, width: rect.width / 2, height: rect.height });
        break;
      case "top":
        setZoneOverlayRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height / 2 });
        break;
      case "bottom":
        setZoneOverlayRect({ top: rect.top + rect.height / 2, left: rect.left, width: rect.width, height: rect.height / 2 });
        break;
    }
  }, [dropTarget]);

  return (
    <>
      <RenderNode
        node={tree}
        flexStyle={{ flex: "1 1 0" }}
        path={[]}
        innerRef={() => {}}
        {...shared}
        dragTabId={dragTabId}
        dropTarget={dropTarget}
        onTabPointerDown={handleTabPointerDown}
        tabJustDraggedRef={tabJustDraggedRef}
        nativeDragGroupKey={nativeDragGroupKey}
        onDragSourceStart={handleDragSourceStart}
        onDragSourceEnd={handleDragSourceEnd}
      />
      {zoneOverlayRect && <div className="split-drop-overlay" style={{ ...zoneOverlayRect, position: "fixed" }} />}
    </>
  );
}
