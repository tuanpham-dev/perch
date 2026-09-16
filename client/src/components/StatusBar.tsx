import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  extensionStatusBarItems,
  useExtensionRegistryVersion,
  type StatusBarItemContext,
} from "../extensions";
import {
  MANAGE_ITEM_ID,
  TERMINALS_ITEM_ID,
  moveStatusBarItem,
  resolveStatusBarLayout,
  type StatusBarLayout,
  type StatusBarSide,
  type StatusBarSlot,
} from "../lib/statusBarLayout";
import { useLongPressMenu } from "../hooks/useLongPressMenu";
import type { MenuItem, TerminalSession } from "../types";
import Icon from "./Icon";
import ProjectList, { type ProjectListProps } from "./ProjectList";
import StatusBarPopover from "./StatusBarPopover";

// The bottom status bar (plans/right-click-sidebars-statusbar.md, extended by
// plans/status-bar-extensions-and-popovers.md): how many terminals are
// open, plus whatever extensions contribute. Host memory and CPU used to be a
// core readout here; they now come from the System Stats registry extension
// (plans/system-stats-extension.md).
//
// The terminal count is derived from the sessions the app already polls, so
// it needs no round-trip and can never disagree with the Explorer tree.
//
// Extension items are read straight from the registry (the TerminalView
// convention) rather than threaded through App as a prop — they are the bar's
// own business, and App's prop surface is wide enough already.
//
// Every item, core or contributed, can be dragged to reorder it or to move it
// between the bar's two groups; lib/statusBarLayout.ts holds that model and
// the arrangement persists in localStorage.
//
// Which items exist and which the user switched off is NOT decided here —
// hooks/useStatusBarLayout.ts owns that, because the same show/hide list hangs
// off the gear menu, which App must be able to build while this bar is turned
// off entirely. So `slots` arrives already filtered and this component renders
// what it's given, holding only the drag in flight.

interface Props {
  sessions: TerminalSession[];
  // The items to render, switched-off ones already removed, and the stored
  // arrangement they're resolved against (useStatusBarLayout).
  slots: StatusBarSlot[];
  layout: StatusBarLayout;
  setLayout: Dispatch<SetStateAction<StatusBarLayout>>;
  // The show/hide rows, for the bar's own right-click and long-press menu.
  widgetMenuItems: () => MenuItem[];
  // Everything ProjectList needs, exactly as the sidebars receive it — the
  // terminals popover is that same list with pinning switched off.
  projectListProps: Omit<ProjectListProps, "projects">;
  showMenu: (x: number, y: number, items: MenuItem[]) => void;
  // The app-wide Manage menu, the same one the sidebar's gear opens.
  manageMenuItems: () => MenuItem[];
  // The app's shared confirm dialog, handed to contributed items for
  // destructive actions (the ports item's Kill process) — the same
  // capability sidebar panels get.
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>;
  mobilePointer: boolean;
}

const MOUSE_DRAG_THRESHOLD_PX = 5;
const TOUCH_SLOP_PX = 8;
const LONG_PRESS_MS = 300;

