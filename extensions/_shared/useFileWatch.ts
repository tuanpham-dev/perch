import { useEffect, useRef } from "react";
import { downloadUrl } from "./fileApi";

// Tells a viewer that the file it shows changed on disk (an agent or another
// program rewrote it), so it can reload instead of waiting for a manual
// Refresh. Polls a HEAD request — the download route answers it with the
// file's ETag (mtime + size) without sending the body — while the tab is the
// active one and the page is visible.
//
// The first answer after the file is opened is the baseline; a different
// signature later means "changed". The baseline survives the tab going
// inactive, so a change made while it was hidden is caught the moment it is
// shown again. A failed check (file briefly gone mid-rewrite, server restart)
// is skipped, not treated as a change.
//
// Registry extensions carry their own copy (they can't import from here);
// keep the behaviour the same.

const POLL_MS = 2000;

async function fileSignature(path: string): Promise<string | null> {
  try {
    const res = await fetch(downloadUrl(path), { method: "HEAD", cache: "no-store" });
    if (!res.ok) return null;
    return res.headers.get("etag") ?? `${res.headers.get("last-modified")}|${res.headers.get("content-length")}`;
  } catch {
    return null;
  }
}

export function useFileWatch(filePath: string, enabled: boolean, onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const baselineRef = useRef<{ path: string; sig: string } | null>(null);

  useEffect(() => {
    if (!enabled || !filePath) return;
    let cancelled = false;
    let busy = false;

    const check = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const sig = await fileSignature(filePath);
        if (cancelled || sig === null) return;
        const base = baselineRef.current;
        if (!base || base.path !== filePath) {
          baselineRef.current = { path: filePath, sig };
        } else if (base.sig !== sig) {
          baselineRef.current = { path: filePath, sig };
          onChangeRef.current();
        }
      } finally {
        busy = false;
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [filePath, enabled]);
}
