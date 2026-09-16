// Module-level pub/sub for the 3s sessions-poll tick (see useSessions.ts),
// so the FILES panel's background refresh doesn't have to ride through
// App-level React state (filesRefreshKey) — bumping that state re-rendered
// the whole app tree on every idle poll, whether or not anything actually
// changed. Same "module singleton, not prop-threaded" shape as
// extensions.ts's setSidebarVisibleHandler, but multi-subscriber since more
// than one mounted FileTree (or a future consumer) may want the tick.
const subscribers = new Set<() => void>();

export function subscribePollTick(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function emitPollTick(): void {
  for (const cb of subscribers) cb();
}
