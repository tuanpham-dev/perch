import type { Project, RepoInfo, TerminalSession, WorktreeInfo } from "../types";
import { isAbsolutePath } from "./paths";

// A project's display name is always derived from its folder — never stored,
// so renaming the folder is renaming the project. Works on the `~`-shortened
// paths the server hands out ("~/works/app" → "app"; "~" → "~").
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base || trimmed || "/";
}

// Session names may not contain "." or ":" (a rule inherited from the tmux backend,
// which rejects or mangles them; the daemon keeps it so names work on either);
// the folder basename is otherwise used as-is, suffixed -2, -3… when a live
// session already holds the name (two projects sharing a basename). The name
// is purely cosmetic — project↔session matching is by path, never name.
export function sessionNameForProject(cwd: string, existingSessionNames: Iterable<string>): string {
  const base = projectName(cwd).replace(/[.:]/g, "-");
  const taken = new Set(existingSessionNames);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// The session name a worktree proposes for its branch. Session names
// can't contain "." or ":" (its own target syntax), whitespace makes them
// awkward to type, and "/" would read as a path. Kept byte-identical to what
// the worktrees extension used, so a session it created still matches the
// worktree it was created for.
export function sessionNameForBranch(branch: string): string {
  return branch.replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

// The folder a worktree location template puts every checkout in, for one
// repository — "{repo}/.worktrees/{branch}" gives "<repo>/.worktrees". Only
// answered when that folder is unambiguous and inside the repository: the
// template must end in its own "/{branch}" segment, with no other {branch}.
// A template like "{repo}-{branch}" or "../wt/{branch}" names folders that
// could just as well be unrelated projects, so it answers null.
export function worktreeContainer(template: string, repo: string): string | null {
  const t = template.trim();
  const suffix = "/{branch}";
  if (!t.endsWith(suffix)) return null;
  let dir = t.slice(0, -suffix.length);
  if (dir.includes("{branch}")) return null;
  dir = dir.replaceAll("{repo}", repo);
  if (!isAbsolutePath(dir)) dir = `${repo}/${dir}`;
  const segments: string[] = [];
  for (const seg of dir.split("/")) {
    if (seg === "." || (seg === "" && segments.length > 0)) continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  const resolved = segments.join("/");
  return resolved.startsWith(repo + "/") ? resolved : null;
}

// Whether a folder sits in a linked worktree (any worktree but the
// repository's own checkout) of a repository the tree knows about. Those are
// reached through their project's worktree level, so they don't belong in the
// recent-projects list: each one would otherwise add an entry named after a
// branch folder, crowding out the projects themselves.
//
// Two ways to count: git lists the folder as a linked worktree, or it sits in
// the repository's worktree container (`location`, the worktreeLocation
// setting) — which also catches a worktree already removed, that git has
// forgotten. `repoIndex` only knows repositories some live session is rooted
// in, so an unknown folder answers false and is recorded as usual.
export function isLinkedWorktreePath(
  repoIndex: Map<string, RepoInfo>,
  cwd: string,
  location?: string,
): boolean {
  // Longest match across every repository, not the first: a repository can
  // sit inside another one's folder, and only the innermost owns the path.
  let best: { owner: WorktreeInfo; repo: string } | undefined;
  for (const repo of repoIndex.values()) {
    const owner = worktreeForPath(repo.worktrees, cwd);
    if (owner && (!best || owner.path.length > best.owner.path.length)) best = { owner, repo: repo.repo };
  }
  if (!best) return false;
  if (!best.owner.main) return true;
  const container = location ? worktreeContainer(location, best.repo) : null;
  return container !== null && cwd.startsWith(container + "/");
}

// Drops unpinned recents entries that turn out to be linked worktrees — ones
// recorded before worktrees stopped being added. A pin is the user's explicit
// choice and stays. Returns the same array when nothing changes, so a state
// setter can bail out without a re-render or a sync.
export function withoutWorktreeRecents(
  projects: Project[],
  repoIndex: Map<string, RepoInfo>,
  location?: string,
): Project[] {
  const next = projects.filter((p) => p.pinned || !isLinkedWorktreePath(repoIndex, p.cwd, location));
  return next.length === projects.length ? projects : next;
}

// How many unpinned entries the recents list keeps — pinned entries never
// count against (or get evicted by) the cap.
const RECENTS_CAP = 15;

// Records a project open: upserts the entry (preserving its pinned flag),
// stamps lastOpened, and evicts the oldest unpinned entries beyond the cap.
export function bumpRecent(projects: Project[], cwd: string): Project[] {
  const existing = projects.find((p) => p.cwd === cwd);
  const next: Project[] = [
    { cwd, pinned: existing?.pinned ?? false, lastOpened: Date.now() },
    ...projects.filter((p) => p.cwd !== cwd),
  ];
  let unpinned = 0;
  return next
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .filter((p) => p.pinned || ++unpinned <= RECENTS_CAP);
}

// The PROJECTS tree, three levels deep: project → worktree → terminal.
//
// A project is a *repository* wherever git says so — every session inside any
// of that repository's worktrees hangs off one row, instead of appearing as
// unrelated siblings named after their checkout folders. A session outside a
// repository keeps the old shape exactly: its own row, terminals directly
// beneath. See plans/worktrees-into-projects.md.

// One worktree under a project. `sessions` are the sessions rooted at or
// under it — several is normal (the extension this replaces picked a single
// owner; the tree shows them all, the same way same-folder sessions already
// merge into one row).
export interface WorktreeNode {
  key: string;
  // The repository this worktree belongs to. git commands are run from here
  // rather than from the worktree itself, which may be missing (prunable).
  repo: string;
  worktree: WorktreeInfo;
  label: string;
  pinned: boolean;
  sessions: TerminalSession[];
}

// One project row: a repository with worktrees, or a plain folder whose
// sessions sit directly under it. Pinned projects with no live session are
// not rows; they are listed in the Open Recent menu.
//
// `sessions` and `worktrees` are mutually exclusive in practice: a repository
// project puts every session on a worktree node, a plain-folder project has
// no worktrees. `cwd` is the folder the row opens (null only for a pathless
// session, which has no folder to open).
export interface ProjectNode {
  key: string;
  cwd: string | null;
  label: string;
  pinned: boolean;
  sessions: TerminalSession[];
  worktrees: WorktreeNode[];
}

// A repository's worktree level is only worth showing when there is more than
// one worktree: a single-checkout project would otherwise pay an indent and a
// row for information it doesn't have. The level appears the moment a second
// worktree exists.
function hasWorktreeLevel(repo: RepoInfo | undefined): repo is RepoInfo {
  return repo !== undefined && repo.worktrees.length > 1;
}

// Which worktree a folder sits in: the longest worktree path that the folder
// is at or under. Longest wins because the default location nests worktrees
// *inside* the repository, so `~/app` is a prefix of `~/app/.worktrees/x` and
// the shorter match would swallow the nested one.
export function worktreeForPath(worktrees: WorktreeInfo[], cwd: string): WorktreeInfo | undefined {
  let best: WorktreeInfo | undefined;
  for (const wt of worktrees) {
    if (cwd !== wt.path && !cwd.startsWith(wt.path + "/")) continue;
    if (!best || wt.path.length > best.path.length) best = wt;
  }
  return best;
}

// A worktree's display name: its branch, else a short detached head, else the
// checkout's folder name.
export function worktreeLabel(wt: WorktreeInfo): string {
  if (wt.branch) return wt.branch;
  if (wt.detached) return `(detached ${wt.head?.slice(0, 7) ?? "?"})`;
  return projectName(wt.path);
}

// Live projects, in the listing order of the first session that put each one on
// screen. Matching is by path throughout, so an out-of-band
// renaming a session can't orphan a pin.
export function projectTree(
  sessions: TerminalSession[],
  projects: Project[],
  repoIndex: Map<string, RepoInfo>,
): ProjectNode[] {
  const pinnedCwds = new Set(projects.filter((p) => p.pinned).map((p) => p.cwd));
  const nodes: ProjectNode[] = [];
  // Repository projects, keyed by repo root; plain-folder projects, keyed by
  // the folder itself. A path always starts with "/" or "~" and a pathless
  // session falls back to its name, so the namespaces can't collide.
  const byKey = new Map<string, ProjectNode>();

  for (const session of sessions) {
    const repo = session.path ? repoIndex.get(session.path) : undefined;
    if (hasWorktreeLevel(repo)) {
      let node = byKey.get(repo.repo);
      if (!node) {
        node = {
          key: repo.repo,
          cwd: repo.repo,
          label: projectName(repo.repo),
          pinned: pinnedCwds.has(repo.repo),
          sessions: [],
          // Every worktree of the repository, including ones with no session
          // — that is how a worktree stays reachable after its session dies,
          // and what the retired WORKTREES pane used to show.
          worktrees: repo.worktrees.map((wt) => ({
            key: wt.path,
            repo: repo.repo,
            worktree: wt,
            label: worktreeLabel(wt),
            // The main worktree IS the repository's folder, so its pin is
            // already showing on the project row above it. Repeating it two
            // rows apart in the same subtree reads as two pins, not one.
            pinned: pinnedCwds.has(wt.path) && wt.path !== repo.repo,
            sessions: [],
          })),
        };
        byKey.set(repo.repo, node);
        nodes.push(node);
      }
      const owner = worktreeForPath(repo.worktrees, session.path);
      const target = owner ? node.worktrees.find((w) => w.key === owner.path) : undefined;
      // A session inside the repository but under no worktree git reports
      // (a stale path, a listing race) still belongs to the project rather
      // than vanishing — it hangs off the project row directly.
      if (target) target.sessions.push(session);
      else node.sessions.push(session);
      continue;
    }
    // Not in a repository, or a repository with a single worktree: today's
    // behaviour, unchanged. Same-folder sessions merge into one node;
    // pathless sessions never merge.
    const key = session.path || session.name;
    const existing = session.path ? byKey.get(key) : undefined;
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    const node: ProjectNode = {
      key,
      cwd: session.path || null,
      label: session.path ? projectName(session.path) : session.name,
      pinned: pinnedCwds.has(session.path),
      sessions: [session],
      worktrees: [],
    };
    if (session.path) byKey.set(key, node);
    nodes.push(node);
  }

  return nodes;
}
