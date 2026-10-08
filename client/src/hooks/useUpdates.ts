import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";

// The server's update status (plans/app-versioning.md), for the About dialog,
// the Settings section and the "available" banner. Read every half hour and
// whenever `refreshKey` changes (a settings change, say); `check()` asks the
// server to check GitHub right now.
export function useUpdates(refreshKey: unknown = null): {
  status: api.UpdateStatus | null;
  checking: boolean;
  check: () => Promise<void>;
} {
  const [status, setStatus] = useState<api.UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const first = useRef(true);
  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const load = () =>
      api.getUpdates().then(
        (s) => {
          if (cancelled) return;
          setStatus(s);
          // A check the server started (a channel switch) - come back for
          // its answer.
          if (s.checking) timers.push(setTimeout(load, 1000));
        },
        () => {},
      );
    void load();
    // Settings reach the server a moment after they change here: read again
    // once they have, so the answer is for the new channel.
    if (!first.current) timers.push(setTimeout(load, 2000));
    first.current = false;
    const interval = setInterval(load, 30 * 60 * 1000);
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      clearInterval(interval);
    };
  }, [refreshKey]);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api.checkForUpdates());
    } catch {
      // The status keeps showing the last answer.
    } finally {
      setChecking(false);
    }
  }, []);

  return { status, checking, check };
}

/** "Checked 2 hours ago", "Checked just now". */
export function checkedAgo(at: number | null, now = Date.now()): string {
  if (at === null) return "Not checked yet";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `Checked ${Math.round(hours / 24)} days ago`;
}
