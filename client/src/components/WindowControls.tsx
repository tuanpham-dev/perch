import { useEffect, useState } from "react";
import type { DesktopBridge } from "../desktop";
import Icon from "./Icon";

// Minimize / maximize-restore / close for the desktop app's frameless window
// on Windows and Linux (macOS keeps its native traffic lights). Drawn in the
// strip the title bar leaves at its right end, where the installed PWA's
// browser would draw its own. See plans/desktop-app.md T7.
export default function WindowControls({ bridge }: { bridge: DesktopBridge }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => bridge.onMaximizedChange(setMaximized), [bridge]);
  return (
    <div className="window-controls">
      <button className="window-control" title="Minimize" aria-label="Minimize" onClick={() => void bridge.minimize()}>
        <Icon name="chrome-minimize" />
      </button>
      <button
        className="window-control"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void bridge.toggleMaximize()}
      >
        <Icon name={maximized ? "chrome-restore" : "chrome-maximize"} />
      </button>
      <button className="window-control window-control-close" title="Close" aria-label="Close" onClick={() => void bridge.close()}>
        <Icon name="chrome-close" />
      </button>
    </div>
  );
}
