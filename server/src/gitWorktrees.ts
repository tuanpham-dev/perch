// Every `git worktree` call core makes: listing them for the PROJECTS tree's
// middle level, and creating/removing them from that tree's own actions.
//
// This is the core home of logic that used to live in the worktrees
// extension's server hook — the tree is a core surface and an extension can't
// contribute rows to it, so the data has to be core's. See
// plans/worktrees-into-projects.md.
//
// git is driven with execFile(cmd, [...]) — never a shell string — since
// branch names and paths are user data. Paths here are absolute throughout;
// the API layer is what translates to and from the `~`-shortened space the
// client lives in.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_TIMEOUT = 15000;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", timeout: GIT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

// One worktree of a repository. Paths are absolute here; the API layer
// shortens them on the way out.
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  // The repository's own checkout — `git worktree list` always reports it
  // first. It can never be removed, and it is the identity of the project
  // row every other worktree nests under.
  main: boolean;
  dirty: boolean;
}

export interface Branch {
  name: string;
  // The worktree that currently has this branch checked out, if any — git
  // refuses to check one branch out in two worktrees, so the create form
  // offers only the unattached ones.
  checkedOutAt: string | null;
}

export interface WorktreeListing {
  // The MAIN worktree's path, not `--show-toplevel` — the group key every
  // session in any of this repo's worktrees shares. null when `dir` isn't
  // inside a repository at all, which is a normal answer, not an error.
  repo: string | null;
  worktrees: WorktreeInfo[];
  branches: Branch[];
}

// The worktree containing `dir` (git's `--show-toplevel`), or null. Note this
// is the *containing* worktree, which for a linked worktree is not the repo —
// use listRepo/mainRepoRoot when the repository's identity is what's wanted.
async function containingWorktree(dir: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], dir)).trim();
  } catch {
    return null;
  }
}

// `git worktree list --porcelain` emits blank-line-separated records of
// "key value" lines: worktree <path>, HEAD <sha>, branch <ref> | detached,
// plus bare/locked/prunable markers. The first record is always the main
// worktree.
export function parseWorktrees(raw: string): WorktreeInfo[] {
  const records: Omit<WorktreeInfo, "main" | "dirty">[] = [];
  let current: Omit<WorktreeInfo, "main" | "dirty"> | null = null;
  for (const line of raw.split("\n")) {
    if (line === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const sep = line.indexOf(" ");
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? "" : line.slice(sep + 1);
    if (key === "worktree") {
      current = { path: value, branch: null, head: null, detached: false, locked: false, prunable: false };
    } else if (!current) continue;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "HEAD") current.head = value;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current) records.push(current);
  return records.map((wt, i) => ({ ...wt, main: i === 0, dirty: false }));
}

async function isDirty(dir: string): Promise<boolean> {
  try {
    return (await git(["status", "--porcelain"], dir)).trim().length > 0;
  } catch {
    // A worktree whose directory is gone (prunable) can't be statted — not
    // dirty as far as the UI is concerned; the prunable flag already tells
    // that story.
    return false;
  }
}

// Local branches, each with the worktree currently checked out at it — drives
// the create form's branch pickers.
async function listBranches(cwd: string): Promise<Branch[]> {
  try {
    const raw = await git(["for-each-ref", "refs/heads", "--format=%(refname:short)\t%(worktreepath)"], cwd);
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, worktreePath] = line.split("\t");
        return { name, checkedOutAt: worktreePath || null };
      });
  } catch {
    // %(worktreepath) needs git >= 2.23; degrade to names only rather than
    // failing the whole listing.
    try {
      const raw = await git(["for-each-ref", "refs/heads", "--format=%(refname:short)"], cwd);
      return raw
        .split("\n")
        .filter(Boolean)
        .map((name) => ({ name, checkedOutAt: null }));
    } catch {
      return [];
    }
  }
}

