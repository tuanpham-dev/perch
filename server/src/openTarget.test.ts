// resolveOpenTarget: what `perch open` and the desktop app's resolve route
// both turn a raw path into.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseOpenTargetParams, resolveOpenTarget } from "./openTarget.js";
import { shortenHome } from "./files.js";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "perch-open-target-")));
await mkdir(path.join(root, "src"));
await writeFile(path.join(root, "src", "index.ts"), "export {};\n");

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseOpenTargetParams", () => {
  it("requires a path", () => {
    expect(parseOpenTargetParams({})).toEqual({ error: "path is required" });
  });

  it("rejects a bad line or action", () => {
    expect(parseOpenTargetParams({ path: "/x", line: "0" })).toEqual({ error: "line must be a positive integer" });
    expect(parseOpenTargetParams({ path: "/x", action: "edit" })).toEqual({ error: "action must be editor or preview" });
  });

  it("treats empty query values as absent", () => {
    expect(parseOpenTargetParams({ path: "/x", line: "", action: "" })).toEqual({ path: "/x", line: undefined, action: undefined });
  });
});

describe("resolveOpenTarget", () => {
  it("opens a file at a line, rooted at its folder outside a repo", async () => {
    const file = path.join(root, "src", "index.ts");
    expect(await resolveOpenTarget({ path: file, line: 3, action: "editor" })).toEqual({
      kind: "file",
      path: shortenHome(file),
      projectCwd: shortenHome(path.join(root, "src")),
      line: 3,
      action: "editor",
    });
  });

  it("reads a trailing :N as the line when the literal path doesn't exist", async () => {
    const file = path.join(root, "src", "index.ts");
    expect(await resolveOpenTarget({ path: `${file}:7` })).toMatchObject({ kind: "file", path: shortenHome(file), line: 7 });
  });

  it("opens a folder as its own project, with no line", async () => {
    expect(await resolveOpenTarget({ path: root, line: 4 })).toEqual({
      kind: "dir",
      path: shortenHome(root),
      projectCwd: shortenHome(root),
    });
  });

  it("returns null for a missing path", async () => {
    expect(await resolveOpenTarget({ path: path.join(root, "nope") })).toBeNull();
  });

  it("expands ~", async () => {
    const result = await resolveOpenTarget({ path: "~" });
    expect(result).toMatchObject({ kind: "dir", path: shortenHome(homedir()) });
  });

  it.skipIf(process.platform === "win32")("keeps a path through a symlink as written, repo root included", async () => {
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, "lib"), { recursive: true });
    await writeFile(path.join(repo, "lib", "a.ts"), "");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const link = path.join(root, "link");
    await symlink(repo, link);
    expect(await resolveOpenTarget({ path: path.join(link, "lib", "..", "lib", "a.ts") })).toEqual({
      kind: "file",
      path: shortenHome(path.join(link, "lib", "a.ts")),
      projectCwd: shortenHome(link),
    });
    expect(await resolveOpenTarget({ path: link })).toMatchObject({ kind: "dir", path: shortenHome(link) });
  });
});
