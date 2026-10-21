// Task windows are named by the package's path in its workspace, and pnpm's
// workspace list comes from pnpm-workspace.yaml.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pnpmWorkspacePatterns, taskWindowName } from "./server.js";

test("packages with the same folder name get different windows", () => {
  const root = "/repo";
  assert.equal(taskWindowName("dev", "/repo/apps/web", root), "dev [apps/web]");
  assert.equal(taskWindowName("dev", "/repo/packages/web", root), "dev [packages/web]");
  assert.equal(taskWindowName("dev", "/repo", root), "dev [repo]");
});

test("pnpm-workspace.yaml's packages list is read", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perch-pnpm-"));
  writeFileSync(
    path.join(dir, "pnpm-workspace.yaml"),
    "# the workspace\npackages:\n  - 'apps/*'\n  - \"packages/**\"  # libraries\n  - '!**/test/**'\ncatalog:\n  react: ^18\n",
  );
  assert.deepEqual(pnpmWorkspacePatterns(dir), ["apps/*", "packages/**", "!**/test/**"]);
  assert.equal(pnpmWorkspacePatterns(path.join(dir, "missing")), null);
});
