import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDir } from "./files.js";

describe("listing a directory", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "perch-files-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists a symlink to a folder as a folder, and to a file as a file", async () => {
    await mkdir(path.join(dir, "real"));
    await writeFile(path.join(dir, "note.txt"), "hi");
    await symlink(path.join(dir, "real"), path.join(dir, ".backups"));
    await symlink(path.join(dir, "note.txt"), path.join(dir, "note-link"));
    await symlink(path.join(dir, "gone"), path.join(dir, "dangling"));

    expect(await listDir(dir)).toEqual([
      { name: ".backups", dir: true },
      { name: "real", dir: true },
      { name: "dangling", dir: false },
      { name: "note-link", dir: false },
      { name: "note.txt", dir: false },
    ]);
  });
});
