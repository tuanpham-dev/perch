// Pure pieces of terminal file-link resolution (see the resolve-paths and
// pane-lines routes in api.ts): the order a relative candidate is looked up
// in, which pane a screen cell falls in, and how tmux's wrapped rows group
// into logical lines. Kept free of tmux/fs calls so the rules are testable.
import path from "node:path";
import { expandHome } from "./files.js";

export interface ResolveDeps {
  isFile: (p: string) => Promise<boolean>;
  gitRoot: (dir: string) => Promise<string | null>;
}

// First regular file wins, in this order: the pane cwd, the git top-level
// of that cwd (paths printed relative to the repo while the shell sits in a
// subfolder), then the same two with a git diff "a/" or "b/" prefix removed.
// The literal path is always tried before the stripped one, so a real
// directory named "a" still wins.
export async function resolveLinkPath(raw: string, cwd: string, deps: ResolveDeps): Promise<string | null> {
  const expanded = expandHome(raw);
  if (path.isAbsolute(expanded)) return (await deps.isFile(expanded)) ? expanded : null;

  const root = await deps.gitRoot(cwd);
  const bases = root && root !== cwd ? [cwd, root] : [cwd];
  const rels = /^[ab]\//.test(expanded) ? [expanded, expanded.slice(2)] : [expanded];
  for (const rel of rels) {
    for (const base of bases) {
      const abs = path.join(base, rel);
      if (await deps.isFile(abs)) return abs;
    }
  }
  return null;
}

export interface PaneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ScreenCell {
  row: number;
  col: number;
}

// Edges are inclusive, matching tmux's pane_left/top/right/bottom.
export function paneAtCell<T extends PaneRect>(panes: T[], cell: ScreenCell): T | undefined {
  return panes.find(
    (p) => cell.col >= p.left && cell.col <= p.right && cell.row >= p.top && cell.row <= p.bottom,
  );
}

export interface WrappedGroup {
  firstRow: number;
  lastRow: number;
  text: string;
}

// Groups `capture-pane -N` rows (one per screen row, trailing spaces kept)
// into the logical lines `capture-pane -J` reports for the same range. A
// wrapped row is always full, so a logical line is exactly the concatenation
// of its rows; rows keep being appended while they're still a prefix of it.
// Row indices are relative to the start of the capture.
export function groupWrappedRows(plain: string[], joined: string[]): WrappedGroup[] {
  const groups: WrappedGroup[] = [];
  let r = 0;
  for (const line of joined) {
    if (r >= plain.length) break;
    const target = line.trimEnd();
    const firstRow = r;
    let acc = plain[r++];
    while (acc.trimEnd() !== target && r < plain.length && line.startsWith(acc)) {
      acc += plain[r++];
    }
    groups.push({ firstRow, lastRow: r - 1, text: line });
  }
  return groups;
}
