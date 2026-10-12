// install.sh picks the release to install with an inline node script
// (PICK_TAG). Bash has to hand that script to node intact, so these run it the
// way install.sh does: bash evaluates the PICK_TAG assignment, then pipes
// `git ls-remote --tags` output into `node -e "$PICK_TAG" <channel>`. Run by
// `npm test`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "./version-files.mjs";

const INSTALL_SH = readFileSync(join(ROOT, "install.sh"), "utf8");

// The PICK_TAG assignment as written in install.sh, from its first line to
// the line that closes it.
function pickTagAssignment() {
  const lines = INSTALL_SH.split("\n");
  const start = lines.findIndex((l) => l.startsWith("PICK_TAG="));
  assert.notEqual(start, -1, "install.sh has no PICK_TAG= line");
  const end = lines.findIndex((l, i) => i >= start && l === ')"');
  return lines.slice(start, end === -1 ? start + 1 : end + 1).join("\n");
}

function pickTag(lsRemote, channel) {
  const script = `${pickTagAssignment()}\nnode -e "$PICK_TAG" "$1"`;
  return execFileSync("bash", ["-c", script, "bash", channel], { input: lsRemote, encoding: "utf8" }).trim();
}

const LS_REMOTE = [
  "aaa\trefs/tags/v0.1.0",
  "bbb\trefs/tags/v0.1.2",
  "bbb\trefs/tags/v0.1.2^{}",
  "ccc\trefs/tags/v0.1.10",
  "ddd\trefs/tags/v0.2.0-rc.1",
  "eee\trefs/tags/not-a-version",
].join("\n");

describe("install.sh tag picker", () => {
  it("picks the newest stable release by SemVer order", () => {
    assert.equal(pickTag(LS_REMOTE, "stable"), "v0.1.10");
  });

  it("includes pre-releases on the beta channel", () => {
    assert.equal(pickTag(LS_REMOTE, "beta"), "v0.2.0-rc.1");
  });

  it("prints nothing when there is no release", () => {
    assert.equal(pickTag("fff\trefs/tags/not-a-version\n", "stable"), "");
  });
});
