// Unsaved edits, kept on the server so a page reload, a crashed browser or an
// extension update doesn't take them with it — and so they follow the user
// to whichever device opens the file next (VS Code's "hot exit", for a tool
// used from several machines). Extensions reach it through ctx.drafts: the
// text editor, csv-preview's grid and the prompts editor back up whatever
// they hold dirty here, and restore it the next time that tab loads.
//
// One JSON file per draft under <configDir>/drafts/<extensionId>/, named by a
// hash of the extension's own key (usually a file path), so a key can be any
// string without ever becoming a path. Values are opaque JSON: the extension
// decides what a draft is (text plus a hash of the on-disk baseline, a grid's
// parse options, ...).
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { Router, type Request, type Response } from "express";
import { configDir } from "./configDir.js";

// Big enough for the largest file any editor will hold (the text editor
// refuses past 2MB) after JSON escaping, with room for a wide CSV grid.
const MAX_DRAFT_BODY = "16mb";
const MAX_KEY_LENGTH = 4096;
// The same shape extension ids take; anything else can't be a directory name
// we're willing to create.
const EXT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface StoredDraft {
  key: string;
  value: unknown;
  savedAt: number;
}

export function createDraftStore(rootDir: string) {
  const dirFor = (extId: string) => path.join(rootDir, extId);
  const fileFor = (extId: string, key: string) =>
    path.join(dirFor(extId), `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.json`);

  async function get(extId: string, key: string): Promise<StoredDraft | null> {
    try {
      const parsed = JSON.parse(await readFile(fileFor(extId, key), "utf8")) as StoredDraft;
      // A hash collision, however unlikely, must not hand one file's edits to another.
      return parsed.key === key ? parsed : null;
    } catch {
      return null;
    }
  }

  async function set(extId: string, key: string, value: unknown): Promise<void> {
    const file = fileFor(extId, key);
    // 0700/0600: a draft is file content the user hasn't chosen to write yet,
    // possibly from a file only they can read.
    await mkdir(dirFor(extId), { recursive: true, mode: 0o700 });
    const doc: StoredDraft = { key, value, savedAt: Date.now() };
    // Temp-then-rename so a crash mid-write can't leave a truncated draft. The
    // temp name is unique per write: two tabs backing up one key at once must
    // not rename each other's half-written file.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
    await rename(tmp, file);
  }

  async function remove(extId: string, key: string): Promise<void> {
    await unlink(fileFor(extId, key)).catch(() => {});
  }

  async function clearExtension(extId: string): Promise<void> {
    if (!EXT_ID_RE.test(extId)) return;
    await rm(dirFor(extId), { recursive: true, force: true });
  }

  // Every draft, newest first, without its value: what the app's Unsaved
  // Changes list shows.
  async function list(): Promise<{ extId: string; key: string; savedAt: number }[]> {
    const out: { extId: string; key: string; savedAt: number }[] = [];
    let extIds: string[];
    try {
      extIds = await readdir(rootDir);
    } catch {
      return out;
    }
    for (const extId of extIds.filter((id) => EXT_ID_RE.test(id))) {
      let files: string[];
      try {
        files = await readdir(dirFor(extId));
      } catch {
        continue;
      }
      for (const name of files.filter((f) => f.endsWith(".json"))) {
        try {
          const parsed = JSON.parse(await readFile(path.join(dirFor(extId), name), "utf8")) as StoredDraft;
          if (typeof parsed.key === "string") out.push({ extId, key: parsed.key, savedAt: Number(parsed.savedAt) || 0 });
        } catch {
          // a half-written or foreign file: not a draft
        }
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  // Removes drafts nobody has touched for `maxAgeMs`: a file edited once and
  // never reopened would otherwise keep its draft forever.
  async function prune(maxAgeMs: number, now = Date.now()): Promise<number> {
    let removed = 0;
    for (const draft of await list()) {
      if (now - draft.savedAt > maxAgeMs) {
        await remove(draft.extId, draft.key);
        removed++;
      }
    }
    return removed;
  }

  return { get, set, remove, clearExtension, list, prune };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

// A failed read or write (disk full, permissions) answers that one request
// instead of leaving it hanging on an unhandled rejection.
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((err: unknown) => {
    if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
};

export function createDraftsRouter(store: DraftStore): Router {
  const router = Router();
  // Its own parser, mounted ahead of the app-wide express.json() (whose 100kb
  // default would refuse most drafts): whichever parser runs first consumes
  // the stream.
  router.use(express.json({ limit: MAX_DRAFT_BODY }));

  const parse = (extId: string, key: unknown): { extId: string; key: string } | null => {
    if (!EXT_ID_RE.test(extId)) return null;
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
    return { extId, key };
  };

  // Every draft (extension, key, when), for the Unsaved Changes list.
  router.get("/", handle(async (_req, res) => {
    res.set("Cache-Control", "no-store").json({ drafts: await store.list() });
  }));

  router.get("/:extId", handle(async (req, res) => {
    const target = parse(req.params.extId, req.query.key);
    if (!target) return res.status(400).json({ error: "invalid extension id or key" });
    const draft = await store.get(target.extId, target.key);
    // Never cached: a draft written from another device must show up here.
    res.set("Cache-Control", "no-store").json(draft ? { value: draft.value, savedAt: draft.savedAt } : null);
  }));

  router.put("/:extId", handle(async (req, res) => {
    const target = parse(req.params.extId, req.body?.key);
    if (!target) return res.status(400).json({ error: "invalid extension id or key" });
    if (!("value" in (req.body ?? {}))) return res.status(400).json({ error: "value is required" });
    await store.set(target.extId, target.key, req.body.value);
    res.status(204).end();
  }));

  router.delete("/:extId", handle(async (req, res) => {
    const target = parse(req.params.extId, req.query.key);
    if (!target) return res.status(400).json({ error: "invalid extension id or key" });
    await store.remove(target.extId, target.key);
    res.status(204).end();
  }));

  return router;
}

export const draftStore = createDraftStore(path.join(configDir, "drafts"));
export const draftsRouter = createDraftsRouter(draftStore);

// Drafts untouched for 30 days are dropped: at start-up and once a day.
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export function startDraftPruning(store: DraftStore = draftStore): void {
  const run = () => void store.prune(DRAFT_MAX_AGE_MS).catch((err) => console.error("draft pruning failed:", err));
  run();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
