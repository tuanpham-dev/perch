import { describe, expect, it } from "vitest";
import { cellFromPoint, encodeSgrMouse, focusReport, WheelLineAccumulator } from "./mouseReports";

describe("encodeSgrMouse", () => {
  it("encodes press/release with M/m finals", () => {
    expect(encodeSgrMouse("press", 0, 1, 1)).toBe("\x1b[<0;1;1M");
    expect(encodeSgrMouse("release", 0, 1, 1)).toBe("\x1b[<0;1;1m");
  });

  it("encodes middle and right buttons", () => {
    expect(encodeSgrMouse("press", 1, 5, 7)).toBe("\x1b[<1;5;7M");
    expect(encodeSgrMouse("press", 2, 5, 7)).toBe("\x1b[<2;5;7M");
  });

  it("adds the motion flag (32) to the held button", () => {
    expect(encodeSgrMouse("motion", 0, 10, 2)).toBe("\x1b[<32;10;2M");
    expect(encodeSgrMouse("motion", 2, 10, 2)).toBe("\x1b[<34;10;2M");
  });

  it("encodes wheel as 64/65, always with the M final", () => {
    expect(encodeSgrMouse("wheelUp", 0, 3, 4)).toBe("\x1b[<64;3;4M");
    expect(encodeSgrMouse("wheelDown", 0, 3, 4)).toBe("\x1b[<65;3;4M");
  });

  it("sets modifier bits: shift=4, alt=8, ctrl=16", () => {
    expect(encodeSgrMouse("press", 0, 1, 1, { shift: true })).toBe("\x1b[<4;1;1M");
    expect(encodeSgrMouse("press", 0, 1, 1, { alt: true })).toBe("\x1b[<8;1;1M");
    expect(encodeSgrMouse("press", 0, 1, 1, { ctrl: true })).toBe("\x1b[<16;1;1M");
    expect(encodeSgrMouse("press", 0, 1, 1, { shift: true, alt: true, ctrl: true })).toBe(
      "\x1b[<28;1;1M",
    );
  });
});

describe("cellFromPoint", () => {
  const rect = { left: 100, top: 50 };

  it("maps pixels to 1-based cells", () => {
    expect(cellFromPoint(100, 50, rect, 9, 16, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(cellFromPoint(109, 66, rect, 9, 16, 80, 24)).toEqual({ col: 2, row: 2 });
    expect(cellFromPoint(100 + 9 * 79 + 4, 50 + 16 * 23 + 8, rect, 9, 16, 80, 24)).toEqual({
      col: 80,
      row: 24,
    });
  });

  it("clamps outside the grid", () => {
    expect(cellFromPoint(0, 0, rect, 9, 16, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(cellFromPoint(10000, 10000, rect, 9, 16, 80, 24)).toEqual({ col: 80, row: 24 });
  });
});

describe("WheelLineAccumulator", () => {
  it("converts pixel deltas via cell height and carries the remainder", () => {
    const acc = new WheelLineAccumulator();
    // 3 events of 10px at 16px cells: 0.625 lines each -> 0, 1, 0 (carry).
    expect(acc.linesFor({ deltaY: 10, deltaMode: 0 }, 16, 24)).toBe(0);
    expect(acc.linesFor({ deltaY: 10, deltaMode: 0 }, 16, 24)).toBe(1);
    expect(acc.linesFor({ deltaY: 10, deltaMode: 0 }, 16, 24)).toBe(0);
    // Next event pushes the carried 0.875 over 1 again.
    expect(acc.linesFor({ deltaY: 10, deltaMode: 0 }, 16, 24)).toBe(1);
  });

  it("carries negative (scroll-up) remainders symmetrically", () => {
    const acc = new WheelLineAccumulator();
    expect(acc.linesFor({ deltaY: -10, deltaMode: 0 }, 16, 24)).toBe(0);
    expect(acc.linesFor({ deltaY: -10, deltaMode: 0 }, 16, 24)).toBe(-1);
  });

  it("passes line-mode deltas through", () => {
    const acc = new WheelLineAccumulator();
    expect(acc.linesFor({ deltaY: 3, deltaMode: 1 }, 16, 24)).toBe(3);
    expect(acc.linesFor({ deltaY: -3, deltaMode: 1 }, 16, 24)).toBe(-3);
  });

  it("multiplies page-mode deltas by rows", () => {
    const acc = new WheelLineAccumulator();
    expect(acc.linesFor({ deltaY: 1, deltaMode: 2 }, 16, 24)).toBe(24);
  });

  it("applies the 5x Alt fast-scroll modifier", () => {
    const acc = new WheelLineAccumulator();
    expect(acc.linesFor({ deltaY: 32, deltaMode: 0, altKey: true }, 16, 24)).toBe(10);
  });

  it("reset drops the partial carry", () => {
    const acc = new WheelLineAccumulator();
    acc.linesFor({ deltaY: 10, deltaMode: 0 }, 16, 24);
    acc.reset();
    expect(acc.linesFor({ deltaY: 10, deltaMode: 0 }, 16, 24)).toBe(0);
  });
});

describe("focusReport", () => {
  it("encodes focus in/out", () => {
    expect(focusReport(true)).toBe("\x1b[I");
    expect(focusReport(false)).toBe("\x1b[O");
  });
});
