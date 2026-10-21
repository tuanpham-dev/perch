import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { writeStreamAtomically } from "./atomicWrite.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "perch-atomic-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeStreamAtomically", () => {
  it("replaces the file once everything arrived, keeping its mode", async () => {
    const target = path.join(dir, "a.txt");
    await writeFile(target, "old");
    await chmod(target, 0o640);
    await writeStreamAtomically(target, Readable.from([Buffer.from("new "), Buffer.from("content")]), 11);
    expect(await readFile(target, "utf8")).toBe("new content");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("leaves the original untouched when the upload is cut off", async () => {
    const target = path.join(dir, "b.txt");
    await writeFile(target, "original");
    const source = new PassThrough();
    const done = writeStreamAtomically(target, source, 100);
    source.write("partial");
    source.end();
    await expect(done).rejects.toThrow(/cut off/);
    expect(await readFile(target, "utf8")).toBe("original");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the original untouched when the source errors", async () => {
    const target = path.join(dir, "c.txt");
    await writeFile(target, "keep me");
    const source = new PassThrough();
    const done = writeStreamAtomically(target, source);
    source.write("half");
    source.destroy(new Error("network gone"));
    await expect(done).rejects.toThrow(/network gone|cut off/);
    expect(await readFile(target, "utf8")).toBe("keep me");
  });

  it("writes through a symlink, keeping the link", async () => {
    const real = path.join(dir, "real.txt");
    const link = path.join(dir, "link.txt");
    await writeFile(real, "v1");
    await symlink(real, link);
    await writeStreamAtomically(link, Readable.from([Buffer.from("v2")]));
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe("v2");
  });

  it("creates a new file", async () => {
    const target = path.join(dir, "new.txt");
    await writeStreamAtomically(target, Readable.from([Buffer.from("hi")]), 2);
    expect(await readFile(target, "utf8")).toBe("hi");
  });
});