// Every worktree of the repository containing `dir`. `dirty` and `branches`
// are opt-in: the tree polls the listing every few seconds and one
// `git status` per worktree is the expensive half, while the branch list is
// only ever wanted by the create form.
export async function listWorktrees(
  dir: string,
  opts: { dirty?: boolean; branches?: boolean } = {},
): Promise<WorktreeListing> {
  const anyWorktree = await containingWorktree(dir);
  if (!anyWorktree) return { repo: null, worktrees: [], branches: [] };
  let worktrees: WorktreeInfo[];
  try {
    worktrees = parseWorktrees(await git(["worktree", "list", "--porcelain"], anyWorktree));
  } catch {
    // In a repository but the listing failed (a broken .git, an ancient git):
    // report the containing worktree alone rather than losing the project.
    return {
      repo: anyWorktree,
      worktrees: [
        { path: anyWorktree, branch: null, head: null, detached: false, locked: false, prunable: false, main: true, dirty: false },
      ],
      branches: [],
    };
  }
  const repo = worktrees.find((wt) => wt.main)?.path ?? anyWorktree;
  if (opts.dirty) {
    const dirty = await Promise.all(worktrees.map((wt) => isDirty(wt.path)));
    worktrees = worktrees.map((wt, i) => ({ ...wt, dirty: dirty[i] }));
  }
  return { repo, worktrees, branches: opts.branches ? await listBranches(repo) : [] };
}

// The repository root for `dir`, resolving to the MAIN worktree even when
// `dir` is itself inside a linked one — `--show-toplevel` returns whichever
// worktree `dir` is in, so creating a worktree from inside another worktree
// would otherwise nest the new one under that parent instead of the repo.
export async function mainRepoRoot(dir: string): Promise<string | null> {
  const anyWorktree = await containingWorktree(dir);
  if (!anyWorktree) return null;
  try {
    const worktrees = parseWorktrees(await git(["worktree", "list", "--porcelain"], anyWorktree));
    return worktrees.find((wt) => wt.main)?.path ?? anyWorktree;
  } catch {
    return anyWorktree;
  }
}

// The shared .git directory (identical for every worktree of a repo, unlike
// --git-dir which points at .git/worktrees/<name> inside a linked worktree) —
// where info/exclude lives.
async function gitCommonDir(cwd: string): Promise<string> {
  const raw = (await git(["rev-parse", "--git-common-dir"], cwd)).trim();
  return path.resolve(cwd, raw);
}

// A repository's identity in one git call, for callers that need to know
// whether two directories belong to the same repo *before* paying for a full
// listing — every worktree of a repo shares this path. Null when `dir` isn't
// inside a repository. Not a display value: it names the .git directory, not
// the repo root (that's `listWorktrees(...).repo`).
export async function repoIdentity(dir: string): Promise<string | null> {
  try {
    return await gitCommonDir(dir);
  } catch {
    return null;
  }
}

// Path segment for a branch: "feature/x" would otherwise nest a directory.
function branchSlug(branch: string): string {
  return branch.replace(/[/\\]/g, "-");
}

export const DEFAULT_WORKTREE_LOCATION = "{repo}/.worktrees/{branch}";

export function resolveLocation(template: string, repo: string, branch: string): string {
  const filled = template.replaceAll("{repo}", repo).replaceAll("{branch}", branchSlug(branch));
  return path.resolve(repo, filled);
}

// Keeps an in-repo worktree directory out of `git status` without touching the
// user's committed .gitignore: info/exclude is repo-local and never committed.
// The pattern is the top folder of the resolved location ("/.worktrees/"), or
// the exact relative path when the location sits directly in the repo root.
async function ensureExcluded(repo: string, target: string): Promise<void> {
  const rel = path.relative(repo, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const top = rel.split(path.sep)[0];
  const pattern = rel === top ? `/${top}` : `/${top}/`;
  let excludeFile: string;
  try {
    excludeFile = path.join(await gitCommonDir(repo), "info", "exclude");
  } catch {
    return;
  }
  let current = "";
  try {
    current = fs.readFileSync(excludeFile, "utf8");
  } catch {
    // No info/exclude yet (or unreadable) — created below.
  }
  if (current.split("\n").some((line) => line.trim() === pattern)) return;
  try {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(excludeFile, `${prefix}${pattern}\n`);
  } catch {
    // Best-effort: a read-only .git shouldn't block creating the worktree.
  }
}

// `git worktree remove` deletes the checkout but not the folder holding it, so
// the default "{repo}/.worktrees/{branch}" location leaves an empty
// .worktrees/ behind once the last one goes. Removes that container when it is
// inside the repo, isn't the repo root itself, and is empty — anything else is
// left alone.
function pruneEmptyContainer(repo: string, worktreePath: string): void {
  const parent = path.dirname(worktreePath);
  const rel = path.relative(repo, parent);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  try {
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
    // Not empty, not there, or not ours to remove — nothing to clean up.
  }
}

// Thrown by createWorktree/removeWorktree so the route can map a refusal to
// its own status code instead of a generic 500.
export class WorktreeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WorktreeError";
    this.status = status;
  }
}

