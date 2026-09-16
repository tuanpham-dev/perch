// Jumping between shell prompts in the scrollback.
//
// The shell integration already marks where each prompt began (OSC 133;A), and
// local echo already watches for those marks. Recording the line each one
// landed on turns "scroll up looking for where that command started" into one
// keystroke — which is most of what you do when reading back a long session.

/** Prompt line numbers, absolute in the buffer (scrollback included). */
export type PromptLines = readonly number[];

/**
 * The prompt to jump to from the current viewport.
 *
 * Anchored on the top of the viewport rather than the cursor: you are reading,
 * not typing, so "previous" means "the last prompt above what I can see".
 * Returns null when there is nothing further in that direction, so the caller
 * can leave the view alone rather than scrolling to an end you are already at.
 */
export function jumpTarget(prompts: PromptLines, viewportTop: number, direction: 1 | -1): number | null {
  if (direction === -1) {
    // Strictly above the viewport, so repeated jumps keep moving.
    const above = prompts.filter((line) => line < viewportTop);
    return above.length > 0 ? above[above.length - 1]! : null;
  }
  const below = prompts.find((line) => line > viewportTop);
  return below ?? null;
}

/**
 * Sort and de-duplicate the lines read from live markers.
 *
 * The caller holds xterm markers rather than raw numbers — xterm keeps a
 * marker's line correct as the buffer scrolls and disposes it when that line is
 * discarded, which is the whole problem of tracking positions in a trimming
 * scrollback, already solved. This only tidies what they report.
 */
export function promptLines(lines: readonly number[]): number[] {
  return [...new Set(lines)].sort((a, b) => a - b);
}
