// The optional `deactivate()` each mounted extension server entry exports,
// keyed by extension id like extensions.ts's serverHooks. Kept out of
// extensions.ts so it can be tested without importing the whole host (and,
// through it, modules the test runner's strip-only TypeScript can't load).
//
// Dropping an extension's router only stops requests: a socket listener, a
// timer or a watcher its activate() started would otherwise keep running after
// a disable, in a module the user believes is off. unmountServerHook runs the
// deactivate recorded here, which is also what lets the next activate() on the
// resident module (a re-enable) start from a clean slate.
const deactivators = new Map<string, () => unknown>();

// Called once activate() has returned: an entry whose activate threw never
// mounted, so it has nothing to tear down. A module with no function export
// clears any stale record rather than leaving one behind.
export function recordServerDeactivate(id: string, mod: unknown): void {
  const deactivate = (mod as { deactivate?: unknown } | null)?.deactivate;
  if (typeof deactivate === "function") deactivators.set(id, deactivate as () => unknown);
  else deactivators.delete(id);
}

// Runs and forgets this extension's deactivate, if it has one. Fire and
// forget: callers are synchronous, and a slow or failing deactivate must not
// block or fail the disable/uninstall that asked for it - a throw or a
// rejection is logged instead.
export function runServerDeactivate(id: string): void {
  const deactivate = deactivators.get(id);
  deactivators.delete(id);
  if (!deactivate) return;
  const log = (err: unknown) => console.error(`extension ${id}: deactivate() failed:`, err);
  try {
    const result = deactivate();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(undefined, log);
    }
  } catch (err) {
    log(err);
  }
}
