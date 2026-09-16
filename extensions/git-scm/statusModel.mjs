// Pure git-status model shared by server.js (scan classification + per-scan
// directory rollup) and src/client.tsx (per-entry decoration resolution) —
// ported verbatim from core server/src/git.ts when file-tree decorations
// moved into this extension. Tested by statusModel.test.mjs (node --test).

// Two-letter porcelain v1 code -> tree status.
export function classify(code) {
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  const [index, work] = code;
  if (
    index === "U" ||
    work === "U" ||
    (index === "A" && work === "A") ||
    (index === "D" && work === "D")
  ) {
    return "conflicted";
  }
  if (index === "R" || work === "R") return "renamed";
  if (index === "D" || work === "D") return "deleted";
  if (index === "A" || work === "A" || index === "C" || work === "C") return "added";
  return "modified";
}

// Worst-first tie-break when a directory contains changes of several kinds.
export const PRIORITY = [
  "conflicted",
  "deleted",
  "modified",
  "renamed",
  "added",
  "untracked",
  "ignored",
];

// Numeric rank matching PRIORITY's worst-first order — lower is worse, so
// an aggregate directory status is the *minimum* rank among any entry
// nested inside it.
export const RANK = Object.fromEntries(PRIORITY.map((status, i) => [status, i]));

// One rollup pass over the flat status map, run once per scan (not once per
// listed entry — see statusForEntry below): each entry's status propagates
// up its ancestor chain as the worst aggregate status for every containing
// directory. Stops climbing a chain once it reaches an ancestor already at
// least as bad — dominance is transitive, so if this ancestor already
// reflects a status this bad or worse, whichever earlier entry caused that
// already propagated it past this point.
export function buildDirStatuses(statuses) {
  const dirStatuses = new Map();
  for (const [path, status] of statuses) {
    const rank = RANK[status];
    let idx = path.lastIndexOf("/");
    while (idx !== -1) {
      const dir = path.slice(0, idx);
      const current = dirStatuses.get(dir);
      if (current !== undefined && RANK[current] <= rank) break;
      dirStatuses.set(dir, status);
      idx = dir.lastIndexOf("/");
    }
  }
  return dirStatuses;
}

// relPath is the entry's path relative to the repo root. Checks for an exact
// match first, then falls back to nested matches: a directory looks up its
// precomputed worst-status rollup (dirStatuses, built once per scan by
// buildDirStatuses), while a file nested inside a collapsed ignored/
// untracked directory entry inherits that directory's status by walking its
// own ancestor chain — cheap since it's bounded by path depth, not the
// number of changed files.
export function statusForEntry(statuses, dirStatuses, trackedDirs, relPath, isDir) {
  let result = statuses.get(relPath);
  if (!result) {
    if (isDir) {
      result = dirStatuses.get(relPath);
    } else {
      let idx = relPath.lastIndexOf("/");
      while (idx !== -1) {
        const dir = relPath.slice(0, idx);
        const candidate = statuses.get(dir);
        if (candidate !== undefined && (!result || RANK[candidate] < RANK[result])) {
          result = candidate;
        }
        idx = dir.lastIndexOf("/");
      }
    }
  }
  // A directory is only dimmed as "ignored" when it's fully covered by
  // .gitignore. `git status -uall` always expands ignored directories into
  // their individual files rather than collapsing them, so a directory that
  // merely contains some ignored files/subfolders alongside ordinary tracked
  // content would otherwise resolve to "ignored" too (nothing else in the
  // sparse status map outranks it, since clean tracked files never appear
  // there at all). Checking for tracked descendants tells the two apart.
  if (isDir && result === "ignored" && trackedDirs.has(relPath)) return undefined;
  return result;
}
