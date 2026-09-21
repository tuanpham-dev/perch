// Run: node --test extensions/markdown-preview/frontmatter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { scalarText, splitFrontmatter } from "./frontmatter.mjs";

test("lifts a frontmatter block off the body", () => {
  const { meta, body } = splitFrontmatter("---\nname: stop-slop\n---\n\n# Heading\n");
  assert.equal(meta, "name: stop-slop");
  assert.equal(body, "\n# Heading\n");
});

test("keeps the block's own indentation", () => {
  const { meta } = splitFrontmatter("---\nmetadata:\n  type: reference\n---\nbody\n");
  assert.equal(meta, "metadata:\n  type: reference");
});

test("accepts a CRLF file, a BOM and a '...' terminator", () => {
  assert.equal(splitFrontmatter("---\r\nname: a\r\n---\r\nbody").meta, "name: a");
  assert.equal(splitFrontmatter("﻿---\nname: a\n---\nbody").meta, "name: a");
  assert.equal(splitFrontmatter("---\nname: a\n...\nbody").meta, "name: a");
});

test("a file with no block is returned untouched", () => {
  const raw = "# Heading\n\nSome prose with a --- in it.\n";
  assert.deepEqual(splitFrontmatter(raw), { meta: null, body: raw });
});

test("a horizontal rule mid-document is not a block", () => {
  const raw = "Intro\n\n---\n\nMore\n";
  assert.equal(splitFrontmatter(raw).meta, null);
});

test("an unterminated block is left as body rather than eating the file", () => {
  const raw = "---\nname: a\n\n# Heading\n";
  assert.deepEqual(splitFrontmatter(raw), { meta: null, body: raw });
});

test("an empty block is a block, not prose", () => {
  assert.deepEqual(splitFrontmatter("---\n\n---\nbody"), { meta: "", body: "body" });
});

test("scalars and scalar lists reduce to one line", () => {
  assert.equal(scalarText("stop-slop"), "stop-slop");
  assert.equal(scalarText(2), "2");
  assert.equal(scalarText(true), "true");
  assert.equal(scalarText(null), "");
  assert.equal(scalarText(undefined), "");
  assert.equal(scalarText([]), "");
  assert.equal(scalarText(["Read", "Edit"]), "Read, Edit");
  assert.equal(scalarText([1, null, "x"]), "1, , x");
});

test("a map, or a list holding one, keeps its shape", () => {
  assert.equal(scalarText({ type: "reference" }), null);
  assert.equal(scalarText([{ name: "a" }]), null);
});
