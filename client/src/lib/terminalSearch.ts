// Searching a terminal's scrollback.
//
// The scrollback lives in the browser, so this never round-trips to the server
// — which is the point of keeping it here. What's in this file is the part
// worth testing: finding matches across a buffer of lines and stepping through
// them. Reading lines out of xterm and selecting a hit are the caller's job.

export interface Match {
  /** Absolute line index in the buffer, scrollback included. */
  line: number;
  /** Column the match starts at. */
  column: number;
  length: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the matcher for a query. Returns null for an empty query or a regex
 * that doesn't compile — a broken pattern should leave the previous results
 * alone rather than throwing while the user is still typing it.
 */
export function buildMatcher(query: string, options: SearchOptions = {}): RegExp | null {
  if (query === "") return null;
  const body = options.regex ? query : escapeRegExp(query);
  const pattern = options.wholeWord ? `\\b(?:${body})\\b` : body;
  try {
    return new RegExp(pattern, options.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** Every match in the buffer, in reading order. */
export function findMatches(lines: readonly string[], query: string, options: SearchOptions = {}): Match[] {
  const matcher = buildMatcher(query, options);
  if (!matcher) return [];

  const matches: Match[] = [];
  lines.forEach((text, line) => {
    matcher.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.exec(text)) !== null) {
      // A pattern that can match nothing (e.g. "a*") would loop forever on a
      // zero-length hit; step past it instead.
      if (m[0].length === 0) { matcher.lastIndex++; continue; }
      matches.push({ line, column: m.index, length: m[0].length });
    }
  });
  return matches;
}

/**
 * The index to move to when stepping through matches, wrapping at both ends.
 * Returns -1 when there is nothing to step to.
 *
 * `current` of -1 means nothing is selected yet: "next" starts at the first
 * match and "previous" at the last, which is what a search box does when you
 * hit Enter having typed a query and never navigated.
 */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}

/** "3 of 17", or a plain statement when there are none — a search box that
 *  silently shows nothing leaves you wondering whether it ran. */
export function matchLabel(current: number, total: number): string {
  if (total === 0) return "No results";
  return `${current + 1} of ${total}`;
}
