import { useEffect } from "react";
import Icon from "./Icon";

// A quiet, non-modal notice at the bottom of the window with one action - the
// one-click "Open terminal setup" offer for an already approved project file.
// Dismisses itself after `timeoutMs`.
export default function Notice({
  message,
  actionLabel,
  onAction,
  onDismiss,
  timeoutMs = 15_000,
}: {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  timeoutMs?: number;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [onDismiss, timeoutMs]);

  return (
    <div className="app-notice" role="status">
      <span className="app-notice-message">{message}</span>
      <button className="app-notice-action" onClick={onAction}>
        {actionLabel}
      </button>
      <button className="icon-button app-notice-close" title="Dismiss" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" />
      </button>
    </div>
  );
}
