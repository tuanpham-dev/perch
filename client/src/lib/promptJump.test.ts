import { describe, it, expect } from "vitest";
import { jumpTarget, promptLines } from "./promptJump";

const prompts = [10, 25, 60, 120];

describe("jumpTarget", () => {
  it("finds the nearest prompt above the viewport", () => {
    expect(jumpTarget(prompts, 70, -1)).toBe(60);
  });

  it("finds the nearest prompt below the viewport", () => {
    expect(jumpTarget(prompts, 70, 1)).toBe(120);
  });

  it("keeps moving on repeated jumps", () => {
    // Strictly above, or a second press would land on the same prompt.
    let top = 70;
    top = jumpTarget(prompts, top, -1)!;
    expect(top).toBe(60);
    expect(jumpTarget(prompts, top, -1)).toBe(25);
  });

  it("returns null at the ends rather than clamping", () => {
    // Nothing to do beats scrolling to an end you are already at.
    expect(jumpTarget(prompts, 5, -1)).toBeNull();
    expect(jumpTarget(prompts, 200, 1)).toBeNull();
  });

  it("ignores a prompt exactly at the viewport top when going up", () => {
    expect(jumpTarget(prompts, 60, -1)).toBe(25);
  });

  it("ignores a prompt exactly at the viewport top when going down", () => {
    expect(jumpTarget(prompts, 60, 1)).toBe(120);
  });

  it("returns null with no prompts recorded", () => {
    expect(jumpTarget([], 50, -1)).toBeNull();
    expect(jumpTarget([], 50, 1)).toBeNull();
  });
});

describe("promptLines", () => {
  it("sorts what the markers report", () => {
    // Markers are disposed and re-created as the buffer trims, so the order
    // they come back in is not the order they were made.
    expect(promptLines([30, 10, 20])).toEqual([10, 20, 30]);
  });

  it("de-duplicates", () => {
    expect(promptLines([10, 10, 20])).toEqual([10, 20]);
  });

  it("handles an empty list", () => {
    expect(promptLines([])).toEqual([]);
  });

  it("doesn't mutate its input", () => {
    const list = [30, 10];
    promptLines(list);
    expect(list).toEqual([30, 10]);
  });
});