// Creates a worktree for `branch` — a new branch off `base` (mode "new") or an
// existing one (mode "existing") — at the location the template resolves to.
// Stops at the checkout: the session is the client's to create.
export async function createWorktree(opts: {
  cwd: string;
  branch: string;
  base?: string;
  mode: "new" | "existing";
  location?: string;
}): Promise<{ path: string; branch: string }> {
  const branch = opts.branch.trim();
  if (!branch) throw new WorktreeError("a branch name is required", 400);
  // mainRepoRoot, not containingWorktree: cwd may itself be inside a linked
  // worktree (creating a second worktree while already in one), and the
  // {repo} template must always resolve against the repo root.
  const repo = await mainRepoRoot(opts.cwd);
  if (!repo) throw new WorktreeError(`${opts.cwd} is not inside a git repository`, 400);
  const template = opts.location?.trim() || DEFAULT_WORKTREE_LOCATION;
  const target = resolveLocation(template, repo, branch);
  if (fs.existsSync(target)) throw new WorktreeError(`${target} already exists`, 409);
  await ensureExcluded(repo, target);
  const base = opts.base?.trim();
  const args =
    opts.mode === "existing"
      ? ["worktree", "add", target, branch]
      : ["worktree", "add", "-b", branch, target, ...(base ? [base] : [])];
  await git(args, repo);
  return { path: target, branch };
}

// Removes a worktree's checkout, keeping its branch — deleting branches is a
// separate, git-scm-sized decision. Any session inside it is expected to have
// been killed by the caller first.
export async function removeWorktree(opts: {
  cwd: string;
  path: string;
  force?: boolean;
}): Promise<{ removed: string }> {
  const repo = await mainRepoRoot(opts.cwd);
  if (!repo) throw new WorktreeError(`${opts.cwd} is not inside a git repository`, 400);
  const worktrees = parseWorktrees(await git(["worktree", "list", "--porcelain"], repo));
  // The gate: only a path git itself reports as a worktree of this repo can
  // be removed, and never the main one.
  const match = worktrees.find((wt) => path.resolve(wt.path) === path.resolve(opts.path));
  if (!match) throw new WorktreeError(`${opts.path} is not a worktree of ${repo}`, 404);
  if (match.main) throw new WorktreeError("the main worktree can't be removed", 400);
  await git(["worktree", "remove", ...(opts.force ? ["--force"] : []), match.path], repo);
  await git(["worktree", "prune"], repo).catch(() => {});
  pruneEmptyContainer(repo, match.path);
  return { removed: match.path };
}

// ---- Clean Up Worktrees ----
//
// Finds the worktrees that are safe to remove in bulk, then removes them. Two
// kinds qualify, and nothing else:
//
//   * "missing": git still lists the worktree but its directory is gone
//     (prunable). Removing it only drops git's stale bookkeeping.
//   * "merged": its checkout is clean and its HEAD is already contained in
//     the main worktree's HEAD, or in that branch's upstream. Nothing in it
//     would be lost; that also covers a worktree created and never used.
//
// Locked, dirty and unmerged worktrees are reported as kept, with the reason,
// so the confirmation can say what it is leaving alone. Branches are always
// kept, the same as removeWorktree. Sessions are the terminal backend's business, not git's:
// the client leaves out any worktree that still has one before applying.

export type CleanupRemoveReason = "missing" | "merged";
export type CleanupKeepReason = "locked" | "dirty" | "unmerged";

export interface CleanupEntry<Reason> {
  path: string;
  branch: string | null;
  reason: Reason;
}

