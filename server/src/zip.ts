// Just enough zip for the app's two uses — streaming a folder download and
// unpacking a .perch extension — without depending on `zip`/`unzip` being
// installed (Windows has neither). Deflate and stored entries, no zip64: an
// entry or archive past 4 GiB is refused rather than written wrong.
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { crc32, createDeflateRaw, inflateRawSync } from "node:zlib";

const LIMIT = 0xffffffff;

interface CentralEntry {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  isDir: boolean;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class Counter {
  bytes = 0;
  constructor(private readonly out: Writable) {}
  async write(chunk: Buffer): Promise<void> {
    this.bytes += chunk.length;
    if (this.bytes > LIMIT) throw new Error("archive is larger than 4 GiB");
    if (!this.out.write(chunk)) await new Promise<void>((resolve) => this.out.once("drain", resolve));
  }
}

/**
 * Writes a zip of `dir` to `out`, with every entry under `rootName/`. Symbolic
 * links are skipped (following one could leave the folder). Sizes are written
 * after each entry's data, so nothing is read twice or held in memory.
 */
export async function writeZip(dir: string, rootName: string, out: Writable, signal?: AbortSignal): Promise<void> {
  const counter = new Counter(out);
  const central: CentralEntry[] = [];
  // bit 3: sizes and CRC follow the data; bit 11: names are UTF-8.
  const FLAGS = 0x0808;

  const addEntry = async (fullPath: string, name: string, isDir: boolean, mtime: Date) => {
    if (signal?.aborted) throw new Error("aborted");
    const nameBuf = Buffer.from(isDir ? `${name}/` : name, "utf8");
    const { time, date } = dosDateTime(mtime);
    const offset = counter.bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(isDir ? 0 : 8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt16LE(nameBuf.length, 26);
    await counter.write(header);
    await counter.write(nameBuf);

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    if (!isDir) {
      const deflate = createDeflateRaw();
      const compressed = (async () => {
        for await (const chunk of deflate) {
          compressedSize += (chunk as Buffer).length;
          await counter.write(chunk as Buffer);
        }
      })();
      for await (const chunk of createReadStream(fullPath)) {
        if (signal?.aborted) {
          deflate.destroy();
          throw new Error("aborted");
        }
        const buf = chunk as Buffer;
        crc = crc32(buf, crc);
        size += buf.length;
        if (size > LIMIT) throw new Error(`${name} is larger than 4 GiB`);
        if (!deflate.write(buf)) await new Promise<void>((resolve) => deflate.once("drain", resolve));
      }
      deflate.end();
      await compressed;
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    await counter.write(descriptor);
    central.push({ name: nameBuf, crc: crc >>> 0, compressedSize, size, offset, time, date, isDir });
  };

  const walk = async (fullPath: string, name: string): Promise<void> => {
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      const children = (await readdir(fullPath)).sort();
      if (children.length === 0) await addEntry(fullPath, name, true, info.mtime);
      for (const child of children) await walk(path.join(fullPath, child), `${name}/${child}`);
    } else if (info.isFile()) {
      await addEntry(fullPath, name, false, info.mtime);
    }
  };
  await walk(dir, rootName);

  const centralStart = counter.bytes;
  for (const e of central) {
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(20, 4);
    rec.writeUInt16LE(20, 6);
    rec.writeUInt16LE(FLAGS, 8);
    rec.writeUInt16LE(e.isDir ? 0 : 8, 10);
    rec.writeUInt16LE(e.time, 12);
    rec.writeUInt16LE(e.date, 14);
    rec.writeUInt32LE(e.crc, 16);
    rec.writeUInt32LE(e.compressedSize, 20);
    rec.writeUInt32LE(e.size, 24);
    rec.writeUInt16LE(e.name.length, 28);
    // External attributes: MS-DOS directory bit, so extractors create folders.
    rec.writeUInt32LE(e.isDir ? 0x10 : 0, 38);
    rec.writeUInt32LE(e.offset, 42);
    await counter.write(rec);
    await counter.write(e.name);
  }
  if (central.length > 0xffff) throw new Error("folder has more than 65,535 entries");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(counter.bytes - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  await counter.write(end);
}

/**
 * Unpacks the zip at `zipPath` into `destDir`. Entries whose names would land
 * outside `destDir` (absolute paths, "..") are refused, and the whole
 * extraction fails rather than writing anything unexpected.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const data = await readFile(zipPath);
  const eocd = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(eocd + 10);
  let at = data.readUInt32LE(eocd + 16);
  const root = path.resolve(destDir);

  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error("not a zip file: bad central directory");
    const method = data.readUInt16LE(at + 10);
    const compressedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const localOffset = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    at += 46 + nameLength + extraLength + commentLength;

    const target = path.resolve(root, name);
    if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || (target !== root && !target.startsWith(root + path.sep))) {
      throw new Error(`zip entry "${name}" points outside the folder it unpacks into`);
    }
    if (name.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`not a zip file: bad entry for "${name}"`);
    const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
    const raw = data.subarray(start, start + compressedSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw);
    else throw new Error(`zip entry "${name}" uses an unsupported compression method (${method})`);
    if (content.length !== size) throw new Error(`zip entry "${name}" is damaged`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function findEndOfCentralDirectory(data: Buffer): number {
  // The record is 22 bytes plus an optional comment of up to 65,535 bytes.
  const earliest = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= earliest; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("not a zip file");
}
