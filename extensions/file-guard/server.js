// file-guard server hook: stats a path and content-sniffs its first bytes so
// the client-side open interceptor can decide "guard tab or nvim" before the
// editor ever touches the file. Read-only — the only route is a stat.

import { open, stat } from "node:fs/promises";
import path from "node:path";

// A NUL byte anywhere in the first chunk is git's own "binary" heuristic —
// same check as git-scm's conflict viewer (see its looksBinary).
const SNIFF_LEN = 8192;

function looksBinary(buf, len) {
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function activate({ router }) {
  router.get("/stat", async (req, res) => {
    const target = typeof req.query.path === "string" ? req.query.path : "";
    if (!path.isAbsolute(target)) {
      res.status(400).json({ error: "an absolute path is required" });
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) {
        res.status(400).json({ error: "path is not a file" });
        return;
      }
      // An empty file has nothing to sniff and nothing worth guarding.
      if (info.size === 0) {
        res.json({ size: 0, binary: false });
        return;
      }
      const fh = await open(target, "r");
      try {
        const buf = Buffer.alloc(Math.min(SNIFF_LEN, info.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        res.json({ size: info.size, binary: looksBinary(buf, bytesRead) });
      } finally {
        await fh.close();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