// A count with its noun, pluralized — "1 terminal", "3 terminals".
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export default function StatusBar({
  sessions,
  slots,
  layout,
  setLayout,
  widgetMenuItems,
  projectListProps,
  showMenu,
  manageMenuItems,
  confirmDialog,
  mobilePointer,
}: Props) {
  // What's in the popover, and where it points. `owner` is the id of whatever
  // opened it, so a second click on the same trigger closes rather than
  // reopens it.
  const [popover, setPopover] = useState<{ owner: string; anchor: DOMRect; content: ReactNode } | null>(
    null,
  );
  // The drag in flight: which item, and where it would land.
  const [drag, setDrag] = useState<{ id: string; side: StatusBarSide; index: number } | null>(null);

  const closePopover = useCallback(() => setPopover(null), []);

  // Opening the same owner twice closes it, so a trigger button toggles.
  const togglePopover = useCallback((owner: string, anchor: DOMRect, content: ReactNode) => {
    setPopover((prev) => (prev?.owner === owner ? null : { owner, anchor, content }));
  }, []);

  useExtensionRegistryVersion();
  const extItems = [...extensionStatusBarItems].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );

  // One context per item, fresh each render (the terminal-accessory
  // contract). Keying openPopover on the item's own id is what makes a
  // second click on the same item close its popover — and, unlike the item
  // tracking that itself, it stays correct when the host closes the popover
  // for its own reasons (Escape, a click outside, a window blur).
  const contextFor = (itemId: string): StatusBarItemContext => ({
    mobilePointer,
    showMenu,
    confirmDialog,
    openPopover: (anchor, content) => togglePopover(itemId, anchor, content),
    closePopover,
  });

  // Windows, not panes: "terminal" everywhere else in this app means a terminal
  // window (the sidebar's rows, "New Terminal", the tab bar), so the count
  // has to mean the same thing here.
  const terminals = sessions.reduce((n, s) => n + s.windows.length, 0);

  // The PROJECTS tree with pinning switched off: `projects` is the only
  // source of both the pin indicator and the "not running" dead rows, so an
  // empty list leaves exactly the live terminals, with every row action the
  // sidebar has (open, kill, rename, menus, keyboard navigation).
  const terminalsContent = useMemo(
    () => (
      <div className="status-bar-popover-list">
        <ProjectList {...projectListProps} projects={[]} />
      </div>
    ),
    [projectListProps],
  );

  const resolved = resolveStatusBarLayout(slots, layout);

  // An open popover whose item is gone (its extension was just disabled or
  // uninstalled, or the user switched the item off) closes with it. The
  // content node the bar captured at click time belongs to that extension,
  // and left mounted it would stay on screen and keep whatever it subscribed
  // to running.
  const liveIds = [...resolved.left, ...resolved.right].join("\n");
  useEffect(() => {
    if (popover && !liveIds.split("\n").includes(popover.owner)) setPopover(null);
  }, [popover, liveIds]);

  const renderItem = (id: string): ReactNode => {
    if (id === TERMINALS_ITEM_ID) {
      return (
        <button
          className="status-bar-item"
          data-menu-trigger="true"
          aria-haspopup="dialog"
          aria-expanded={popover?.owner === TERMINALS_ITEM_ID}
          title={`${plural(terminals, "terminal")} open across every project`}
          onClick={(e) =>
            togglePopover(TERMINALS_ITEM_ID, e.currentTarget.getBoundingClientRect(), terminalsContent)
          }
        >
          <Icon name="terminal" />
          <span>{terminals}</span>
        </button>
      );
    }
    if (id === MANAGE_ITEM_ID) {
      return (
        <button
          className="status-bar-item"
          data-menu-trigger="true"
          aria-haspopup="menu"
          title="Manage"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            // showMenu clamps into the viewport, so anchoring at the
            // button's top edge makes the menu open upward off the bar.
            showMenu(rect.left, rect.top, manageMenuItems());
          }}
        >
          <Icon name="gear" />
        </button>
      );
    }
    const item = extItems.find((i) => i.id === id);
    if (!item) return null;
    return <item.component context={contextFor(item.id)} />;
  };

  // ---- Drag to reorder ----
  //
  // Pointer-based, like every other drag in this app (the sidebar tab strip,
  // the tab bar's group chips): a small movement threshold on mouse, a
  // long-press on touch, and a DOM hit test so a drag can end in the OTHER
  // group. Bar items are ordinary buttons, so the drag also has to swallow
  // the click the browser fires after the drop.
  const sessionRef = useRef<{
    pointerId: number;
    id: string;
    pointerType: string;
    startX: number;
    startY: number;
    dragging: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    drop: { side: StatusBarSide; index: number } | null;
    // A touch that moved before the long press fired is scrolling its group
    // by hand: the slot's touch-action: none (styles.css) keeps the browser
    // from doing it.
    scrolling: boolean;
    group: HTMLElement | null;
    lastX: number;
  } | null>(null);
  const justDraggedRef = useRef(false);
  const barRef = useRef<HTMLElement | null>(null);
  // Read inside the window listeners, which are registered per gesture and
  // would otherwise close over a stale render's value.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  const hitTest = (clientX: number, clientY: number, draggedId: string) => {
    const el = document.elementFromPoint(clientX, clientY);
    const group = el?.closest<HTMLElement>(".status-bar-group[data-side]");
    if (!group) return null;
    const side: StatusBarSide = group.dataset.side === "left" ? "left" : "right";
    const others = [...group.querySelectorAll<HTMLElement>("[data-item-id]")].filter(
      (n) => n.dataset.itemId !== draggedId,
    );
    let index = others.length;
    for (let i = 0; i < others.length; i++) {
      const rect = others[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        index = i;
        break;
      }
    }
    return { side, index };
  };

  const removeWindowListeners = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
  };

  // Every way a gesture can end comes through here, listeners included: the
  // touch-slop path below abandons the session without a pointerup of its
  // own, and the pointerup that eventually arrives finds no session and
  // returns before it could have cleaned up.
  const endSession = () => {
    const s = sessionRef.current;
    if (s?.longPressTimer) clearTimeout(s.longPressTimer);
    sessionRef.current = null;
    removeWindowListeners();
    document.body.classList.remove("status-bar-dragging");
    setDrag(null);
  };

  const onPointerMove = (e: PointerEvent) => {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    if (!s.dragging) {
      const moved = Math.hypot(e.clientX - s.startX, e.clientY - s.startY);
      if (s.pointerType === "mouse") {
        if (moved < MOUSE_DRAG_THRESHOLD_PX) return;
        s.dragging = true;
        document.body.classList.add("status-bar-dragging");
      } else if (s.scrolling) {
        if (s.group) s.group.scrollLeft -= e.clientX - s.lastX;
        s.lastX = e.clientX;
        return;
      } else {
        // Touch: movement before the long-press fires belongs to a scroll,
        // not to a drag.
        if (moved >= TOUCH_SLOP_PX) {
          if (s.longPressTimer) clearTimeout(s.longPressTimer);
          s.longPressTimer = null;
          s.scrolling = true;
          s.lastX = e.clientX;
        }
        return;
      }
    }
    const hit = hitTest(e.clientX, e.clientY, s.id);
    if (!hit) return;
    s.drop = hit;
    setDrag({ id: s.id, side: hit.side, index: hit.index });
  };

  const onPointerUp = (e: PointerEvent) => {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    if (s.dragging && s.drop) {
      justDraggedRef.current = true;
      const { side, index } = s.drop;
      setLayout((prev) => moveStatusBarItem(prev, resolvedRef.current, s.id, side, index));
    }
    endSession();
  };

  const onPointerCancel = (e: PointerEvent) => {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    endSession();
  };

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    sessionRef.current = {
      pointerId: e.pointerId,
      id,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      longPressTimer: null,
      drop: null,
      scrolling: false,
      group: e.currentTarget.closest<HTMLElement>(".status-bar-group"),
      lastX: e.clientX,
    };
    if (e.pointerType !== "mouse") {
      sessionRef.current.longPressTimer = setTimeout(() => {
        const s = sessionRef.current;
        if (s?.id !== id) return;
        s.dragging = true;
        document.body.classList.add("status-bar-dragging");
      }, LONG_PRESS_MS);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  // ---- The show/hide list ----
  //
  // Two ways in, because the bar has two kinds of pointer. A mouse
  // right-clicks anywhere on it, item or gap. A finger long-presses a GAP:
  // long-pressing an item is already taken, it picks the item up to drag, so
  // the empty stretch either side of the groups is the only gesture left.
  // What opened the menu, read by the contextmenu handler — which carries no
  // pointer type of its own. "mouse" to begin with, so the keyboard's own
  // context-menu key (no pointer event at all) still opens the list.
  const lastPointerTypeRef = useRef("mouse");

  // The app's shared long-press idiom, which also swallows the click the
  // release synthesizes. That matters more here than anywhere else: the menu
  // opens UNDER the finger, so an unswallowed click would land on whichever
  // row happens to sit there and toggle it.
  const bindLongPress = useLongPressMenu();
  const barLongPress = bindLongPress((x, y) => showMenu(x, y, widgetMenuItems()));

  const onBarPointerDown = (e: React.PointerEvent) => {
    lastPointerTypeRef.current = e.pointerType;
    // A press on an item belongs to that item: long-pressing one picks it up
    // to drag. Only the empty stretch either side opens the list.
    if ((e.target as Element | null)?.closest(".status-bar-slot")) return;
    barLongPress.onPointerDown(e);
  };

  // Always prevented, even for touch: Android fires this off its own
  // long-press, which would otherwise open a second menu on top of the one
  // the timer above already opened — and fire it over an item, where the
  // gesture means "drag".
  const onBarContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (lastPointerTypeRef.current !== "mouse") return;
    showMenu(e.clientX, e.clientY, widgetMenuItems());
  };

  // A drag ends on the item itself, so the browser fires a click afterwards —
  // swallow exactly that one, or a drop would also open a popover.
  const onClickCapture = (e: React.MouseEvent) => {
    if (!justDraggedRef.current) return;
    justDraggedRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // A plain (unshifted) mouse wheel scrolls an overflowing group sideways,
  // not just Shift+wheel (the browser's native horizontal-scroll gesture).
  // Native (non-passive) listener, as in TabBar: React's onWheel can't
  // preventDefault a scroll that's already begun.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || e.deltaY === 0) return;
      const group = (e.target as Element | null)?.closest<HTMLElement>(".status-bar-group");
      if (!group || group.scrollWidth <= group.clientWidth) return;
      e.preventDefault();
      group.scrollLeft += e.deltaY;
    };
    bar.addEventListener("wheel", onWheel, { passive: false });
    return () => bar.removeEventListener("wheel", onWheel);
  }, []);

  // Safety net for a drag interrupted by an unmount (the setting toggled off
  // mid-drag): the gesture's own pointerup never arrives to clean up.
  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      if (!s) return;
      if (s.longPressTimer) clearTimeout(s.longPressTimer);
      removeWindowListeners();
      sessionRef.current = null;
      document.body.classList.remove("status-bar-dragging");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderGroup = (side: StatusBarSide) => {
    const ids = resolved[side];
    // The dragged item leaves the flow while it moves, and a caret marks
    // where it would land.
    const rest = ids.filter((id) => id !== drag?.id);
    const indicatorAt = drag?.side === side ? Math.min(drag.index, rest.length) : null;
    return (
      <div className="status-bar-group" data-side={side}>
        {rest.map((id, i) => (
          <span key={id} className="status-bar-slot-wrap">
            {indicatorAt === i && <span className="status-bar-drop-indicator" aria-hidden="true" />}
            <span
              className={`status-bar-slot${drag?.id === id ? " dragging" : ""}`}
              data-item-id={id}
              onPointerDown={(e) => onPointerDown(e, id)}
              onClickCapture={onClickCapture}
            >
              {renderItem(id)}
            </span>
          </span>
        ))}
        {indicatorAt !== null && indicatorAt >= rest.length && (
          <span className="status-bar-drop-indicator" aria-hidden="true" />
        )}
        {/* The item being dragged keeps rendering, dimmed, at the end of its
            own group — moving it in the DOM mid-drag would remount it. */}
        {drag && ids.includes(drag.id) && (
          <span className="status-bar-slot dragging" data-item-id={drag.id}>
            {renderItem(drag.id)}
          </span>
        )}
      </div>
    );
  };

  return (
    <footer
      ref={barRef}
      className={`status-bar${mobilePointer ? " compact" : ""}`}
      onPointerDown={onBarPointerDown}
      onPointerMove={barLongPress.onPointerMove}
      onPointerUp={barLongPress.onPointerUp}
      onPointerCancel={barLongPress.onPointerCancel}
      onContextMenu={onBarContextMenu}
    >
      {renderGroup("left")}
      {renderGroup("right")}
      {popover && (
        <StatusBarPopover anchor={popover.anchor} onClose={closePopover}>
          {popover.content}
        </StatusBarPopover>
      )}
    </footer>
  );
}
