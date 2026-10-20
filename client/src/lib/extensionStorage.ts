// ctx.storage: an extension's own collections of JSON records, from its
// browser code (server/src/extensionStorage*.ts holds them). Reads and writes
// are plain requests to /api/storage/<ext>/<collection>; changes arrive on one
// shared event stream for the whole browser (sharedEventSource), filtered here
// down to the collection or topic each subscriber asked for.
//
// A subscriber gets { type: "change", changes } for every write anyone makes
// (this tab, another device, the extension's server code), and
// { type: "resync" } after the stream reconnects, when changes may have been
// missed and whatever it shows should be reloaded.
import { openSharedEventSource, type EventSourceLike } from "./sharedEventSource";

export interface StoredRecord<T = unknown> {
  value: T;
  rev: number;
}

export interface ListedRecord<T = unknown> extends StoredRecord<T> {
  key: string;
}

export interface StorageChange {
  key: string;
  rev: number;
  value?: unknown;
  deleted?: true;
}

export type StorageNotice = { type: "change"; changes: StorageChange[] } | { type: "resync" };
export type TopicNotice = { type: "topic"; payload?: unknown } | { type: "resync" };

export interface StorageCollection {
  get<T = unknown>(key: string): Promise<StoredRecord<T> | null>;
  // ifRev: the revision last seen (0 = must not exist yet). A mismatch
  // rejects with an Error whose `current` is what is stored now.
  put(key: string, value: unknown, opts?: { ifRev?: number }): Promise<{ rev: number }>;
  delete(key: string, opts?: { ifRev?: number }): Promise<void>;
  // keysOnly leaves the values out: cheap for counting or pruning big records.
  list<T = unknown>(opts?: { prefix?: string; after?: string; limit?: number; keysOnly?: boolean }): Promise<ListedRecord<T>[]>;
  subscribe(cb: (notice: StorageNotice) => void): () => void;
}

export interface ExtensionStorageClient {
  collection(name: string): StorageCollection;
  subscribeTopic(topic: string, cb: (notice: TopicNotice) => void): () => void;
}

export interface StorageError extends Error {
  status: number;
  current?: StoredRecord | null;
}

type WireEvent =
  | { ext: string; type: "change"; collection: string; changes: (StorageChange & { large?: true })[] }
  | { ext: string; type: "topic"; topic: string; payload?: unknown }
  | { ext: string; type: "resync" };

interface Listener {
  ext: string;
  kind: "collection" | "topic";
  name: string;
  cb: (notice: StorageNotice | TopicNotice) => void;
}

export interface StorageDeps {
  fetch: typeof fetch;
  openEvents: (url: string) => EventSourceLike;
}

const EVENTS_URL = "/api/storage/events";

export function createStorageHub(deps: StorageDeps) {
  const listeners = new Set<Listener>();
  let source: EventSourceLike | null = null;
  // Set once the stream has failed; the next open means changes may have
  // been missed while it was down.
  let dropped = false;

  const base = (ext: string, collection: string) =>
    `/api/storage/${encodeURIComponent(ext)}/${encodeURIComponent(collection)}`;

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await deps.fetch(url, init);
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((body && body.error) || `storage request failed (${res.status})`) as StorageError;
      err.status = res.status;
      if (body && "current" in body) err.current = body.current;
      throw err;
    }
    return body as T;
  }

  const getRecord = (ext: string, collection: string, key: string) =>
    request<StoredRecord | null>(`${base(ext, collection)}?key=${encodeURIComponent(key)}`);

  function dispatch(e: WireEvent, notice: StorageNotice | TopicNotice) {
    for (const l of listeners) {
      if (l.ext !== e.ext) continue;
      if (e.type === "resync") {
        l.cb({ type: "resync" });
        continue;
      }
      const matches =
        (e.type === "change" && l.kind === "collection" && l.name === e.collection) ||
        (e.type === "topic" && l.kind === "topic" && l.name === e.topic);
      if (!matches) continue;
      try {
        l.cb(notice);
      } catch (err) {
        console.error(`extension ${l.ext}: storage subscriber failed:`, err);
      }
    }
  }

  async function onEvent(e: WireEvent) {
    if (e.type === "change") {
      // A big value comes without its body; fetch it, so subscribers always
      // get the value (null-safe: it may be gone again by now).
      const changes = await Promise.all(
        e.changes.map(async (c): Promise<StorageChange> => {
          if (!c.large) return c;
          const rec = await getRecord(e.ext, e.collection, c.key).catch(() => null);
          return rec ? { key: c.key, rev: rec.rev, value: rec.value } : { key: c.key, rev: c.rev, deleted: true };
        }),
      );
      dispatch(e, { type: "change", changes });
    } else if (e.type === "topic") {
      dispatch(e, e.payload === undefined ? { type: "topic" } : { type: "topic", payload: e.payload });
    } else {
      dispatch(e, { type: "resync" });
    }
  }

  function ensureSource() {
    if (source) return;
    source = deps.openEvents(EVENTS_URL);
    source.onmessage = (ev) => {
      let e: WireEvent;
      try {
        e = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      void onEvent(e);
    };
    source.onerror = () => {
      dropped = true;
    };
    source.onopen = () => {
      if (!dropped) return;
      dropped = false;
      for (const l of listeners) {
        try {
          l.cb({ type: "resync" });
        } catch (err) {
          console.error(`extension ${l.ext}: storage subscriber failed:`, err);
        }
      }
    };
  }

  function subscribe(l: Listener): () => void {
    listeners.add(l);
    ensureSource();
    return () => {
      listeners.delete(l);
      if (listeners.size === 0 && source) {
        source.close();
        source = null;
        dropped = false;
      }
    };
  }

  function forExtension(ext: string): ExtensionStorageClient {
    return {
      collection(name) {
        const url = base(ext, name);
        return {
          get: <T>(key: string) => getRecord(ext, name, key) as Promise<StoredRecord<T> | null>,
          put: (key, value, opts) =>
            request<{ rev: number }>(url, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key, value, ifRev: opts?.ifRev }),
            }),
          delete: (key, opts) =>
            request<void>(`${url}?key=${encodeURIComponent(key)}${opts?.ifRev !== undefined ? `&ifRev=${opts.ifRev}` : ""}`, {
              method: "DELETE",
            }),
          list: <T>(opts: { prefix?: string; after?: string; limit?: number; keysOnly?: boolean } = {}) => {
            const q = new URLSearchParams();
            if (opts.prefix) q.set("prefix", opts.prefix);
            if (opts.after !== undefined) q.set("after", opts.after);
            if (opts.limit !== undefined) q.set("limit", String(opts.limit));
            if (opts.keysOnly) q.set("keysOnly", "1");
            const qs = q.toString();
            return request<ListedRecord<T>[]>(qs ? `${url}?${qs}` : url);
          },
          subscribe: (cb) => subscribe({ ext, kind: "collection", name, cb: cb as Listener["cb"] }),
        };
      },
      subscribeTopic: (topic, cb) => subscribe({ ext, kind: "topic", name: topic, cb: cb as Listener["cb"] }),
    };
  }

  return { forExtension };
}

let hub: ReturnType<typeof createStorageHub> | null = null;

export function createStorageClient(ext: string): ExtensionStorageClient {
  hub ??= createStorageHub({ fetch: (...args) => fetch(...args), openEvents: openSharedEventSource });
  return hub.forExtension(ext);
}
