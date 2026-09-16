import { useEffect, useRef } from "react";
import type { TerminalTheme } from "../engines/types";
import type { Keybinding } from "../keybindings";
import type { AppSettings } from "../settings";
import type { TerminalSession } from "../types";
import type { PanelPane, PanelState, PanelTab } from "../hooks/useBottomPanel";
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

// Matches SplitLayout's own MIN_LEAF_PX — a sash can't shrink either pane
// below this.
const MIN_PANE_PX = 120;

interface Props {
  panel: PanelState;
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
        <span className="bottom-panel-title">TERMINAL</span>
        <div className="tab-strip" ref={tabStripRef}>
          {visibleTabs.map((tab) => (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
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
              <button
                className="tab-close"
                title="Close terminal"
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
        <div className="tab-bar-actions">
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
          <button className="panel-action" title="Hide Panel" onClick={onHide}>
            <Icon name="chevron-down" />
          </button>
        </div>
      </div>
      <div className="bottom-panel-body">
        {visibleTabs.length === 0 && (
          <div className="placeholder">No terminals in this project. Use + to open one.</div>
        )}
        {panel.tabs.map((tab) => {
          // Every project's tabs stay mounted here (see the module comment);
          // tabVisible naturally covers only the current project's active
          // tab, since activeTabId can equal at most one tab across all of
          // them — every other project's tabs, including their own last-
          // active one, resolve to display:none without needing a separate
          // project filter in this loop.
          const tabVisible = tab.id === activeTabId;
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
