// Hand-written declarations for conflictModel.mjs (plain JS so it can be
// tested with plain `node --test`; the client bundles it via esbuild).
export interface ConflictBlock {
  kind: "conflict";
  start: number; // index of the "<<<<<<<" line
  end: number; // index of the ">>>>>>>" line (inclusive)
  oursLabel: string;
  theirsLabel: string;
  ours: string[];
  base?: string[];
  baseLabel?: string;
  theirs: string[];
}

export interface TextRun {
  kind: "text";
  start: number;
  end: number; // inclusive
}

export type ConflictSegment = ConflictBlock | TextRun;

export type ResolutionChoice = "ours" | "theirs" | "both";

// Keyed by ConflictBlock.start (unique within one load's line numbering,
// and stable across re-renders since `lines`/`segments` don't change until
// a Save triggers a fresh load).
export type ResolutionMap = Record<number, ResolutionChoice>;

export function parseConflictSegments(lines: string[]): ConflictSegment[];
export function buildResolvedContent(
  lines: string[],
  segments: ConflictSegment[],
  resolutions: ResolutionMap,
): string;
