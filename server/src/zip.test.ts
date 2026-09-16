import { execFileSync, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractZip, writeZip } from "./zip.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "zip-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeTree(root: string): void {
  mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  mkdirSync(path.join(root, "empty"));
  writeFileSync(path.join(root, "README.md"), "# hello\n");
  writeFileSync(path.join(root, "src", "nested", "données.txt"), "é".repeat(1000));
  writeFileSync(path.join(root, "src", "big.bin"), Buffer.alloc(300_000, 7));
}

async function zipTo(folder: string, file: string): Promise<void> {
  const out = createWriteStream(file);
  await writeZip(folder, path.basename(folder), out);
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

const hasTool = (name: string) => spawnSync("which", [name]).status === 0;

describe("zip", () => {
  it("round-trips a folder through its own writer and reader", async () => {
    const src = path.join(dir, "proj");
    makeTree(src);
    const file = path.join(dir, "proj.zip");
    await zipTo(src, file);
    const out = path.join(dir, "out");
    await extractZip(file, out);
    expect(readFileSync(path.join(out, "proj", "README.md"), "utf8")).toBe("# hello\n");
    expect(readFileSync(path.join(out, "proj", "src", "nested", "données.txt"), "utf8")).toBe("é".repeat(1000));
    expect(statSync(path.join(out, "proj", "src", "big.bin")).size).toBe(300_000);
    expect(readdirSync(path.join(out, "proj", "empty"))).toEqual([]);
  });

  it.runIf(hasTool("unzip"))("writes an archive the system unzip accepts", async () => {
    const src = path.join(dir, "proj");
    makeTree(src);
    const file = path.join(dir, "proj.zip");
    await zipTo(src, file);
    const report = execFileSync("unzip", ["-t", file]).toString();
    expect(report).toMatch(/No errors detected/);
  });

  it.runIf(hasTool("zip"))("reads an archive made by the system zip", async () => {
    const src = path.join(dir, "ext");
    makeTree(src);
    const file = path.join(dir, "ext.zip");
    execFileSync("zip", ["-qr", file, "ext"], { cwd: dir });
    const out = path.join(dir, "out");
    await extractZip(file, out);
    expect(readFileSync(path.join(out, "ext", "README.md"), "utf8")).toBe("# hello\n");
    expect(statSync(path.join(out, "ext", "src", "big.bin")).size).toBe(300_000);
  });

  it("refuses an entry that would land outside the destination", async () => {
    // A stored entry named "../escape.txt", written by hand.
    const name = Buffer.from("../escape.txt");
    const body = Buffer.from("x");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(1, 18);
    local.writeUInt32LE(1, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(1, 20);
    central.writeUInt32LE(1, 24);
    central.writeUInt16LE(name.length, 28);
    const localPart = Buffer.concat([local, name, body]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(localPart.length, 16);
    const file = path.join(dir, "evil.zip");
    writeFileSync(file, Buffer.concat([localPart, central, name, end]));
    await expect(extractZip(file, path.join(dir, "out"))).rejects.toThrow(/outside/);
    expect(() => statSync(path.join(dir, "escape.txt"))).toThrow();
  });

  it("says so when a file isn't a zip", async () => {
    const file = path.join(dir, "not.zip");
    writeFileSync(file, "hello");
    await expect(extractZip(file, path.join(dir, "out"))).rejects.toThrow(/not a zip/);
  });
});
