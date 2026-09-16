import { useCallback, useEffect, useState } from "react";
import * as api from "../api";

// cwd → resolved root, shared across every hook instance and persisted for the
// page's lifetime. A given directory's git root never changes under us, so a
// tab switch back to an already-seen cwd resolves synchronously with no
// refetch and no flicker. Failed lookups aren't cached (transient errors
// shouldn't stick a directory on its cwd fallback forever).
const rootCache = new Map<string, string>();

// One-shot promise variant for non-React callers (TerminalView's image
// paste/drop {gitroot} substitution), sharing rootCache with the hooks so a
// repo already resolved for the FILES panel costs nothing here and vice
// versa. Falls back to `cwd` on error, uncached, same policy as the hooks.
export async function resolveGitRootDir(cwd: string): Promise<string> {
  const cached = rootCache.get(cwd);
  if (cached !== undefined) return cached;
  try {
    const { root } = await api.getGitRoot(cwd);
    rootCache.set(cwd, root);
    return root;
  } catch {
    return cwd;
  }
}

// Resolves the FILES panel / quick-switcher root: the git repo containing the
// active window's `cwd`, or `cwd` itself when it isn't inside a repo.
//
// Returns null while a first-time lookup is in flight (FileTree renders its
// empty state for a null root, so the tree doesn't briefly show the cwd and
// then re-root at the repo). Falls back to `cwd` if the lookup errors.
export function useGitRootDir(cwd: string | null): string | null {
  const [root, setRoot] = useState<string | null>(() => (cwd ? (rootCache.get(cwd) ?? null) : null));

  useEffect(() => {
    if (!cwd) {
      setRoot(null);
      return;
    }
    const cached = rootCache.get(cwd);
    if (cached !== undefined) {
      setRoot(cached);
      return;
    }
    // Not yet known: clear to null (empty state) while we resolve, and ignore
    // the response if `cwd` changed out from under this effect meanwhile.
    setRoot(null);
    let stale = false;
    api
      .getGitRoot(cwd)
      .then(({ root: resolved }) => {
        rootCache.set(cwd, resolved);
        if (!stale) setRoot(resolved);
      })
      .catch(() => {
        if (!stale) setRoot(cwd);
      });
    return () => {
      stale = true;
    };
  }, [cwd]);

  return root;
}

// Batch variant for the SESSIONS pane: resolves every window's cwd to its git
// root, sharing the same rootCache as useGitRootDir (so a directory resolved
// for the FILES panel is free here and vice versa). Returns a `rootOf` lookup
// that falls back to the cwd itself until — or unless — its root resolves, so
// rows show the live path immediately and swap to the repo root once known.
// `version` bumps each time a batch of roots resolves; depend on it (or on
// rootOf, whose identity tracks it) to recompute memoized groupings.
export function useGitRootDirs(cwds: string[]): { rootOf: (cwd: string) => string; version: number } {
  const [version, setVersion] = useState(0);
  // Only the distinct directory set drives fetching; the sessions poll hands
  // us fresh window objects every few seconds with unchanged cwds, and this
  // key keeps that from re-triggering the effect.
  const key = [...new Set(cwds)].sort().join("\0");

  useEffect(() => {
    let cancelled = false;
    const missing = [...new Set(cwds)].filter((c) => c && !rootCache.has(c));
    if (missing.length === 0) return;
    Promise.all(
      missing.map((c) =>
        api
          .getGitRoot(c)
          .then(({ root }) => {
            rootCache.set(c, root);
          })
          .catch(() => {
            // Leave uncached so a transient failure retries on a later poll
            // rather than sticking this dir on its cwd fallback forever.
          }),
      ),
    ).then(() => {
      if (!cancelled) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
    // key captures the meaningful contents of cwds; see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const rootOf = useCallback((cwd: string) => rootCache.get(cwd) ?? cwd, [version]);
  return { rootOf, version };
}
