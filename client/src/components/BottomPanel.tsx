import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TerminalTheme } from "../engines/types";
import type { Keybinding } from "../keybindings";
import type { AppSettings } from "../settings";
import type { MenuItem, TerminalSession } from "../types";
import type { PanelPane, PanelState, PanelTab } from "../hooks/useBottomPanel";
import { TERMINAL_VIEW_ID, type PanelViewDescriptor } from "../lib/panelViews";
import Icon from "./Icon";
import TerminalView from "./TerminalView";

// The bottom terminal panel's UI (plans/bottom-terminal-panel.md). Unlike the
// editor area — where App.tsx must render every tab's content in a flat,
// fixed-positioned list because SplitLayout's tree reshapes element *types* as
// groups split (see App.tsx's groupContentRects comment) — the panel's DOM
// never reshapes: a tab is always a flex row of panes, and a split only adds a
// keyed child to it. So panes nest directly here, and a split can't remount a
// sibling terminal.
//
// Every tab's panes stay mounted (hidden tabs are display:none rather than
// unrendered), matching how App keeps every editor tab's terminal alive:
// switching panel tabs is instant and scrollback survives.
//
// The header's left end is a row of view tabs (plans/bottom-panel-views.md):
// TERMINAL, core's OUTPUT, and whatever extensions register. The terminal
// strip and its actions show only on TERMINAL; a non-terminal view is the
// ONE mounted `renderView` node, unmounted the moment the user switches away
// — unlike the terminals, which have scrollback worth keeping.

// Matches SplitLayout's own MIN_LEAF_PX — a sash can't shrink either pane
// below this.
const MIN_PANE_PX = 120;

interface Props {
  panel: PanelState;
  // Already ordered (lib/panelViews.ts's orderPanelViews): TERMINAL first,
  // switched-off views left out. `allViews` is the same list with them in,
  // for the header's right-click show/hide menu.
  views: PanelViewDescriptor[];
  allViews: PanelViewDescriptor[];
  hiddenViews: string[];
  onToggleViewHidden: (viewId: string) => void;
  activeView: string;
  onSelectView: (viewId: string) => void;
  // The mounted body for a non-terminal view, by id — App supplies core's
  // OUTPUT and each extension view's component with its context.
  renderView: (viewId: string) => ReactNode;
  maximized: boolean;
  onToggleMaximized: () => void;
  // Terminal tabs with output the user hasn't seen (useBottomPanel).
  unseenOutput: Set<string>;
  onPaneOutput: (tabId: string) => void;
  // The app's shared context menu, for the collapsed strip's tab list.
  showMenu: (x: number, y: number, items: MenuItem[]) => void;
  // The current project's tabs only — drives the tab strip and the empty
  // state. The body below still renders every tab across every project (see
  // the module comment); visibleTabs never needs to reach it directly.
  visibleTabs: PanelTab[];
  // The resolved active tab id for the current project (activeTab's own id,
  // already validated against visibleTabs by useBottomPanel), or null if the
  // current project has no tabs. Distinct from any other project's own
  // remembered active tab, which stays intact but isn't this.
  activeTabId: string | null;
  panelFocused: boolean;
  sessions: TerminalSession[];
  settings: AppSettings;
  theme: TerminalTheme | null;
  fontsVersion: number;
  bindings: Record<string, Keybinding[]>;
  onSelectTab: (tabId: string) => void;
  onSelectPane: (tabId: string, paneId: string) => void;
  onCloseTab: (tabId: string) => void;
  onResizePanes: (tabId: string, sizes: number[]) => void;
  // Pane exited on its own (shell exit / window killed) — no detach needed.
  onPaneExit: (tabId: string, paneId: string) => void;
  // Resolves the target session (active session, or a picker when there is
  // none) and opens a terminal — implemented in App, anchored at the + button.
  onRequestTerminal: (anchor: { x: number; y: number }) => void;
  // Lists existing windows not open anywhere (editor tabs or panel) and
  // attaches the pick as a panel tab — implemented in App, anchored at the
  // dropdown button.
  onRequestAttachWindow: (anchor: { x: number; y: number }) => void;
  onSplit: () => void;
  onHide: () => void;
  onSetHeight: (height: number) => void;
  onError: (err: unknown) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFileSecondary: (path: string, line?: number) => void;
  // A window switch made inside the terminal itself: the server already reverted the pane's
  // synthetic session to its pin, so the pane snaps back to its own window —
  // surface whatever the user picked in the *editor* area instead.
  onWindowSwitch: (session: string, windowIndex: number) => void;
  onSessionSwitch: (session: string, windowIndex: number) => void;
}

