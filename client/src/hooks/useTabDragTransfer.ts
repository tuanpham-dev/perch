import { useCallback, useEffect, useRef } from "react";
import { openChannel, pointInWindow, type DetachedMessage } from "../lib/detachedWindows";

// The cross-window half of a native tab drag (plans/cross-window-tab-drag.md).
// A window that adopts dropped tabs announces `tab-taken`; the source, whose
// own drag event can't tell (Chrome reports no effect back for a drop in
// another window), asks every window where its drag was released and then
// decides: taken (remove the tabs), released inside some other Perch window
// (a cancel), or released outside every window (a tear-off).
//
// A separate BroadcastChannel instance from useDetachedWindows' - several
// instances of one named channel each receive every message - so the two
// protocols stay independent.

// How long the source waits for answers after its drag ended. The channel is
// local, so answers arrive within a few milliseconds; the margin covers a
// target busy rendering the adoption.
const RESOLVE_WAIT_MS = 300;
// A `tab-taken` can arrive before the source's dragend fires (the drop in the
// target runs first); keep it this long for the resolve that follows.
const EARLY_TAKEN_TTL_MS = 2000;

export interface DragEndResolution {
  // Ids the target adopted, or null when no window took the drag.
  taken: string[] | null;
  // Whether the release point lay within another Perch window's frame.
  endedInOtherWindow: boolean;
}

export function useTabDragTransfer() {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const earlyTakenRef = useRef<Record<string, { tabIds: string[]; at: number }>>({});
  const pendingRef = useRef<Record<string, { taken: string[] | null; endedInOtherWindow: boolean }>>({});

  useEffect(() => {
    const channel = openChannel();
    channelRef.current = channel;
    if (!channel) return;
    channel.onmessage = (e: MessageEvent<DetachedMessage>) => {
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "tab-taken") {
        const pending = pendingRef.current[msg.dragId];
        if (pending) pending.taken = [...(pending.taken ?? []), ...msg.tabIds];
        else earlyTakenRef.current[msg.dragId] = { tabIds: msg.tabIds, at: Date.now() };
      } else if (msg.type === "drag-ended") {
        if (pointInWindow(msg.screenX, msg.screenY, window)) {
          channel.postMessage({ type: "drag-ended-here", dragId: msg.dragId } satisfies DetachedMessage);
        }
      } else if (msg.type === "drag-ended-here") {
        const pending = pendingRef.current[msg.dragId];
        if (pending) pending.endedInOtherWindow = true;
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, []);

  const announceTaken = useCallback((dragId: string, tabIds: string[]) => {
    channelRef.current?.postMessage({ type: "tab-taken", dragId, tabIds } satisfies DetachedMessage);
  }, []);

  const resolveDragEnd = useCallback((dragId: string, screenX: number, screenY: number): Promise<DragEndResolution> => {
    const early = earlyTakenRef.current[dragId];
    delete earlyTakenRef.current[dragId];
    // Sweep stale early arrivals while here.
    const now = Date.now();
    for (const [id, entry] of Object.entries(earlyTakenRef.current)) {
      if (now - entry.at > EARLY_TAKEN_TTL_MS) delete earlyTakenRef.current[id];
    }
    const pending = { taken: early && now - early.at <= EARLY_TAKEN_TTL_MS ? early.tabIds : null, endedInOtherWindow: false };
    pendingRef.current[dragId] = pending;
    channelRef.current?.postMessage({ type: "drag-ended", dragId, screenX, screenY } satisfies DetachedMessage);
    return new Promise((resolve) => {
      window.setTimeout(() => {
        delete pendingRef.current[dragId];
        resolve({ taken: pending.taken, endedInOtherWindow: pending.endedInOtherWindow });
      }, RESOLVE_WAIT_MS);
    });
  }, []);

  return { announceTaken, resolveDragEnd };
}
