import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { RepoInfo } from "../types";

// Resolves every session folder to the repository it belongs to, and keeps
// that repository's worktree listing fresh — the data behind the PROJECTS
// tree's middle level. See plans/worktrees-into-projects.md.
//
// Cache policy, decided with the user:
//
//   * A path that DOES resolve to a repository is cached and only dropped
//     when that path leaves the session set. A directory can't change
//     repository without changing its own path string, so this is safe and
//     costs one lookup per folder for the page's life — the same trade
//     useGitRootDir's rootCache makes.
//   * A path that resolves to NO repository is never cached. That is exactly
//     the answer `git init` invalidates, so it is re-asked on every tick and
//     a freshly initialised repo appears without a reload. Non-repo session
//     folders are rare, so this costs little.
//
// The listing itself (branches, dirty state, which worktrees exist) always
// changes under us, so it is re-fetched on the poll regardless of caching.

const POLL_MS = 10000;

export interface WorktreeIndex {
  // Every session path that resolved to a repository, mapped to that
  // repository's listing. A path that isn't in a repository is absent, which
  // is what tells the tree to fall back to today's flat project row.
  repoIndex: Map<string, RepoInfo>;
  version: number;
}

export function useWorktrees(paths: string[]): WorktreeIndex {
  const [version, setVersion] = useState(0);
  // path → repository root. Positive answers only (see the policy above).
  const repoOfPath = useRef(new Map<string, string>());
  const listingByRepo = useRef(new Map<string, RepoInfo>());

  // Only the distinct folder set drives fetching; the sessions poll hands us
  // a fresh array every few seconds with unchanged paths, and this key keeps
  // that from re-triggering the effect.
  const key = useMemo(() => [...new Set(paths.filter(Boolean))].sort().join("\0"), [paths]);

  const refresh = useCallback(
    async (mode: "missing" | "all") => {
      const current = key ? key.split("\0") : [];
      if (current.length === 0) return;
      const want = new Set<string>();
      // Anything with no cached repository: never asked, or asked and found
      // not to be in one. Both are re-resolved.
      for (const p of current) {
        if (!repoOfPath.current.get(p)) want.add(p);
      }
      // A full pass also refreshes each known repository's listing, asking
      // through one representative path per repository — the server
      // deduplicates by repository anyway, but sending one path each keeps
      // the request small.
      if (mode === "all") {
        const seen = new Set<string>();
        for (const p of current) {
          const repo = repoOfPath.current.get(p);
          if (repo && !seen.has(repo)) {
            seen.add(repo);
            want.add(p);
          }
        }
      }
      if (want.size === 0) return;
      let results;
      try {
        ({ results } = await api.getWorktrees([...want], { dirty: true }));
      } catch {
        // Leave the previous listing in place; a failed lookup is never
        // cached, so the next tick simply asks again.
        return;
      }
      let changed = false;
      for (const result of results) {
        if (result.repo === null) {
          // Not in a repository: deliberately not cached, so a later
          // `git init` here is noticed on the next tick.
          if (repoOfPath.current.delete(result.path)) changed = true;
          continue;
        }
        if (repoOfPath.current.get(result.path) !== result.repo) {
          repoOfPath.current.set(result.path, result.repo);
          changed = true;
        }
        const next: RepoInfo = {
          repo: result.repo,
          worktrees: result.worktrees,
          branches: result.branches,
        };
        // Every tick re-fetches the listing, but most ticks find it
        // unchanged; comparing before storing keeps a quiet repository from
        // re-rendering the whole tree every ten seconds.
        const previous = listingByRepo.current.get(result.repo);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) {
          listingByRepo.current.set(result.repo, next);
          changed = true;
        }
      }
      if (changed) setVersion((v) => v + 1);
    },
    [key],
  );

  // Folder set changed: forget the paths that left (the one eviction rule),
  // then resolve whatever is newly unknown.
  useEffect(() => {
    const current = new Set(key ? key.split("\0") : []);
    let evicted = false;
    for (const p of [...repoOfPath.current.keys()]) {
      if (!current.has(p)) {
        repoOfPath.current.delete(p);
        evicted = true;
      }
    }
    // A repository nobody is rooted in any more stops being polled.
    const liveRepos = new Set([...repoOfPath.current.values()]);
    for (const repo of [...listingByRepo.current.keys()]) {
      if (!liveRepos.has(repo)) {
        listingByRepo.current.delete(repo);
        evicted = true;
      }
    }
    if (evicted) setVersion((v) => v + 1);
    void refresh("missing");
  }, [key, refresh]);

  // The listing poll. Skipped while the tab is hidden — nobody is reading the
  // tree — and caught up immediately on the way back.
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      void refresh("all");
    };
    const timer = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh("all");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const repoIndex = useMemo(() => {
    const index = new Map<string, RepoInfo>();
    for (const [p, repo] of repoOfPath.current) {
      const listing = listingByRepo.current.get(repo);
      if (listing) index.set(p, listing);
    }
    return index;
    // Rebuilt whenever either cache changes; the refs themselves are stable.
  }, [version]);

  return { repoIndex, version };
}
