import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Thrown by renamePath/createEmptyFile when the destination already exists,
// so callers can map it to a 409 instead of a generic 400.
export class ConflictError extends Error {
  constructor(message = "a file or folder with that name already exists") {
    super(message);
    this.name = "ConflictError";
  }
}

// os.homedir(), not $HOME: Windows has USERPROFILE instead.
const HOME = homedir();

export function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(HOME, p.slice(2));
  return p;
}

// Inverse of expandHome: collapses a leading $HOME to "~" so paths handed back
// to the client match the home-shortened form window cwds already arrive in
// (session paths are shortened the same way).
export function shortenHome(p: string): string {
  if (HOME && (p === HOME || p.startsWith(HOME + path.sep))) {
    return "~" + p.slice(HOME.length);
  }
  return p;
}

// Shells out to git in `cwd`, rejecting on non-zero exit with git's stderr.
// Shared by getGitRoot and listRepoFiles (git as a files-feature
// implementation detail — SCM decorations live in the git-scm extension).
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

// The git repository root containing dirPath, or null when dirPath isn't
// inside a work tree (or git isn't available). Roots the FILES panel at the
// repo rather than the pane's cwd. Returned unshortened; callers apply
// shortenHome as needed.
export async function getGitRoot(dirPath: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], dirPath)).trim();
  } catch {
    return null;
  }
}

// Subsequence match (VS Code Ctrl+P style): every query character must appear
// in the text in order, not necessarily contiguous. Returns null on no match,
// otherwise a score where higher is a better match — consecutive runs and
// matches right after a path/word separator score higher, scattered matches
// score lower, so "config" ranks "src/config.ts" above
// "src/some-other-configuration.ts". Kept in sync with the client copy in
// client/src/components/QuickSwitcher.tsx so server-filtered file search
// ranks identically to the client-side filtering used for other groups.
const SEPARATORS = new Set(["/", "-", "_", ".", " "]);

export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let run = 0;
  let lastTi = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (lastTi === ti - 1) {
      run++;
      score += run * 5;
    } else {
      run = 0;
    }
    if (ti === 0 || SEPARATORS.has(t[ti - 1])) score += 10;
    lastTi = ti;
    qi++;
  }
  if (qi !== q.length) return null;
  // Tie-break toward shorter, tighter matches (e.g. an exact filename over a
  // long path that happens to contain the same subsequence).
  return score - t.length * 0.1;
}

export interface FsEntry {
  name: string;
  dir: boolean;
}

export async function listDir(dirPath: string): Promise<FsEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  // A dirent reports a symlink as a symlink, whatever it points at, so a
  // linked folder (a `.backups -> /elsewhere` link, say) would list as a file
  // and never expand. Resolve those through stat, which follows the link; a
  // dangling one stays a file.
  const listed = await Promise.all(
    entries
      .filter((e) => e.name !== ".git")
      .map(async (e) => ({
        name: e.name,
        dir: e.isSymbolicLink() ? await isDirectory(path.join(dirPath, e.name)) : e.isDirectory(),
      })),
  );
  return listed
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// When filtering (match given), the number of files *scanned* is bounded so a
// per-keystroke search over a giant non-git directory — where only a handful
// of matches may live deep in the tree — can't stall the request. Unbounded
// when listing everything (match omitted): the `cap` on collected files is the
// only limit then, matching the original behavior.
const MAX_WALK_VISITED = 50_000;

// Recursive fallback for the quick switcher's file search when rootDir isn't
// inside a git repo (so there's no .gitignore-aware `git ls-files` to lean
// on). Walks depth-first, skipping ".git". With `score`, every match within
// the scan budget is collected and ranked (see rankMatches) rather than
// returning the first `cap` encountered in walk order, so a good match deep
// in the tree isn't shadowed by weaker matches the walk happens to visit
// first. Without `score` (full listing), stops as soon as it hits cap.
export async function walkFiles(
  rootDir: string,
  cap: number,
  score?: (rel: string) => number | null,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const scored: { rel: string; score: number }[] = [];
  let truncated = false;
  let visited = 0;

  async function walk(dirPath: string, relPrefix: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === ".git") continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dirPath, entry.name), rel);
      } else if (score) {
        if (++visited > MAX_WALK_VISITED) {
          truncated = true;
          return;
        }
        const s = score(rel);
        if (s !== null) scored.push({ rel, score: s });
      } else {
        if (files.length >= cap) {
          truncated = true;
          return;
        }
        files.push(rel);
      }
    }
  }

  await walk(rootDir, "");
  if (score) return rankMatches(scored, cap, truncated);
  return { files, truncated };
}

