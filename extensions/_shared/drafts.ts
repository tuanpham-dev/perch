// Ordered access to the host's server-side drafts store (ctx.drafts — see
// server/src/drafts.ts), for viewers that back up unsaved edits so a reload,
// a crash or an extension update doesn't lose them and another device can
// pick them up. The text editor in perch-extensions keeps its own copy
// (text-editor/src/unsavedBackup.ts) — same rules.
//
// Requests for one key are chained so they reach the server in issue order:
// a slow write landing after the delete that followed a save would otherwise
// resurrect edits already on disk. Every failure is swallowed — a backup that
// can't be written must never break editing itself.

export interface DraftsApi {
  get(key: string): Promise<{ value: unknown; savedAt: number } | null>;
  set(key: string, value: unknown, opts?: { keepalive?: boolean }): Promise<void>;
  delete(key: string, opts?: { keepalive?: boolean }): Promise<void>;
}

export function createDraftClient(api: DraftsApi) {
  const queues = new Map<string, Promise<void>>();

  function enqueue(key: string, op: () => Promise<void>): void {
    const next = (queues.get(key) ?? Promise.resolve()).then(op).catch(() => {});
    queues.set(key, next);
    void next.then(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  }

  return {
    /** The stored value, or null — after this key's pending writes land. */
    async read(key: string): Promise<unknown> {
      await queues.get(key);
      try {
        return (await api.get(key))?.value ?? null;
      } catch {
        return null;
      }
    },
    // `keepalive` is for pagehide: sent at once rather than queued, since a
    // queued request would start after the page is gone.
    write(key: string, value: unknown, opts?: { keepalive?: boolean }): void {
      if (opts?.keepalive) void api.set(key, value, opts).catch(() => {});
      else enqueue(key, () => api.set(key, value));
    },
    clear(key: string, opts?: { keepalive?: boolean }): void {
      if (opts?.keepalive) void api.delete(key, opts).catch(() => {});
      else enqueue(key, () => api.delete(key));
    },
  };
}

export type DraftClient = ReturnType<typeof createDraftClient>;

// FNV-1a over UTF-16 code units, plus the length: a cheap fingerprint of the
// on-disk text a draft was made against, so a restore can tell the file has
// changed since. Only ever compared against another hash of the same file.
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}
