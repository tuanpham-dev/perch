import { useEffect, useRef } from "react";
import type { UpdateStatus } from "../api";
import { copyText } from "../clipboard";
import { desktop } from "../desktop";
import { checkedAgo } from "../hooks/useUpdates";

const REPO_URL = "https://github.com/tuanpham-dev/perch";

// What the update check found, with what to do about it. Shared by the About
// dialog and Settings → About.
export function UpdateSummary({ status }: { status: UpdateStatus | null }) {
  if (!status) return <div className="about-status">Checking for updates...</div>;
  if (status.available && status.latest) {
    return (
      <div className="about-status available">
        <div className="about-status-title">Perch {status.latest.version} is available</div>
        <div className="about-update-command">
          Update with: <code>perch update</code>
          <button className="dialog-button secondary about-copy" onClick={() => void copyText("perch update")}>
            Copy
          </button>
        </div>
        <a href={status.latest.url} target="_blank" rel="noopener noreferrer">
          Release notes
        </a>
      </div>
    );
  }
  if (status.error) {
    return (
      <div className="about-status error">
        Couldn't check for updates ({status.error}).
        {status.lastSuccessAt !== null && ` Last checked successfully ${checkedAgo(status.lastSuccessAt).slice("Checked ".length)}.`}
      </div>
    );
  }
  if (status.checkedAt === null) return <div className="about-status">Not checked for updates yet.</div>;
  return <div className="about-status">Perch is up to date.</div>;
}

// Manage → About Perch (plans/app-versioning.md R3).
export default function AboutDialog({
  status,
  checking,
  onCheck,
  onClose,
}: {
  status: UpdateStatus | null;
  checking: boolean;
  onCheck: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const channel = status?.channel === "beta" ? "Beta channel" : "Stable channel";

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog about-dialog"
        role="dialog"
        aria-label="About Perch"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="about-title">
          Perch {status?.current ?? ""}
          {status?.commit && <span className="about-commit">commit {status.commit}</span>}
        </div>
        {desktop && <div className="about-line">Desktop app {desktop.info.version}</div>}
        <UpdateSummary status={status} />
        <div className="about-line muted">
          {checkedAgo(status?.checkedAt ?? null)} · {channel}
        </div>
        <div className="dialog-buttons about-buttons">
          <a className="about-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <button className="dialog-button secondary" disabled={checking} onClick={onCheck}>
            {checking ? "Checking..." : "Check for updates"}
          </button>
          <button ref={closeRef} className="dialog-button primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
