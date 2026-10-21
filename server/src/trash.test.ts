// The freedesktop.org trash written directly (for a Linux machine without
// GLib's gio): the item moves into Trash/files, and a .trashinfo records
// where it came from in the form file managers read to offer Restore.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "perch-trash-"));
const data = path.join(root, "data");
process.env.XDG_DATA_HOME = data;
const { _test } = await import("./trash.js");

beforeAll(async () => {
  await mkdir(path.join(root, "proj"), { recursive: true });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("freedesktop trash", () => {
  it("moves a file and writes its .trashinfo", async () => {
    const file = path.join(root, "proj", "notes 1.txt");
    await writeFile(file, "hello");
    await _test.freedesktopTrash(file);
    await expect(stat(file)).rejects.toThrow();
    expect(await readFile(path.join(data, "Trash", "files", "notes 1.txt"), "utf8")).toBe("hello");
    const info = await readFile(path.join(data, "Trash", "info", "notes 1.txt.trashinfo"), "utf8");
    expect(info).toContain("[Trash Info]");
    expect(info).toContain(`Path=${path.join(root, "proj").split("/").map(encodeURIComponent).join("/")}/notes%201.txt`);
    expect(info).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  });

  it("numbers a name already in the trash, and takes folders", async () => {
    const file = path.join(root, "proj", "notes 1.txt");
    await writeFile(file, "again");
    await _test.freedesktopTrash(file);
    const dir = path.join(root, "proj", "folder");
    await mkdir(dir);
    await writeFile(path.join(dir, "a"), "x");
    await _test.freedesktopTrash(dir);
    const files = (await readdir(path.join(data, "Trash", "files"))).sort();
    expect(files).toEqual(["folder", "notes 1 2.txt", "notes 1.txt"]);
  });
});
