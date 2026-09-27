import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_CHANNELS,
  CORE_CHANNEL,
  MAX_LINES,
  appendLog,
  clearLog,
  listChannels,
  readLog,
  resetLogChannels,
} from "./logChannels.js";

beforeEach(() => resetLogChannels());

describe("appendLog / readLog", () => {
  it("keeps lines in order with increasing seq and the given time", () => {
    appendLog("a", "one", 10);
    appendLog("a", "two", 20);
    expect(readLog("a")).toEqual({
      lines: [
        { seq: 1, at: 10, channel: "a", text: "one" },
        { seq: 2, at: 20, channel: "a", text: "two" },
      ],
      cursor: 2,
    });
  });

  it("splits a multi-line message into one entry per line", () => {
    appendLog("a", "first\nsecond", 5);
    expect(readLog("a").lines.map((l) => l.text)).toEqual(["first", "second"]);
  });

  it("answers only the lines after `since`", () => {
    appendLog("a", "one");
    appendLog("a", "two");
    appendLog("a", "three");
    const { lines, cursor } = readLog("a", 2);
    expect(lines.map((l) => l.text)).toEqual(["three"]);
    expect(cursor).toBe(3);
    expect(readLog("a", cursor).lines).toEqual([]);
    appendLog("a", "four");
    expect(readLog("a", cursor).lines.map((l) => l.text)).toEqual(["four"]);
  });

  it("keeps at most MAX_LINES per channel, dropping the oldest", () => {
    for (let i = 0; i < MAX_LINES + 5; i++) appendLog("a", `line ${i}`);
    const { lines } = readLog("a");
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines[0].text).toBe("line 5");
    expect(lines[lines.length - 1].text).toBe(`line ${MAX_LINES + 4}`);
  });

  it("keeps channels apart and reads an unknown one as empty", () => {
    appendLog("a", "one");
    appendLog("b", "two");
    expect(readLog("a").lines.map((l) => l.text)).toEqual(["one"]);
    expect(readLog("b").lines.map((l) => l.text)).toEqual(["two"]);
    expect(readLog("nope").lines).toEqual([]);
  });
});

describe("readLog with ALL_CHANNELS", () => {
  it("merges every channel in arrival order, each line naming its channel", () => {
    appendLog("a", "one");
    appendLog("b", "two");
    appendLog("a", "three");
    const { lines, cursor } = readLog(ALL_CHANNELS);
    expect(lines.map((l) => `${l.channel}:${l.text}`)).toEqual(["a:one", "b:two", "a:three"]);
    expect(cursor).toBe(3);
    expect(readLog(ALL_CHANNELS, 2).lines.map((l) => l.text)).toEqual(["three"]);
  });

  it("clears every channel", () => {
    appendLog("a", "one");
    appendLog("b", "two");
    clearLog(ALL_CHANNELS);
    expect(readLog("a").lines).toEqual([]);
    expect(readLog("b").lines).toEqual([]);
  });
});

describe("clearLog", () => {
  it("empties one channel and leaves the others", () => {
    appendLog("a", "one");
    appendLog("b", "two");
    clearLog("a");
    expect(readLog("a").lines).toEqual([]);
    expect(readLog("b").lines).toHaveLength(1);
    // The channel still exists for the picker.
    expect(listChannels()).toContain("a");
  });
});

describe("listChannels", () => {
  it("lists the core channel first even before anything logged to it", () => {
    expect(listChannels()).toEqual([CORE_CHANNEL]);
    appendLog("zeta", "z");
    appendLog("alpha", "a");
    appendLog(CORE_CHANNEL, "core");
    expect(listChannels()).toEqual([CORE_CHANNEL, "alpha", "zeta"]);
  });
});
