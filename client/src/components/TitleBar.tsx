import { useLayoutEffect, useRef, useState } from "react";
import { formatBinding, type Keybinding } from "../keybindings";
import type { TitlebarAreaRect } from "../hooks/useWindowControlsOverlay";
import { desktop } from "../desktop";
import Icon from "./Icon";
import WindowControls from "./WindowControls";

// The app's own title bar, drawn in the strip the browser leaves beside its
// window controls once the installed app's title bar is hidden (see
// useWindowControlsOverlay). VS Code's arrangement: a command center centered
// on the window, back/forward just before it, layout toggles and Manage just
// after. It carries the left sidebar footer's buttons, so App hides that footer
// while this is up. See plans/pwa-custom-title-bar.md.

// Below this the command center can't sit centered on the window with both
// groups beside it clear of the window controls, so the three drop into a
// plain row between the controls instead.
const MIN_CENTERED_WIDTH = 120;
// How far the mouse must travel after pressing on empty title bar space
// before the desktop app's window starts to move. Starting on the press
// itself would let the window manager's drag grab swallow a double-click's
// second press (plans/desktop-app.spike.md), so double-click to maximize
// would never arrive.
const DRAG_THRESHOLD = 3;

// Space between each button group and the command center, matching the
// .titlebar-group-start/-end offsets in styles.css.
const GROUP_GAP_START = 4;
const GROUP_GAP_END = 10;

interface Props {
  rect: TitlebarAreaRect;
  emulated: "left" | "right" | null;
  focused: boolean;
  // Draw the desktop app's own minimize/maximize/close at the right end.
  desktopControls?: boolean;
  title: string;
  commandCenterLabel: string;
  commandCenterCommand: string;
  onCommandCenter: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  panelVisible: boolean;
  onTogglePanel: () => void;
  leftSidebarVisible: boolean;
  onToggleLeftSidebar: () => void;
  rightSidebarVisible: boolean;
  onToggleRightSidebar: () => void;
  onManage: (anchor: DOMRect) => void;
  resolvedBindings: Record<string, Keybinding[]>;
  // A detached window (plans/detach-tab-to-new-window.md): the title and the
  // drag region only - no navigation, command center or layout toggles,
  // since that window has no sidebars or panel to toggle.
  minimal?: boolean;
}