export interface WorktreeCleanupPlan {
  repo: string;
  removable: CleanupEntry<CleanupRemoveReason>[];
  kept: CleanupEntry<CleanupKeepReason>[];
}

async function isAncestor(commit: string, of: string, repo: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", commit, of], repo);
    return true;
  } catch {
    // Exit 1 is "not an ancestor"; anything else (an unknown commit) is
    // treated the same way, which errs on the side of keeping the worktree.
    return false;
  }
}

// The commits a worktree counts as merged into: the main worktree's HEAD and,
// when its branch tracks one, that upstream. The upstream matters because a
// branch merged on the remote shows up there before the local main is pulled.
async function mergeTargets(repo: string): Promise<string[]> {
  const targets: string[] = [];
  try {
    targets.push((await git(["rev-parse", "HEAD"], repo)).trim());
  } catch {
    return targets;
  }
  try {
    const upstream = (await git(["rev-parse", "--verify", "--quiet", "HEAD@{upstream}"], repo)).trim();
    if (upstream) targets.push(upstream);
  } catch {
    // No upstream configured: HEAD alone.
  }
  return targets;
}

export async function planWorktreeCleanup(cwd: string): Promise<WorktreeCleanupPlan> {
  const repo = await mainRepoRoot(cwd);
  if (!repo) throw new WorktreeError(`${cwd} is not inside a git repository`, 400);
  const worktrees = parseWorktrees(await git(["worktree", "list", "--porcelain"], repo));
  const targets = await mergeTargets(repo);
  const plan: WorktreeCleanupPlan = { repo, removable: [], kept: [] };
  await Promise.all(
    worktrees
      .filter((wt) => !wt.main)
      .map(async (wt) => {
        const entry = { path: wt.path, branch: wt.branch };
        if (wt.locked) return plan.kept.push({ ...entry, reason: "locked" });
        if (wt.prunable) return plan.removable.push({ ...entry, reason: "missing" });
        if (await isDirty(wt.path)) return plan.kept.push({ ...entry, reason: "dirty" });
        const head = wt.head;
        let merged = false;
        if (head) {
          for (const target of targets) {
            if (await isAncestor(head, target, repo)) {
              merged = true;
              break;
            }
          }
        }
        if (merged) plan.removable.push({ ...entry, reason: "merged" });
        else plan.kept.push({ ...entry, reason: "unmerged" });
      }),
  );
  // Promise.all settles in completion order; list them the way git does.
  const order = new Map(worktrees.map((wt, i) => [wt.path, i]));
  const byGitOrder = (a: { path: string }, b: { path: string }) =>
    (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0);
  plan.removable.sort(byGitOrder);
  plan.kept.sort(byGitOrder);
  return plan;
}

// Removes the requested worktrees, but only those a fresh plan still calls
// removable: the user confirmed a list that may be seconds old, and a worktree
// that picked up changes since then must not be swept away with the rest. No
// --force anywhere. One refusal doesn't stop the others.
export async function cleanUpWorktrees(opts: {
  cwd: string;
  paths: string[];
}): Promise<{ removed: string[]; skipped: { path: string; error: string }[] }> {
  const plan = await planWorktreeCleanup(opts.cwd);
  const removable = new Map(plan.removable.map((e) => [path.resolve(e.path), e]));
  const removed: string[] = [];
  const skipped: { path: string; error: string }[] = [];
  let pruneNeeded = false;
  for (const requested of opts.paths) {
    const entry = removable.get(path.resolve(requested));
    if (!entry) {
      skipped.push({ path: requested, error: "no longer safe to remove" });
      continue;
    }
    if (entry.reason === "missing") {
      // Nothing on disk to remove; the prune below drops git's record of it.
      pruneNeeded = true;
      removed.push(entry.path);
      continue;
    }
    try {
      await git(["worktree", "remove", entry.path], plan.repo);
      removed.push(entry.path);
      pruneNeeded = true;
    } catch (err) {
      skipped.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (pruneNeeded) await git(["worktree", "prune"], plan.repo).catch(() => {});
  for (const p of removed) pruneEmptyContainer(plan.repo, p);
  return { removed, skipped };
}
