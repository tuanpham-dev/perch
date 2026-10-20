// HTTP for extension storage (extensionStorage.ts): what ctx.storage calls
// from an extension's browser code, the change stream every open browser
// listens on, and the stored-data list Settings shows.
//
//   GET    /api/storage                         [{ id, bytes, installed }]
//   DELETE /api/storage/:ext                    delete everything it stored
//   GET    /api/storage/events                  SSE: one stream for all extensions
//   GET    /api/storage/:ext/:collection?key=   { value, rev } | null
//   GET    /api/storage/:ext/:collection?prefix=&after=&limit=&keysOnly=1   [{ key, value?, rev }]
//   PUT    /api/storage/:ext/:collection        { key, value, ifRev? } → { rev }
//   DELETE /api/storage/:ext/:collection?key=&ifRev=
//
// Browser writes run the extension's validator for that collection (a 422
// with its message); a revision mismatch is a 409 carrying what is stored.
import express, { Router, type Request, type Response } from "express";
import { StorageConflict, StorageError, type ExtensionStorageService, type StorageEvent } from "./extensionStorage.js";

// A record may be 16 MB once JSON-encoded; the request wraps it in a little more.
const MAX_BODY = "17mb";
const MAX_LIST = 1000;
// Changes carrying a bigger value go out without it; the browser fetches it.
export const MAX_EVENT_VALUE_BYTES = 256 * 1024;
const HEARTBEAT_MS = 25_000;

function fail(res: Response, err: unknown) {
  if (res.headersSent) return;
  if (err instanceof StorageConflict) return res.status(409).json({ error: err.message, current: err.current });
  if (err instanceof StorageError) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((err: unknown) => fail(res, err));
};

// Big values are left out of the frame, so one large write doesn't fan out
// megabytes to every open browser; the client fetches the record instead.
export function eventFrame(e: StorageEvent): string {
  if (e.type !== "change") return `data: ${JSON.stringify(e)}\n\n`;
  const changes = e.changes.map((c) => {
    if (c.deleted || c.value === undefined) return c;
    const text = JSON.stringify(c.value);
    return Buffer.byteLength(text) > MAX_EVENT_VALUE_BYTES ? { key: c.key, rev: c.rev, large: true } : c;
  });
  return `data: ${JSON.stringify({ ...e, changes })}\n\n`;
}

export function createExtensionStorageRouter(
  service: ExtensionStorageService,
  opts: { installedIds: () => Promise<string[]> },
): Router {
  const router = Router();
  // Its own parser, ahead of the app-wide express.json() (100kb), as drafts do.
  router.use(express.json({ limit: MAX_BODY }));

  router.get("/", handle(async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await service.sizes(await opts.installedIds()));
  }));

  router.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const off = service.onChange((e) => res.write(eventFrame(e)));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      off();
    });
  });

  router.delete("/:ext", handle(async (req, res) => {
    await service.deleteData(req.params.ext);
    res.status(204).end();
  }));

  const collectionOf = (req: Request) => service.forExtension(req.params.ext).collection(req.params.collection);

  router.get("/:ext/:collection", handle(async (req, res) => {
    const c = collectionOf(req);
    res.set("Cache-Control", "no-store");
    if (typeof req.query.key === "string") return res.json(await c.get(req.query.key));
    const limit = Math.min(MAX_LIST, Math.max(0, Number(req.query.limit ?? MAX_LIST) || MAX_LIST));
    res.json(
      await c.list({
        prefix: typeof req.query.prefix === "string" ? req.query.prefix : undefined,
        after: typeof req.query.after === "string" ? req.query.after : undefined,
        limit,
        keysOnly: req.query.keysOnly === "1" || req.query.keysOnly === "true",
      }),
    );
  }));

  router.put("/:ext/:collection", handle(async (req, res) => {
    const c = collectionOf(req);
    const body = req.body ?? {};
    if (typeof body.key !== "string") return res.status(400).json({ error: "a key is required" });
    if (!("value" in body)) return res.status(400).json({ error: "a value is required" });
    const refused = service.validateClientWrite(req.params.ext, req.params.collection, body.key, body.value);
    if (refused) return res.status(422).json({ error: refused });
    const ifRev = typeof body.ifRev === "number" ? body.ifRev : undefined;
    res.json(await c.put(body.key, body.value, { ifRev }));
  }));

  router.delete("/:ext/:collection", handle(async (req, res) => {
    const c = collectionOf(req);
    if (typeof req.query.key !== "string") return res.status(400).json({ error: "a key is required" });
    const ifRev = req.query.ifRev !== undefined ? Number(req.query.ifRev) : undefined;
    await c.delete(req.query.key, { ifRev: Number.isFinite(ifRev) ? ifRev : undefined });
    res.status(204).end();
  }));

  // A body over the limit arrives here as express.json()'s own error.
  router.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    const type = (err as { type?: string })?.type;
    if (type === "entity.too.large") return res.status(413).json({ error: "the record is over the 16 MB limit" });
    if (type === "entity.parse.failed") return res.status(400).json({ error: "the body isn't JSON" });
    next(err);
  });

  return router;
}
