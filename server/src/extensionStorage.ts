// Every extension's own storage (plans/extension-storage.md): one SQLite
// database per extension, holding named collections of JSON records that the
// extension's server code (activate({ storage })) and its browser code
// (ctx.storage, through extensionStorageRoutes.ts) both read and write. Each
// write is published on a change bus that the routes stream to every open
// browser, so a panel hears about a change instead of polling for it.
//
// Layout, per extension id:
//   <dataRoot>/<id>/data.sqlite   records (and the extension's own SQL tables)
//   <dataRoot>/<id>/files/        binary or large files it manages itself
//   <stateRoot>/<short id>/       a short runtime folder, for sockets
//
// Two connections share the database file. The records connection owns the
// reserved _perch_* tables; the one handed to extension SQL (storage.sql)
// runs under an authorizer that refuses any access to them, so raw SQL can
// add tables and indexes but can't bypass revisions or change events.
//
// node:sqlite is synchronous. The collection methods still return promises,
// so the API can move off-thread later, but transaction() and update() take
// synchronous callbacks: an await inside them would let another write on the
// same connection land in the middle of the transaction.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, constants as sqliteConstants } from "node:sqlite";

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_KEY_LENGTH = 1024;
// Same shape as extension ids everywhere else (drafts.ts): anything else
// can't become a directory name.
export const EXT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Runtime folder names longer than this are shortened, so a socket path
// stays well under the ~107-byte limit on unix sockets: a 60-character state
// folder + "/x/" + 17 is 80. Long enough for "publisher.name" ids such as
// "perch.agent-tasks" to stay readable.
const MAX_SHORT_ID = 17;

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

// A write named a revision the record has moved on from. `current` is what
// is stored now (null when the record doesn't exist).
export class StorageConflict extends StorageError {
  constructor(readonly current: StoredRecord | null) {
    super("the record has changed since it was read", 409);
    this.name = "StorageConflict";
  }
}

export interface StoredRecord {
  value: unknown;
  rev: number;
}

export interface ListedRecord extends StoredRecord {
  key: string;
}

// With keysOnly, `value` is left out.
export type ListedKey = { key: string; rev: number };

export interface ListOptions {
  prefix?: string;
  // Keys strictly after this one (for paging).
  after?: string;
  limit?: number;
  // Only keys and revisions, without reading the values: cheap enough to
  // count or prune a collection of big records.
  keysOnly?: boolean;
}

export interface WriteOptions {
  // The revision the caller last saw; 0 means "must not exist yet".
  ifRev?: number;
}

export interface Change {
  key: string;
  rev: number;
  value?: unknown;
  deleted?: true;
}

export type StorageEvent =
  | { ext: string; type: "change"; collection: string; changes: Change[] }
  | { ext: string; type: "topic"; topic: string; payload?: unknown }
  | { ext: string; type: "resync" };

// A validator refuses a browser write by returning (or throwing) a message.
export type Validator = (key: string, value: unknown) => string | void | undefined | null;

export interface SyncCollection {
  get(key: string): StoredRecord | null;
  put(key: string, value: unknown, opts?: WriteOptions): { rev: number };
  delete(key: string, opts?: WriteOptions): void;
  list(opts?: ListOptions): ListedRecord[];
}

export interface Collection {
  get(key: string): Promise<StoredRecord | null>;
  put(key: string, value: unknown, opts?: WriteOptions): Promise<{ rev: number }>;
  delete(key: string, opts?: WriteOptions): Promise<void>;
  list(opts?: ListOptions): Promise<ListedRecord[]>;
  // fn gets the current value (undefined when there is none) and returns the
  // new one, or undefined to delete the record. Synchronous: see the header.
  update(key: string, fn: (current: unknown) => unknown): Promise<StoredRecord | null>;
  // Checks writes that arrive from browser code; server writes skip it.
  validate(fn: Validator): void;
}

export interface ExtensionSql {
  exec(sql: string): void;
  prepare(sql: string): ReturnType<DatabaseSync["prepare"]>;
}

