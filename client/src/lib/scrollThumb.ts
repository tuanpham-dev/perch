// Where a terminal's scroll thumb sits, and where a drag of it scrolls to.
//
// The browser's own scrollbar is hidden on the terminal viewport — it is
// styled by the OS, sits outside the theme, and on a touch device it is not
// there at all. This is the arithmetic behind drawing one that belongs to the
// app, kept separate from the DOM so the off-by-ones can be tested.

export interface ThumbInput {
  /** Total lines in the buffer, scrollback included. */
  total: number;
  /** Lines visible at once. */
  rows: number;
  /** Index of the first visible line. */
  viewportY: number;
  /** Height of the track in pixels. */
  trackHeight: number;
}

export interface Thumb {
  /** Pixels from the top of the track. */
  top: number;
  height: number;
}

/** Never smaller than this, or a long scrollback leaves nothing to grab. */
export const MIN_THUMB = 20;

/**
 * The thumb, or null when there is nothing to scroll.
 *
 * Null rather than a full-height thumb: a scrollbar that is always there and
 * never moves is furniture, and the terminal has little enough room as it is.
 */
export function thumbGeometry({ total, rows, viewportY, trackHeight }: ThumbInput): Thumb | null {
  if (total <= rows || trackHeight <= 0) return null;
  const height = Math.max(MIN_THUMB, Math.round((rows / total) * trackHeight));
  // The thumb travels the track minus its own height, so its bottom edge lands
  // at the bottom of the track exactly when the last line is showing.
  const travel = trackHeight - height;
  const maxScroll = total - rows;
  const top = Math.round((Math.min(viewportY, maxScroll) / maxScroll) * travel);
  return { top: Math.max(0, Math.min(travel, top)), height };
}

/**
 * The line to scroll to when the thumb's top edge is dragged to `top`.
 *
 * Inverts thumbGeometry, so dragging to the bottom of the track lands on the
 * last screenful rather than one line short of it.
 */
export function lineForThumbTop(
  top: number,
  { total, rows, trackHeight }: Omit<ThumbInput, "viewportY">,
): number {
  if (total <= rows || trackHeight <= 0) return 0;
  const height = Math.max(MIN_THUMB, Math.round((rows / total) * trackHeight));
  const travel = trackHeight - height;
  const maxScroll = total - rows;
  if (travel <= 0) return maxScroll;
  const clamped = Math.max(0, Math.min(travel, top));
  return Math.round((clamped / travel) * maxScroll);
}
