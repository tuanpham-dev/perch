import { useEffect, useState } from "react";
import type { DesktopBridge, WindowButton } from "../desktop";
import Icon from "./Icon";

// Minimize / maximize-restore / close for the desktop app's frameless window
// on Windows and Linux (macOS keeps its native traffic lights). Drawn in the
// strip the title bar leaves at one end, in the order and on the side the
// desktop puts its own (useWindowControlsOverlay). See
// plans/desktop-app.md T7.
export default function WindowControls({
  bridge,
  buttons,
  side,
}: {
  bridge: DesktopBridge;
  buttons: WindowButton[];
  side: "left" | "right";
}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => bridge.onMaximizedChange(setMaximized), [bridge]);
  const render = (button: WindowButton) => {
    switch (button) {
      case "minimize":
        return (
          <button key={button} className="window-control" title="Minimize" aria-label="Minimize" onClick={() => void bridge.minimize()}>
            <Icon name="chrome-minimize" />
          </button>
        );
      case "maximize":
        return (
          <button
            key={button}
            className="window-control"
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore" : "Maximize"}
            onClick={() => void bridge.toggleMaximize()}
          >
            <Icon name={maximized ? "chrome-restore" : "chrome-maximize"} />
          </button>
        );
      case "close":
        return (
          <button key={button} className="window-control window-control-close" title="Close" aria-label="Close" onClick={() => void bridge.close()}>
            <Icon name="chrome-close" />
          </button>
        );
    }
  };
  return (
    <div className="window-controls" data-side={side}>
      {buttons.map(render)}
    </div>
  );
}
