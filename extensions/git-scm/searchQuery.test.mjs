// The COMMITS search box's grammar. Runs under plain `node --test` — no
// vitest, same as statusModel.test.mjs and conflictModel.test.mjs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasFilters, parseSearchQuery } from "./searchQuery.mjs";

describe("parseSearchQuery", () => {
  it("treats plain words as message text", () => {
    assert.deepEqual(parseSearchQuery("slim the headers"), {
      grep: "slim the headers",
      author: "",
      path: "",
    });
  });

  it("claims author: and path: terms", () => {
    assert.deepEqual(parseSearchQuery("author:tuan path:server"), {
      grep: "",
      author: "tuan",
      path: "server",
    });
  });

  it("mixes prefixes with message text in any order", () => {
    assert.deepEqual(parseSearchQuery("path:server fix the poll author:tuan"), {
      grep: "fix the poll",
      author: "tuan",
      path: "server",
    });
  });

  it("drops a prefix with no value", () => {
    assert.deepEqual(parseSearchQuery("author: fix"), { grep: "fix", author: "", path: "" });
  });

  it("keeps the last of a repeated prefix", () => {
    assert.equal(parseSearchQuery("author:one author:two").author, "two");
  });

  it("matches a prefix case-insensitively", () => {
    assert.equal(parseSearchQuery("Author:tuan").author, "tuan");
  });

  it("returns an empty parse for whitespace", () => {
    assert.deepEqual(parseSearchQuery("   "), { grep: "", author: "", path: "" });
  });

  it("collapses runs of whitespace between words", () => {
    assert.equal(parseSearchQuery("one    two").grep, "one two");
  });

  it("leaves a bare colon term as message text", () => {
    assert.equal(parseSearchQuery("fix: the poll").grep, "fix: the poll");
  });

  it("handles a null-ish box", () => {
    assert.deepEqual(parseSearchQuery(""), { grep: "", author: "", path: "" });
  });
});

describe("hasFilters", () => {
  it("is false for an empty parse", () => {
    assert.equal(hasFilters(parseSearchQuery("author:")), false);
  });

  it("is true when any field is set", () => {
    assert.equal(hasFilters(parseSearchQuery("path:server")), true);
    assert.equal(hasFilters(parseSearchQuery("words")), true);
  });
});
