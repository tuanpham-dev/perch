// Extracted from client.tsx's ConflictView when conflict-marker parsing
// moved into conflictModel.mjs. Runs under plain `node --test` — no vitest,
// since extensions deliberately have no build/test toolchain beyond esbuild
// bundling. See statusModel.test.mjs for the sibling model's tests.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConflictSegments, buildResolvedContent } from "./conflictModel.mjs";

function lines(text) {
  return text.split("\n");
}

describe("parseConflictSegments — 2-way conflicts", () => {
  it("parses a single 2-way conflict with surrounding text", () => {
    const content = ["before", "<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> branch", "after"];
    const segments = parseConflictSegments(content);
    assert.deepEqual(segments, [
      { kind: "text", start: 0, end: 0 },
      {
        kind: "conflict",
        start: 1,
        end: 5,
        oursLabel: "HEAD",
        theirsLabel: "branch",
        ours: ["mine"],
        base: undefined,
        baseLabel: undefined,
        theirs: ["theirs"],
      },
      { kind: "text", start: 6, end: 6 },
    ]);
  });

  it("parses multiple conflict blocks in one file", () => {
    const content = [
      "start",
      "<<<<<<< HEAD",
      "a1",
      "=======",
      "b1",
      ">>>>>>> branch",
      "middle",
      "<<<<<<< HEAD",
      "a2",
      "=======",
      "b2",
      ">>>>>>> branch",
      "end",
    ];
    const segments = parseConflictSegments(content);
    const blocks = segments.filter((s) => s.kind === "conflict");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].start, 1);
    assert.equal(blocks[0].end, 5);
    assert.equal(blocks[1].start, 7);
    assert.equal(blocks[1].end, 11);
    const textRuns = segments.filter((s) => s.kind === "text");
    assert.deepEqual(
      textRuns.map((t) => [t.start, t.end]),
      [
        [0, 0],
        [6, 6],
        [12, 12],
      ],
    );
  });

  it("has no leading text segment when the file starts with a conflict", () => {
    const content = ["<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> branch"];
    const segments = parseConflictSegments(content);
    assert.equal(segments[0].kind, "conflict");
    assert.equal(segments.length, 1);
  });
});

describe("parseConflictSegments — diff3/zdiff3 3-way conflicts", () => {
  it("captures the base section between ||||||| and =======", () => {
    const content = ["<<<<<<< HEAD", "mine", "||||||| merged common ancestors", "orig", "=======", "theirs", ">>>>>>> branch"];
    const segments = parseConflictSegments(content);
    const block = segments.find((s) => s.kind === "conflict");
    assert.equal(block.baseLabel, "merged common ancestors");
    assert.deepEqual(block.base, ["orig"]);
    assert.deepEqual(block.ours, ["mine"]);
    assert.deepEqual(block.theirs, ["theirs"]);
  });

  it("multi-line ours/base/theirs sections", () => {
    const content = [
      "<<<<<<< HEAD",
      "mine1",
      "mine2",
      "|||||||",
      "orig1",
      "orig2",
      "=======",
      "theirs1",
      "theirs2",
      ">>>>>>> branch",
    ];
    const block = parseConflictSegments(content).find((s) => s.kind === "conflict");
    assert.deepEqual(block.ours, ["mine1", "mine2"]);
    assert.deepEqual(block.base, ["orig1", "orig2"]);
    assert.deepEqual(block.theirs, ["theirs1", "theirs2"]);
  });
});

describe("parseConflictSegments — malformed markers", () => {
  it("treats an unterminated conflict (no =======) as trailing plain text", () => {
    const content = ["before", "<<<<<<< HEAD", "mine", "no closer here"];
    const segments = parseConflictSegments(content);
    assert.equal(segments.length, 1);
    assert.deepEqual(segments[0], { kind: "text", start: 0, end: 3 });
  });

  it("treats a conflict missing its closing >>>>>>> as trailing plain text", () => {
    const content = ["before", "<<<<<<< HEAD", "mine", "=======", "theirs", "no closer here"];
    const segments = parseConflictSegments(content);
    assert.equal(segments.length, 1);
    assert.deepEqual(segments[0], { kind: "text", start: 0, end: 5 });
  });

  it("treats an unterminated base section as trailing plain text", () => {
    const content = ["<<<<<<< HEAD", "mine", "|||||||", "orig", "no closer here"];
    const segments = parseConflictSegments(content);
    assert.equal(segments.length, 1);
    assert.deepEqual(segments[0], { kind: "text", start: 0, end: 4 });
  });
});

