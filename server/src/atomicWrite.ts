// Writing a file without ever leaving it half-written. The new content goes
// to a temp file beside the target, which replaces the target by rename only
// once every byte has arrived: an upload that fails or is cut off partway
// (a phone on a tunnel dropping out mid-save) leaves the original exactly as
// it was. The target keeps its permissions, and a symlinked target (a dotfile
// managed by stow) keeps being a link: the file it points to is replaced.
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

// Resolves once `target` holds everything `source` sent. Rejects, with the
// original untouched and the temp file removed, when the source errors or
// ends early (`expectedBytes`, from a Content-Length, tells a cut-off upload
// from a complete one; an "aborted" source is always incomplete).
export async function writeStreamAtomically(target: string, source: Readable, expectedBytes?: number): Promise<void> {
  // Watched from the first moment: the source can fail while the target's
  // real path is still being looked up.
  let ended = false;
  let failure: Error | null = null;
  let onFailure: ((err: Error) => void) | null = null;
  const fail = (err: Error) => {
    if (failure) return;
    failure = err;
    onFailure?.(err);
  };
  source.on("end", () => {
    ended = true;
  });
  source.on("aborted", () => fail(new Error("the upload was cut off")));
  source.on("error", fail);
  source.on("close", () => {
    if (!ended) fail(new Error("the upload was cut off"));
  });
  source.pause();

  const finalPath = await realpath(target).catch(() => target);
  const tmp = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.perch-${randomBytes(4).toString("hex")}.tmp`);
  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const out = createWriteStream(tmp);
      onFailure = (err) => {
        source.unpipe(out);
        out.destroy();
        reject(err);
      };
      source.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      out.on("error", fail);
      out.on("finish", () => {
        if (failure) return;
        if (!ended) {
          reject(new Error("the upload was cut off"));
          return;
        }
        if (expectedBytes !== undefined && received !== expectedBytes) {
          reject(new Error(`the upload was cut off (${received} of ${expectedBytes} bytes)`));
          return;
        }
        resolve();
      });
      source.pipe(out);
    });
    const existing = await stat(finalPath).catch(() => null);
    if (existing) await chmod(tmp, existing.mode & 0o7777);
    await rename(tmp, finalPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
