// Hand-written declarations for statusModel.mjs (plain JS so server.js can
// import it without a build step; the client bundles it via esbuild).
export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "conflicted"
  | "ignored";

export function classify(code: string): GitFileStatus;
export const PRIORITY: GitFileStatus[];
export const RANK: Record<GitFileStatus, number>;
export function buildDirStatuses(statuses: Map<string, GitFileStatus>): Map<string, GitFileStatus>;
export function statusForEntry(
  statuses: Map<string, GitFileStatus>,
  dirStatuses: Map<string, GitFileStatus>,
  trackedDirs: Set<string>,
  relPath: string,
  isDir: boolean,
): GitFileStatus | undefined;
