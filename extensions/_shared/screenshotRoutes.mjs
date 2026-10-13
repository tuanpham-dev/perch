// Server routes for preview screenshots (the page agent's captures): the tab
// uploads a PNG, the server keeps it as a file an agent in a terminal can
// open by path, and the tab shows it back from the same route. Files live in
// the server's temp folder, so the path is on the machine the agents run on
// (the remote server, when the app is connected to one), and are cleared
// after a week. Plain ESM; mounted by each preview extension's server entry.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = path.join(tmpdir(), "perch-previews");
const MAX_BYTES = 12 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const NAME_RE = /^[\w-]{8,80}\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function sweep() {
  try {
    const now = Date.now();
    for (const name of await readdir(DIR)) {
      if (!NAME_RE.test(name)) continue;
      const file = path.join(DIR, name);
      if (now - (await stat(file)).mtimeMs > KEEP_MS) await unlink(file).catch(() => {});
    }
  } catch {
    // nothing to sweep yet
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("screenshot too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// The upload answers with the file's path (for the agent) and its name; the
// tab shows it from GET /screenshot/<name> on its own server hook.
export function mountScreenshotRoutes(router) {
  // Raw PNG body (content-type image/png), not JSON: the app's JSON parser
  // caps bodies far below a screenshot's size.
  router.post("/screenshot", async (req, res) => {
    let body;
    try {
      body = await readBody(req, MAX_BYTES);
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
      return;
    }
    if (body.length < 8 || !body.subarray(0, 4).equals(PNG_SIGNATURE)) {
      res.status(400).json({ error: "expected a PNG image" });
      return;
    }
    await mkdir(DIR, { recursive: true });
    const name = `${new Date().toISOString().slice(0, 10)}-${randomBytes(9).toString("base64url")}.png`;
    const file = path.join(DIR, name);
    await writeFile(file, body, { mode: 0o600 });
    void sweep();
    res.json({ path: file, name });
  });

  router.get("/screenshot/:name", (req, res) => {
    const name = req.params.name;
    if (!NAME_RE.test(name)) {
      res.status(400).json({ error: "bad name" });
      return;
    }
    res.sendFile(path.join(DIR, name), { headers: { "cache-control": "private, max-age=86400" } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "screenshot not found" });
    });
  });
}
