import { useSyncExternalStore } from "react";
import { fetchAllAgentWindows } from "../api";
import { subscribePollTick } from "./pollTick";

// Which terminal window runs which code agent, for the sidebar's row icons.
// One shared poll for every list on screen (the sidebar's tree and the
// status-bar popover's copy), riding the sessions poll tick, and only while
// something is subscribed.

export interface WindowAgent {
  agentId: string;
  label: string;
  iconUrl: string;
  icon: string;
}

export const windowAgentKey = (session: string, windowIndex: number) => `${session}\u0000${windowIndex}`;

let snapshot: ReadonlyMap<string, WindowAgent> = new Map();
const listeners = new Set<() => void>();
let unsubscribeTick: (() => void) | null = null;
let busy = false;

function sameAgents(a: ReadonlyMap<string, WindowAgent>, b: ReadonlyMap<string, WindowAgent>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.agentId !== v.agentId || o.iconUrl !== v.iconUrl || o.icon !== v.icon) return false;
  }
  return true;
}

async function refresh(): Promise<void> {
  if (busy || document.hidden) return;
  busy = true;
  try {
    const { windows } = await fetchAllAgentWindows();
    const next = new Map<string, WindowAgent>();
    for (const w of windows) {
      next.set(windowAgentKey(w.session, w.windowIndex), {
        agentId: w.agentId,
        label: w.label,
        iconUrl: w.iconUrl,
        icon: w.icon,
      });
    }
    // Same answer as before: keep the identity so nothing re-renders.
    if (!sameAgents(snapshot, next)) {
      snapshot = next;
      for (const l of listeners) l();
    }
  } catch {
    // Keep showing what we had; the next tick tries again.
  } finally {
    busy = false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    unsubscribeTick = subscribePollTick(() => void refresh());
    void refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeTick?.();
      unsubscribeTick = null;
    }
  };
}

export function useWindowAgents(): ReadonlyMap<string, WindowAgent> {
  return useSyncExternalStore(subscribe, () => snapshot);
}
