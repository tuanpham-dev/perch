// The notice the assistant leaves in the corner of the window: one at a time,
// dismissed after a few seconds or by hand, with a Copy button when there is
// text to take away. Actions (client.tsx) and relay events both raise it.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../../_shared/clipboard";

const NOTICE_MS = 8_000;

export interface Notice {
  key: number;
  title: string;
  detail?: string;
  // What Copy puts on the clipboard; the detail may be a masked form of it.
  copy?: string;
  // The detail is a sentence, not something to copy or compare: regular UI font, wrapping.
  prose?: boolean;
}

let notice: Notice | null = null;
let noticeKey = 0;
const noticeListeners = new Set<() => void>();

export function showNotice(next: Omit<Notice, "key">): void {
  notice = { ...next, key: ++noticeKey };
  for (const listener of noticeListeners) listener();
}

export function dismissNotice(key: number): void {
  if (notice?.key !== key) return;
  notice = null;
  for (const listener of noticeListeners) listener();
}

export function NoticeOverlay() {
  const [current, setCurrent] = useState(notice);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const listener = () => setCurrent(notice);
    noticeListeners.add(listener);
    listener();
    return () => {
      noticeListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    setCopied(false);
    if (!current) return;
    const timer = setTimeout(() => dismissNotice(current.key), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [current]);
  if (!current) return null;
  const onCopy = () => {
    if (!current.copy) return;
    copyText(current.copy)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  // Portaled to <body>: the overlay layer this component mounts in sits
  // below the floating terminal, which would otherwise cover the notice.
  return createPortal(
    <div className="assistant-notice" role="status" aria-live="polite">
      <div className="assistant-notice-head">
        <span className="assistant-notice-title">
          <span className="assistant-notice-source">Assistant</span> ·{" "}
          {current.title}
        </span>
        <div className="assistant-notice-buttons">
          {current.copy && (
            <button
              type="button"
              className="assistant-notice-button primary"
              onClick={onCopy}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          <button
            type="button"
            className="assistant-notice-button"
            onClick={() => dismissNotice(current.key)}
          >
            Dismiss
          </button>
        </div>
      </div>
      {current.detail && (
        <div
          className={`assistant-notice-detail${current.prose ? " prose" : ""}`}
        >
          {current.detail}
        </div>
      )}
    </div>,
    document.body,
  );
}

// Called when the extension is deactivated.
export function resetNotice(): void {
  notice = null;
}