describe("parseConflictSegments — CRLF line endings", () => {
  it("recognizes markers whose lines carry a trailing \\r", () => {
    const content = ["before\r", "<<<<<<< HEAD\r", "mine\r", "=======\r", "theirs\r", ">>>>>>> branch\r", "after\r"];
    const segments = parseConflictSegments(content);
    const block = segments.find((s) => s.kind === "conflict");
    assert.ok(block, "conflict block should be recognized despite CRLF line endings");
    // Labels are CR-stripped (user-facing text), but ours/theirs content
    // keeps each line's original bytes, CR included.
    assert.equal(block.oursLabel, "HEAD");
    assert.equal(block.theirsLabel, "branch");
    assert.deepEqual(block.ours, ["mine\r"]);
    assert.deepEqual(block.theirs, ["theirs\r"]);
  });

  it("round-trips a resolved CRLF file back through buildResolvedContent", () => {
    const content = ["before\r", "<<<<<<< HEAD\r", "mine\r", "=======\r", "theirs\r", ">>>>>>> branch\r", "after\r"];
    const segments = parseConflictSegments(content);
    const block = segments.find((s) => s.kind === "conflict");
    const resolved = buildResolvedContent(content, segments, { [block.start]: "ours" });
    assert.equal(resolved, "before\r\nmine\r\nafter\r");
  });

  it("recognizes a CRLF 3-way conflict's base section", () => {
    const content = ["<<<<<<< HEAD\r", "mine\r", "|||||||\r", "orig\r", "=======\r", "theirs\r", ">>>>>>> branch\r"];
    const block = parseConflictSegments(content).find((s) => s.kind === "conflict");
    assert.deepEqual(block.base, ["orig\r"]);
  });
});

describe("parseConflictSegments — file with no trailing newline", () => {
  it("still closes the final conflict block when the last line has no trailing newline", () => {
    // split("\n") on a file with no trailing newline yields no empty final
    // element — the last real line is the last array entry.
    const content = ["<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> branch"];
    const segments = parseConflictSegments(content);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].kind, "conflict");
    assert.equal(segments[0].end, content.length - 1);
  });
});

describe("buildResolvedContent", () => {
  it("keeps unresolved blocks as raw marker text", () => {
    const content = lines("before\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\nafter");
    const segments = parseConflictSegments(content);
    const resolved = buildResolvedContent(content, segments, {});
    assert.equal(resolved, content.join("\n"));
  });

  it("resolves to 'ours' choice", () => {
    const content = lines("<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch");
    const segments = parseConflictSegments(content);
    const resolved = buildResolvedContent(content, segments, { [segments[0].start]: "ours" });
    assert.equal(resolved, "mine");
  });

  it("resolves to 'theirs' choice", () => {
    const content = lines("<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch");
    const segments = parseConflictSegments(content);
    const resolved = buildResolvedContent(content, segments, { [segments[0].start]: "theirs" });
    assert.equal(resolved, "theirs");
  });

  it("resolves to 'both' choice, ours before theirs", () => {
    const content = lines("<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch");
    const segments = parseConflictSegments(content);
    const resolved = buildResolvedContent(content, segments, { [segments[0].start]: "both" });
    assert.equal(resolved, "mine\ntheirs");
  });

  it("resolves multiple blocks independently by their own start key", () => {
    const content = lines(
      "start\n<<<<<<< HEAD\na1\n=======\nb1\n>>>>>>> branch\nmiddle\n<<<<<<< HEAD\na2\n=======\nb2\n>>>>>>> branch\nend",
    );
    const segments = parseConflictSegments(content);
    const blocks = segments.filter((s) => s.kind === "conflict");
    const resolved = buildResolvedContent(content, segments, {
      [blocks[0].start]: "ours",
      [blocks[1].start]: "theirs",
    });
    assert.equal(resolved, "start\na1\nmiddle\nb2\nend");
  });
});
