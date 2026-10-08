// The release script's changelog drafting (plans/app-versioning.md R20).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entryFor } from "./changelog-entry.mjs";
import { draftEntry, insertEntry } from "./release.mjs";

const day = new Date("2026-10-08T12:00:00Z");

describe("release changelog", () => {
  it("drafts an entry from commit subjects, leaving out release commits", () => {
    assert.equal(draftEntry("0.2.0", ["Add a thing", "Release 0.1.0", "", "Fix a thing"], day), "## 0.2.0 - 2026-10-08\n\n- Add a thing\n- Fix a thing\n");
  });

  it("starts a changelog, then adds newer entries on top", () => {
    const first = insertEntry("", draftEntry("0.1.0", ["One"], day));
    assert.match(first, /^# Changelog\n/);
    const second = insertEntry(first, draftEntry("0.2.0", ["Two"], day));
    assert.ok(second.indexOf("## 0.2.0") < second.indexOf("## 0.1.0"));
    assert.equal(entryFor(second, "v0.2.0"), "- Two");
    assert.equal(entryFor(second, "0.1.0"), "- One");
    assert.equal(entryFor(second, "0.3.0"), null);
  });
});
