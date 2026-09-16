import { useLayoutEffect, useRef, useState } from "react";
import { formatBinding, type Keybinding } from "../keybindings";
import type { TitlebarAreaRect } from "../hooks/useWindowControlsOverlay";
import Icon from "./Icon";

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
// Space between each button group and the command center, matching the
// .titlebar-group-start/-end offsets in styles.css.
const GROUP_GAP_START = 4;
const GROUP_GAP_END = 10;

interface Props {
  rect: TitlebarAreaRect;
  emulated: "left" | "right" | null;
  focused: boolean;
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
}

export default function TitleBar({
  rect,
  emulated,
  focused,
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
      const start = startGroupRef.current?.offsetWidth;
      const end = endGroupRef.current?.offsetWidth;
      if (start === undefined || end === undefined) return;
      const width = window.innerWidth;
      const reserve = Math.max(insetStart + start + GROUP_GAP_START, insetEnd + end + GROUP_GAP_END);
      setCenterMax(Math.max(0, Math.floor(width - 2 * reserve - 8)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [insetStart, insetEnd]);

  const inline = centerMax < MIN_CENTERED_WIDTH;

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
    >
      {emulated && <div className="titlebar-emulated-controls" data-side={emulated} />}
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
    </header>
  );
}