export default function BottomPanel({
  panel,
  views,
  allViews,
  hiddenViews,
  onToggleViewHidden,
  activeView,
  onSelectView,
  renderView,
  maximized,
  onToggleMaximized,
  unseenOutput,
  onPaneOutput,
  showMenu,
  visibleTabs,
  activeTabId,
  panelFocused,
  sessions,
  settings,
  theme,
  fontsVersion,
  bindings,
  onSelectTab,
  onSelectPane,
  onCloseTab,
  onResizePanes,
  onPaneExit,
  onRequestTerminal,
  onRequestAttachWindow,
  onSplit,
  onHide,
  onSetHeight,
  onError,
  onOpenFile,
  onOpenFileSecondary,
  onWindowSwitch,
  onSessionSwitch,
}: Props) {
  const paneRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const terminalActive = activeView === TERMINAL_VIEW_ID;

  // Whether the strip's tabs fit. Measured off the strip itself, which stays
  // in the row even while collapsed (styles.css's .tab-strip.collapsed keeps
  // its width and zeroes its height), so the same comparison also says when
  // the tabs fit again. Re-checked on every render — a tab added or renamed
  // changes scrollWidth without any resize — and on the strip's resize.
  const [overflowing, setOverflowing] = useState(false);
  const measureOverflow = () => {
    const el = tabStripRef.current;
    if (!el) return;
    setOverflowing(el.scrollWidth > el.clientWidth + 1);
  };
  useLayoutEffect(measureOverflow);
  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(el);
    return () => observer.disconnect();
    // The strip element only exists while TERMINAL is showing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalActive]);

  // Plain (unshifted) mouse wheel scrolls the strip horizontally too, not
  // just Shift+wheel (the browser's native horizontal-scroll gesture) —
  // matches TabBar's own tab strip. Native (non-passive) listener: React's
  // onWheel can't preventDefault a scroll that's already begun.
  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const paneLabel = (pane: PanelPane): string => {
    const session = sessions.find((s) => s.name === pane.sessionName);
    const window = session?.windows.find((w) => w.index === pane.windowIndex);
    return `${pane.sessionName}:${window?.name ?? pane.windowIndex}`;
  };

  const tabLabel = (tab: PanelTab): string => {
    const base = paneLabel(tab.panes[0]);
    return tab.panes.length > 1 ? `${base} (${tab.panes.length})` : base;
  };

  const activeTab = visibleTabs.find((t) => t.id === activeTabId) ?? null;

  // Right-click on the view tabs: every view, checked while shown. TERMINAL
  // is listed but can't be switched off (useBottomPanel ignores it).
  const openViewsMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    showMenu(
      e.clientX,
      e.clientY,
      allViews.map((view) => ({
        label: view.title,
        checked: !hiddenViews.includes(view.id),
        disabled: view.id === TERMINAL_VIEW_ID,
        onClick: () => onToggleViewHidden(view.id),
      })),
    );
  };

  // The collapsed strip's menu: one row per tab, the active one checked, an
  // unseen-output tab marked the way its strip tab would be.
  const openTabMenu = (anchor: DOMRect) => {
    const items: MenuItem[] = visibleTabs.map((tab) => ({
      label: unseenOutput.has(tab.id) ? `${tabLabel(tab)}  ●` : tabLabel(tab),
      checked: tab.id === activeTabId,
      onClick: () => onSelectTab(tab.id),
    }));
    showMenu(anchor.left, anchor.bottom, items);
  };

  // Drag the panel's top edge. Height grows as the pointer moves *up*, so the
  // delta is inverted relative to the sidebar's own width drag.
  const handleHeightPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panel.height;
    const onMove = (ev: PointerEvent) => {
      onSetHeight(startHeight + (startY - ev.clientY));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
      document.body.style.cursor = "";
    };
    document.body.classList.add("resizing");
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Sash between two panes — same pixel-clamped, weight-preserving math as
  // SplitLayout's own row sash, just always horizontal (the panel splits
  // side-by-side only).
  const handleSashPointerDown = (e: React.PointerEvent, tab: PanelTab, index: number) => {
    e.preventDefault();
    const leftEl = paneRefs.current.get(tab.panes[index].id);
    const rightEl = paneRefs.current.get(tab.panes[index + 1].id);
    if (!leftEl || !rightEl) return;
    const sashEl = e.currentTarget as HTMLDivElement;
    const leftPx0 = leftEl.getBoundingClientRect().width;
    const rightPx0 = rightEl.getBoundingClientRect().width;
    const totalPx = leftPx0 + rightPx0;
    const totalWeight = tab.sizes[index] + tab.sizes[index + 1];
    const startX = e.clientX;

    const onMove = (ev: PointerEvent) => {
      const leftPx = Math.max(
        MIN_PANE_PX,
        Math.min(totalPx - MIN_PANE_PX, leftPx0 + (ev.clientX - startX)),
      );
      const sizes = [...tab.sizes];
      sizes[index] = (leftPx / totalPx) * totalWeight;
      sizes[index + 1] = ((totalPx - leftPx) / totalPx) * totalWeight;
      onResizePanes(tab.id, sizes);
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
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleSashDoubleClick = (tab: PanelTab, index: number) => {
    const totalWeight = tab.sizes[index] + tab.sizes[index + 1];
    const sizes = [...tab.sizes];
    sizes[index] = totalWeight / 2;
    sizes[index + 1] = totalWeight / 2;
    onResizePanes(tab.id, sizes);
  };

  return (
    <div className="bottom-panel" style={{ height: panel.height }}>
      <div className="bottom-panel-resize" onPointerDown={handleHeightPointerDown} />
      <div className="bottom-panel-header">
        <div className="bottom-panel-views" role="tablist" onContextMenu={openViewsMenu}>
          {views.map((view) => (
            <button
              key={view.id}
              role="tab"
              aria-selected={view.id === activeView}
              className={`bottom-panel-view-tab${view.id === activeView ? " active" : ""}`}
              onClick={() => onSelectView(view.id)}
            >
              {view.title}
            </button>
          ))}
        </div>
        {terminalActive && overflowing && activeTab && (
          <button
            className="bottom-panel-tab-dropdown"
            data-menu-trigger="true"
            aria-haspopup="menu"
            title={activeTab.panes.map(paneLabel).join("  |  ")}
            onClick={(e) => openTabMenu(e.currentTarget.getBoundingClientRect())}
          >
            <span>{tabLabel(activeTab)}</span>
            {unseenOutput.size > 0 && <span className="bottom-panel-tab-dot" />}
            <span className="bottom-panel-tab-count">({visibleTabs.length})</span>
            <Icon name="chevron-down" />
          </button>
        )}
        {terminalActive ? (
          <div className={`tab-strip${overflowing ? " collapsed" : ""}`} ref={tabStripRef}>
            {visibleTabs.map((tab) => (
              <div
                key={tab.id}
                role="button"
                tabIndex={overflowing ? -1 : 0}
                className={`tab${tab.id === activeTabId ? " active" : ""}`}
                title={tab.panes.map(paneLabel).join("  |  ")}
                onClick={() => onSelectTab(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectTab(tab.id);
                  }
                }}
              >
                <span>{tabLabel(tab)}</span>
                {unseenOutput.has(tab.id) && <span className="bottom-panel-tab-dot" />}
                <button
                  className="tab-close"
                  title="Close terminal"
                  tabIndex={overflowing ? -1 : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="bottom-panel-header-spacer" onContextMenu={openViewsMenu} />
        )}
        <div className="tab-bar-actions">
          {terminalActive && (
            <>
              <button
                className="panel-action"
                title="New Terminal"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onRequestTerminal({ x: rect.left, y: rect.bottom });
                }}
              >
                <Icon name="add" />
              </button>
              <button
                className="panel-action"
                title="Attach Window"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  onRequestAttachWindow({ x: rect.left, y: rect.bottom });
                }}
              >
                <Icon name="triangle-down" />
              </button>
              <button
                className="panel-action"
                title="Split Terminal Right"
                disabled={activeTabId === null}
                onClick={onSplit}
              >
                <Icon name="split-horizontal" />
              </button>
            </>
          )}
          <button
            className="panel-action"
            title={maximized ? "Restore Panel Size" : "Maximize Panel"}
            aria-pressed={maximized}
            onClick={onToggleMaximized}
          >
            <Icon name={maximized ? "screen-normal" : "screen-full"} />
          </button>
          <button className="panel-action" title="Hide Panel" onClick={onHide}>
            <Icon name="chevron-down" />
          </button>
        </div>
      </div>
      <div className="bottom-panel-body">
        {terminalActive && visibleTabs.length === 0 && (
          <div className="placeholder">No terminals in this project. Use + to open one.</div>
        )}
        {!terminalActive && <div className="bottom-panel-view">{renderView(activeView)}</div>}
        {panel.tabs.map((tab) => {
          // Every project's tabs stay mounted here (see the module comment);
          // tabVisible naturally covers only the current project's active
          // tab, since activeTabId can equal at most one tab across all of
          // them — every other project's tabs, including their own last-
          // active one, resolve to display:none without needing a separate
          // project filter in this loop.
          // ...and only while TERMINAL is the view showing: another view
          // owns the body then, and the panes wait behind display:none.
          const tabVisible = terminalActive && tab.id === activeTabId;
          const nodes: React.ReactNode[] = [];
          tab.panes.forEach((pane, i) => {
            const paneVisible = tabVisible;
            nodes.push(
              <div
                key={pane.id}
                ref={(el) => {
                  if (el) paneRefs.current.set(pane.id, el);
                  else paneRefs.current.delete(pane.id);
                }}
                className={`bottom-panel-pane${
                  tab.panes.length > 1 && pane.id === tab.activePaneId && panelFocused
                    ? " active"
                    : ""
                }`}
                style={{ flex: `${tab.sizes[i]} 1 0` }}
                onPointerDownCapture={() => onSelectPane(tab.id, pane.id)}
              >
                <TerminalView
                  attachName={pane.attachName}
                  visible={paneVisible}
                  focused={panelFocused && paneVisible && pane.id === tab.activePaneId}
                  settings={settings}
                  theme={theme}
                  fontsVersion={fontsVersion}
                  bindings={bindings}
                  onExit={() => onPaneExit(tab.id, pane.id)}
                  onError={onError}
                  onOutput={() => onPaneOutput(tab.id)}
                  onWindowSwitch={(windowIndex) => onWindowSwitch(pane.sessionName, windowIndex)}
                  onSessionSwitch={onSessionSwitch}
                  onOpenFile={onOpenFile}
                  onOpenFileSecondary={onOpenFileSecondary}
                />
              </div>,
            );
            if (i < tab.panes.length - 1) {
              nodes.push(
                <div
                  key={`sash-${pane.id}`}
                  className="split-sash split-sash-row"
                  onPointerDown={(e) => handleSashPointerDown(e, tab, i)}
                  onDoubleClick={() => handleSashDoubleClick(tab, i)}
                />,
              );
            }
          });
          return (
            <div
              key={tab.id}
              className="bottom-panel-panes"
              style={{ display: tabVisible ? "flex" : "none" }}
            >
              {nodes}
            </div>
          );
        })}
      </div>
    </div>
  );
}