export default function TitleBar({
  rect,
  emulated,
  focused,
  desktopControls = false,
  title,
  commandCenterLabel,
  commandCenterCommand,
  onCommandCenter,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  panelVisible,
  onTogglePanel,
  leftSidebarVisible,
  onToggleLeftSidebar,
  rightSidebarVisible,
  onToggleRightSidebar,
  onManage,
  resolvedBindings,
  minimal = false,
}: Props) {
  const startGroupRef = useRef<HTMLDivElement>(null);
  const endGroupRef = useRef<HTMLDivElement>(null);
  const [centerMax, setCenterMax] = useState(0);

  const shortcutSuffix = (commandId: string): string => {
    const key = resolvedBindings[commandId]?.[0]?.key;
    return key ? ` (${formatBinding(key)})` : "";
  };

  const windowWidth = window.innerWidth;
  const insetStart = rect.x;
  const insetEnd = Math.max(0, windowWidth - rect.x - rect.width);

  // Centered on the window with a group riding each side, the command center
  // may only grow until one of those groups would reach the window controls.
  useLayoutEffect(() => {
    const measure = () => {
      // Minimal mode renders no groups: nothing to keep clear of the controls.
      const start = minimal ? 0 : startGroupRef.current?.offsetWidth;
      const end = minimal ? 0 : endGroupRef.current?.offsetWidth;
      if (start === undefined || end === undefined) return;
      const width = window.innerWidth;
      const reserve = Math.max(insetStart + start + GROUP_GAP_START, insetEnd + end + GROUP_GAP_END);
      setCenterMax(Math.max(0, Math.floor(width - 2 * reserve - 8)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [insetStart, insetEnd, minimal]);

  const inline = centerMax < MIN_CENTERED_WIDTH;

  // The desktop app's window has no browser-drawn drag region, so empty
  // title bar space moves the window itself: armed on a press, started once
  // the mouse moves, and a double-click toggles maximize. The moves are
  // watched on the whole window, since a quick drag leaves the thin bar
  // before its first move event arrives.
  const onEmptySpace = (target: EventTarget) => !(target as Element).closest?.("button");
  const desktopDrag = desktop
    ? {
        onMouseDown: (e: React.MouseEvent) => {
          if (e.button !== 0 || !onEmptySpace(e.target)) return;
          const from = { x: e.clientX, y: e.clientY };
          const stop = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", stop);
          };
          const onMove = (m: MouseEvent) => {
            if ((m.buttons & 1) === 0) return stop();
            if (Math.abs(m.clientX - from.x) + Math.abs(m.clientY - from.y) < DRAG_THRESHOLD) return;
            stop();
            void desktop!.startDragging();
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", stop);
        },
        onDoubleClick: (e: React.MouseEvent) => {
          if (onEmptySpace(e.target)) void desktop!.toggleMaximize();
        },
      }
    : {};

  return (
    <header
      className={`titlebar${focused ? "" : " inactive"}${inline ? " cc-inline" : ""}`}
      style={
        {
          "--tb-start": `${insetStart}px`,
          "--tb-end": `${insetEnd}px`,
          "--tb-height": `${rect.height}px`,
          "--cc-max": `${centerMax}px`,
        } as React.CSSProperties
      }
      {...desktopDrag}
    >
      {emulated && <div className="titlebar-emulated-controls" data-side={emulated} />}
      {desktopControls && desktop && <WindowControls bridge={desktop} />}
      {minimal ? (
        <div className="titlebar-center">
          <span className="titlebar-title-static titlebar-command-center-label" title={title}>
            {title}
          </span>
        </div>
      ) : (
      <div className="titlebar-center">
        <div className="titlebar-group titlebar-group-start" ref={startGroupRef}>
          <button className="icon-button" title="Go Back" disabled={!canGoBack} onClick={onGoBack}>
            <Icon name="arrow-left" />
          </button>
          <button className="icon-button" title="Go Forward" disabled={!canGoForward} onClick={onGoForward}>
            <Icon name="arrow-right" />
          </button>
        </div>
        <button
          className="titlebar-command-center"
          title={`${commandCenterLabel}${shortcutSuffix(commandCenterCommand)}`}
          onClick={onCommandCenter}
        >
          <Icon name="search" />
          <span className="titlebar-command-center-label">{title}</span>
        </button>
        <div className="titlebar-group titlebar-group-end" ref={endGroupRef}>
          <button
            className={`icon-button${panelVisible ? " active" : ""}`}
            title={`Toggle bottom panel${shortcutSuffix("panel.toggle")}`}
            aria-pressed={panelVisible}
            onClick={onTogglePanel}
          >
            <Icon name={panelVisible ? "layout-panel" : "layout-panel-off"} />
          </button>
          {/* Unlike the footer's copy, this one outlives a closed left sidebar,
              so it shows both states and reopens it in one click. */}
          <button
            className={`icon-button${leftSidebarVisible ? " active" : ""}`}
            title={`Toggle left sidebar${shortcutSuffix("sidebar.toggle")}`}
            aria-pressed={leftSidebarVisible}
            onClick={onToggleLeftSidebar}
          >
            <Icon name={leftSidebarVisible ? "layout-sidebar-left" : "layout-sidebar-left-off"} />
          </button>
          <button
            className={`icon-button${rightSidebarVisible ? " active" : ""}`}
            title={`Toggle right sidebar${shortcutSuffix("sidebar.toggleRight")}`}
            aria-pressed={rightSidebarVisible}
            onClick={onToggleRightSidebar}
          >
            <Icon name={rightSidebarVisible ? "layout-sidebar-right" : "layout-sidebar-right-off"} />
          </button>
          <button
            className="icon-button"
            title="Manage"
            aria-haspopup="menu"
            data-menu-trigger="true"
            onClick={(e) => onManage(e.currentTarget.getBoundingClientRect())}
          >
            <Icon name="gear" />
          </button>
        </div>
      </div>
      )}
    </header>
  );
}