// Sorts scored matches best-first and caps to `cap`, folding in whether the
// underlying scan already stopped early (a truncated scan may be missing
// matches that would have outranked what we kept).
function rankMatches(
  scored: { rel: string; score: number }[],
  cap: number,
  scanTruncated: boolean,
): { files: string[]; truncated: boolean } {
  scored.sort((a, b) => b.score - a.score);
  return {
    files: scored.slice(0, cap).map((m) => m.rel),
    truncated: scanTruncated || scored.length > cap,
  };
}

// Joins baseDir + relativePath, rejecting any relative path that is absolute
// or escapes baseDir via "..". Both uploads and mkdir route through this so
// a crafted relative path can't write outside the chosen destination.
export function resolveDestination(baseDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("path must be relative");
  }
  const resolved = path.resolve(baseDir, relativePath);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("path escapes destination directory");
  }
  return resolved;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Finds the next free "name (N).ext" for a path that already exists.
export async function uniquePath(target: string): Promise<string> {
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let n = 1;
  let candidate: string;
  do {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  } while (await exists(candidate));
  return candidate;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

// Renames within the same parent directory only; newName is a basename, not
// a path, so a crafted "../escape" can't move the entry elsewhere.
export async function renamePath(targetPath: string, newName: string): Promise<string> {
  if (!newName || newName.includes("/") || newName === "." || newName === "..") {
    throw new Error("invalid name");
  }
  const dest = path.join(path.dirname(targetPath), newName);
  if (await exists(dest)) {
    throw new ConflictError();
  }
  await rename(targetPath, dest);
  return dest;
}

export async function deletePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true });
}

export async function createEmptyFile(target: string): Promise<void> {
  if (await exists(target)) {
    throw new ConflictError();
  }
  await writeFile(target, "");
}

// True if child is parent itself or nested anywhere under it — separator-
// safe (unlike a plain startsWith, "/foo-bar" isn't considered inside "/foo").
export function isInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p + path.sep);
}

// Copies src into destDir, auto-renaming on a name collision (uniquePath).
// Rejects copying a folder into itself or one of its own descendants.
export async function copyPath(src: string, destDir: string): Promise<string> {
  if (isInside(src, destDir)) {
    throw new Error("cannot copy a folder into itself");
  }
  const target = await uniquePath(path.join(destDir, path.basename(src)));
  await cp(src, target, { recursive: true });
  return target;
}

// Moves src into destDir, auto-renaming on a name collision (uniquePath).
// Returns null for a no-op (destDir is already src's parent). Rejects moving
// a folder into itself or one of its own descendants. rename() fails across
// filesystems/mounts (EXDEV) — falls back to a copy+delete in that case.
export async function movePath(src: string, destDir: string): Promise<string | null> {
  if (path.resolve(path.dirname(src)) === path.resolve(destDir)) {
    return null;
  }
  if (isInside(src, destDir)) {
    throw new Error("cannot move a folder into itself");
  }
  const target = await uniquePath(path.join(destDir, path.basename(src)));
  try {
    await rename(src, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(src, target, { recursive: true });
    await rm(src, { recursive: true });
  }
  return target;
}

// Lists every file under dirPath that isn't gitignored (tracked +
// untracked), for the quick switcher's file search — a files-feature fast
// path that shells out to git as an implementation detail (moved here from
// the old server/src/git.ts when SCM decorations became the git-scm
// extension's job). Returns null when dirPath isn't inside a git repo so
// the caller can fall back to a plain directory walk. Run with cwd =
// dirPath (not the repo root) so git scopes and returns paths relative to
// dirPath itself, matching what the fallback walker would produce. With
// `score`, every match is collected and ranked (see rankMatches) instead of
// taking the first `cap` in git's listing order, so a strong match later in
// the listing isn't shadowed by weaker matches earlier in it.
export async function listRepoFiles(
  dirPath: string,
  cap: number,
  score?: (rel: string) => number | null,
): Promise<{ files: string[]; truncated: boolean } | null> {
  try {
    await git(["rev-parse", "--show-toplevel"], dirPath);
  } catch {
    return null;
  }

  let out: string;
  try {
    out = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], dirPath);
  } catch {
    return null;
  }

  if (score) {
    const scored: { rel: string; score: number }[] = [];
    for (const token of out.split("\0")) {
      if (!token) continue;
      const s = score(token);
      if (s !== null) scored.push({ rel: token, score: s });
    }
    return rankMatches(scored, cap, false);
  }

  const files: string[] = [];
  let truncated = false;
  for (const token of out.split("\0")) {
    if (!token) continue;
    if (files.length >= cap) {
      truncated = true;
      break;
    }
    files.push(token);
  }
  return { files, truncated };
}
