import { describe, it, expect } from "vitest";
import { thumbGeometry, lineForThumbTop, MIN_THUMB } from "./scrollThumb";

describe("thumbGeometry", () => {
  it("has nothing to show when everything fits", () => {
    // A scrollbar that is always there and never moves is furniture.
    expect(thumbGeometry({ total: 24, rows: 24, viewportY: 0, trackHeight: 200 })).toBeNull();
    expect(thumbGeometry({ total: 10, rows: 24, viewportY: 0, trackHeight: 200 })).toBeNull();
  });

  it("has nothing to show before the track has been measured", () => {
    expect(thumbGeometry({ total: 500, rows: 24, viewportY: 0, trackHeight: 0 })).toBeNull();
  });

  it("sizes the thumb by how much of the buffer is visible", () => {
    // A quarter visible, so a quarter of the track.
    expect(thumbGeometry({ total: 400, rows: 100, viewportY: 0, trackHeight: 400 })?.height).toBe(100);
  });

  it("keeps the thumb grabbable in a long scrollback", () => {
    const thumb = thumbGeometry({ total: 100000, rows: 24, viewportY: 0, trackHeight: 400 });
    expect(thumb?.height).toBe(MIN_THUMB);
  });

  it("sits at the top when scrolled to the top", () => {
    expect(thumbGeometry({ total: 400, rows: 100, viewportY: 0, trackHeight: 400 })?.top).toBe(0);
  });

  it("sits flush at the bottom when scrolled to the end", () => {
    // The thumb travels the track minus its own height, so its bottom edge
    // lands on the track's bottom exactly when the last line shows.
    const thumb = thumbGeometry({ total: 400, rows: 100, viewportY: 300, trackHeight: 400 })!;
    expect(thumb.top + thumb.height).toBe(400);
  });

  it("sits halfway at the halfway point", () => {
    const thumb = thumbGeometry({ total: 400, rows: 100, viewportY: 150, trackHeight: 400 })!;
    expect(thumb.top).toBe(150);
  });

  it("clamps a viewport past the end", () => {
    // xterm can report a viewportY past the last screenful mid-resize.
    const thumb = thumbGeometry({ total: 400, rows: 100, viewportY: 9999, trackHeight: 400 })!;
    expect(thumb.top + thumb.height).toBe(400);
  });
});

describe("lineForThumbTop", () => {
  const buffer = { total: 400, rows: 100, trackHeight: 400 };

  it("maps the top of the track to the first line", () => {
    expect(lineForThumbTop(0, buffer)).toBe(0);
  });

  it("maps the bottom of the track to the last screenful", () => {
    // Not one line short of it, which is what an off-by-one here feels like.
    expect(lineForThumbTop(400, buffer)).toBe(300);
  });

  it("round-trips with thumbGeometry", () => {
    for (const viewportY of [0, 37, 150, 299, 300]) {
      const thumb = thumbGeometry({ ...buffer, viewportY })!;
      expect(lineForThumbTop(thumb.top, buffer)).toBe(viewportY);
    }
  });

  it("clamps a drag past either end", () => {
    expect(lineForThumbTop(-500, buffer)).toBe(0);
    expect(lineForThumbTop(9999, buffer)).toBe(300);
  });

  it("has nowhere to go when everything fits", () => {
    expect(lineForThumbTop(50, { total: 10, rows: 24, trackHeight: 400 })).toBe(0);
  });
});
