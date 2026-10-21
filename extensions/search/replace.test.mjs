// Replace works on whole lines, so a regex sees what's around each match,
// and "replace this match" finds it by its place in the untrimmed line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expandReplacement, replaceInLine } from "./server.js";

test("lookbehind sees the line around the match", () => {
  const out = replaceInLine("ab cb", /(?<=a)b/g, true, "X", () => true);
  assert.equal(out.line, "aX cb");
  assert.equal(out.replaced, 1);
});

test("groups, named groups and $& expand per match", () => {
  assert.equal(replaceInLine("foo=1 bar=2", /(\w+)=(\d)/g, true, "$2:$1", () => true).line, "1:foo 2:bar");
  assert.equal(replaceInLine("k=v", /(?<key>\w)=(?<val>\w)/g, true, "$<val>$<key>", () => true).line, "vk");
  assert.equal(replaceInLine("ab", /b/g, true, "[$&]", () => true).line, "a[b]");
});

test("only the wanted match is replaced", () => {
  const out = replaceInLine("x x x", /x/g, false, "y", (start) => start === 2);
  assert.equal(out.line, "x y x");
  assert.equal(out.replaced, 1);
});

test("plain mode inserts $ literally", () => {
  assert.equal(replaceInLine("a", /a/g, false, "$1$&", () => true).line, "$1$&");
});

test("$$ and an out-of-range group", () => {
  assert.equal(expandReplacement("$$-$9", "m", [], undefined, 0, "m"), "$-$9");
});

test("offsets are characters, so a match after non-ASCII text is found", () => {
  const line = "  café = bar";
  const start = line.indexOf("bar");
  assert.equal(replaceInLine(line, /bar/g, false, "baz", (s) => s === start).line, "  café = baz");
});