export interface ExtensionStorage {
  collection(name: string): Collection;
  transaction<T>(fn: (tx: { collection(name: string): SyncCollection }) => T): Promise<T>;
  sql: ExtensionSql;
  notify(topic: string, payload?: unknown): void;
  filesDir(): string;
  runtimeDir(): string;
  runtimeDirOf(extensionId: string): string;
}

export interface StoredDataInfo {
  id: string;
  bytes: number;
  installed: boolean;
}

interface Open {
  db: DatabaseSync;
  sql: DatabaseSync | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS _perch_records (
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    rev INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, key)
  ) WITHOUT ROWID;
`;

// The highest code point: every key that starts with a prefix sorts below
// prefix + this, so a prefix scan is a range scan on the primary key.
const PREFIX_END = "\u{10FFFF}";

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function shortId(id: string): string {
  if (id.length <= MAX_SHORT_ID) return id;
  return `${id.slice(0, 10)}-${createHash("sha256").update(id).digest("hex").slice(0, 6)}`;
}

function checkName(kind: string, name: string): void {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new StorageError(`invalid ${kind} name "${name}"`, 400);
}

function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new StorageError("a key is required", 400);
  if (key.length > MAX_KEY_LENGTH) throw new StorageError(`the key is over the ${MAX_KEY_LENGTH}-character limit`, 413);
}

function encode(value: unknown): string {
  if (value === undefined) throw new StorageError("a value is required", 400);
  const text = JSON.stringify(value);
  if (text === undefined) throw new StorageError("the value isn't JSON", 400);
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new StorageError("the record is over the 16 MB limit", 413);
  return text;
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

export function createExtensionStorageService(opts: {
  dataRoot: string;
  stateRoot: string;
  log?: (...args: unknown[]) => void;
}) {
  const { dataRoot, stateRoot } = opts;
  const log = opts.log ?? ((...args: unknown[]) => console.warn(...args));
  const open = new Map<string, Open>();
  const validators = new Map<string, Map<string, Validator>>();
  const listeners = new Set<(e: StorageEvent) => void>();

  const checkId = (id: string) => {
    if (!EXT_ID_RE.test(id)) throw new StorageError(`invalid extension id "${id}"`, 400);
  };
  const dataDir = (id: string) => path.join(dataRoot, id);
  const dbFile = (id: string) => path.join(dataDir(id), "data.sqlite");
  const runtimeDirOf = (id: string) => {
    checkId(id);
    return path.join(stateRoot, shortId(id));
  };

  function publish(e: StorageEvent) {
    for (const cb of listeners) {
      try {
        cb(e);
      } catch (err) {
        log("extension storage: change listener failed:", err);
      }
    }
  }

  function makeDir(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask; the folder must be private.
    chmodSync(dir, 0o700);
  }

  function openDatabase(id: string): DatabaseSync {
    makeDir(dataDir(id));
    const file = dbFile(id);
    const fresh = !existsSync(file);
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      // A file that isn't a database only fails once something reads it.
      const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      if (check && check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);
      db.exec(SCHEMA);
    } catch (err) {
      try {
        db.close();
      } catch {
        // Already unusable.
      }
      throw err;
    }
    // SQLite gives the -wal and -shm files the main file's permissions.
    if (fresh) chmodSync(file, 0o600);
    return db;
  }

  function ensure(id: string): Open {
    const have = open.get(id);
    if (have) return have;
    let db: DatabaseSync;
    try {
      db = openDatabase(id);
    } catch (err) {
      // An unreadable database mustn't take the extension (or Perch) down
      // with it: keep the bad file beside a fresh one, for whoever wants it.
      const suffix = `.corrupt-${stamp()}`;
      for (const ext of ["", "-wal", "-shm"]) {
        const f = dbFile(id) + ext;
        if (existsSync(f)) renameSync(f, f + suffix);
      }
      log(`extension ${id}: storage was unreadable, moved aside as data.sqlite${suffix} (${(err as Error).message})`);
      db = openDatabase(id);
    }
    const entry: Open = { db, sql: null };
    open.set(id, entry);
    return entry;
  }

  function syncCollection(id: string, name: string, changes: Map<string, Change[]>): SyncCollection {
    checkName("collection", name);
    const { db } = ensure(id);
    const record = (key: string): StoredRecord | null => {
      const row = db.prepare("SELECT value, rev FROM _perch_records WHERE collection = ? AND key = ?").get(name, key) as
        | { value: string; rev: number }
        | undefined;
      return row ? { value: JSON.parse(row.value), rev: row.rev } : null;
    };
    const note = (c: Change) => {
      const list = changes.get(name) ?? [];
      list.push(c);
      changes.set(name, list);
    };
    const checkRev = (current: StoredRecord | null, opts?: WriteOptions) => {
      if (opts?.ifRev === undefined) return;
      if ((current?.rev ?? 0) !== opts.ifRev) throw new StorageConflict(current);
    };
    return {
      get(key) {
        checkKey(key);
        return record(key);
      },
      put(key, value, opts) {
        checkKey(key);
        const text = encode(value);
        const current = record(key);
        checkRev(current, opts);
        const rev = (current?.rev ?? 0) + 1;
        db.prepare(
          "INSERT INTO _perch_records (collection, key, value, rev, updated_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value, rev = excluded.rev, updated_at = excluded.updated_at",
        ).run(name, key, text, rev, Date.now());
        note({ key, rev, value: JSON.parse(text) });
        return { rev };
      },
      delete(key, opts) {
        checkKey(key);
        const current = record(key);
        checkRev(current, opts);
        if (!current) return;
        db.prepare("DELETE FROM _perch_records WHERE collection = ? AND key = ?").run(name, key);
        note({ key, rev: current.rev + 1, deleted: true });
      },
      list(opts = {}) {
        const where = ["collection = ?"];
        const args: (string | number)[] = [name];
        if (opts.prefix) {
          where.push("key >= ? AND key < ?");
          args.push(opts.prefix, opts.prefix + PREFIX_END);
        }
        if (opts.after !== undefined) {
          where.push("key > ?");
          args.push(opts.after);
        }
        let sql = `SELECT key, ${opts.keysOnly ? "" : "value, "}rev FROM _perch_records WHERE ${where.join(" AND ")} ORDER BY key`;
        if (opts.limit !== undefined) {
          sql += " LIMIT ?";
          args.push(Math.max(0, Math.floor(opts.limit)));
        }
        const rows = db.prepare(sql).all(...args) as { key: string; value?: string; rev: number }[];
        if (opts.keysOnly) return rows.map((r) => ({ key: r.key, rev: r.rev })) as ListedRecord[];
        return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value!), rev: r.rev }));
      },
    };
  }

  // Runs fn inside BEGIN IMMEDIATE … COMMIT and publishes what it changed
  // only once it has committed.
  function runTransaction<T>(id: string, fn: (tx: { collection(name: string): SyncCollection }) => T): T {
    const { db } = ensure(id);
    const changes = new Map<string, Change[]>();
    db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn({ collection: (name) => syncCollection(id, name, changes) });
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new StorageError("transaction callbacks must be synchronous", 500);
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Nothing to roll back.
      }
      throw err;
    }
    for (const [collection, list] of changes) publish({ ext: id, type: "change", collection, changes: list });
    return result;
  }

  function forExtension(id: string): ExtensionStorage {
    checkId(id);
    const collection = (name: string): Collection => {
      checkName("collection", name);
      const one = <T>(fn: (c: SyncCollection) => T) =>
        new Promise<T>((resolve, reject) => {
          try {
            resolve(runTransaction(id, (tx) => fn(tx.collection(name))));
          } catch (err) {
            reject(err);
          }
        });
      return {
        get: (key) => one((c) => c.get(key)),
        put: (key, value, o) => one((c) => c.put(key, value, o)),
        delete: (key, o) => one((c) => c.delete(key, o)),
        list: (o) => one((c) => c.list(o)),
        update: (key, fn) =>
          one((c) => {
            const current = c.get(key);
            const next = fn(current?.value);
            if (next && typeof (next as { then?: unknown }).then === "function") {
              throw new StorageError("update callbacks must be synchronous", 500);
            }
            if (next === undefined) {
              c.delete(key);
              return null;
            }
            return { value: next, rev: c.put(key, next).rev };
          }),
        validate(fn) {
          let map = validators.get(id);
          if (!map) validators.set(id, (map = new Map()));
          map.set(name, fn);
        },
      };
    };
    const sqlDb = () => {
      const entry = ensure(id);
      if (entry.sql) return entry.sql;
      const db = new DatabaseSync(dbFile(id));
      db.exec("PRAGMA busy_timeout = 2000;");
      const C = sqliteConstants as Record<string, number>;
      (db as unknown as { setAuthorizer(fn: (...args: unknown[]) => number): void }).setAuthorizer((code, a1, a2) => {
        if (code === C.SQLITE_ATTACH || code === C.SQLITE_DETACH) return C.SQLITE_DENY;
        for (const arg of [a1, a2]) {
          if (typeof arg === "string" && arg.toLowerCase().startsWith("_perch_")) return C.SQLITE_DENY;
        }
        return C.SQLITE_OK;
      });
      entry.sql = db;
      return db;
    };
    return {
      collection,
      transaction: (fn) =>
        new Promise((resolve, reject) => {
          try {
            resolve(runTransaction(id, fn));
          } catch (err) {
            reject(err);
          }
        }),
      sql: {
        exec: (sql) => sqlDb().exec(sql),
        prepare: (sql) => sqlDb().prepare(sql),
      },
      notify(topic, payload) {
        checkName("topic", topic);
        publish({ ext: id, type: "topic", topic, payload });
      },
      filesDir() {
        const dir = path.join(dataDir(id), "files");
        makeDir(dataDir(id));
        makeDir(dir);
        return dir;
      },
      runtimeDir() {
        const dir = runtimeDirOf(id);
        mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
        makeDir(dir);
        return dir;
      },
      runtimeDirOf,
    };
  }

  // Runs a browser write's validator, if the extension registered one.
  function validateClientWrite(id: string, collection: string, key: string, value: unknown): string | null {
    const fn = validators.get(id)?.get(collection);
    if (!fn) return null;
    try {
      const message = fn(key, value);
      return typeof message === "string" && message ? message : null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  function close(id: string) {
    const entry = open.get(id);
    if (!entry) return;
    open.delete(id);
    for (const db of [entry.sql, entry.db]) {
      try {
        db?.close();
      } catch {
        // Already closed.
      }
    }
  }

  // An extension going away (deactivated, uninstalled): its connections close
  // and its validators go with its code. Its data stays.
  function release(id: string) {
    close(id);
    validators.delete(id);
  }

  async function sizes(installedIds: string[]): Promise<StoredDataInfo[]> {
    let entries;
    try {
      entries = await readdir(dataRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const installed = new Set(installedIds);
    const out: StoredDataInfo[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !EXT_ID_RE.test(e.name)) continue;
      out.push({ id: e.name, bytes: await folderBytes(path.join(dataRoot, e.name)), installed: installed.has(e.name) });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function deleteData(id: string) {
    checkId(id);
    close(id);
    await rm(dataDir(id), { recursive: true, force: true });
    await rm(runtimeDirOf(id), { recursive: true, force: true });
    publish({ ext: id, type: "resync" });
  }

  function onChange(cb: (e: StorageEvent) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function closeAll() {
    for (const id of [...open.keys()]) close(id);
  }

  return { forExtension, validateClientWrite, close, release, sizes, deleteData, onChange, closeAll };
}

export type ExtensionStorageService = ReturnType<typeof createExtensionStorageService>;
