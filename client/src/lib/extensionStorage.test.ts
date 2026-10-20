import { describe, expect, it, vi } from "vitest";
import { createStorageHub, type StorageNotice } from "./extensionStorage";
import type { EventSourceLike } from "./sharedEventSource";

function fakeSource() {
  const src = {
    url: "",
    readyState: 1,
    onmessage: null,
    onopen: null,
    onerror: null,
    addEventListener() {},
    removeEventListener() {},
    close: vi.fn(),
  } as unknown as EventSourceLike & { close: ReturnType<typeof vi.fn> };
  const emit = (data: unknown) => src.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  return { src, emit };
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("extension storage client", () => {
  it("hands each subscriber only its own extension's collection or topic", async () => {
    const { src, emit } = fakeSource();
    const hub = createStorageHub({ fetch: vi.fn(), openEvents: () => src });
    const notes: StorageNotice[] = [];
    const topics: unknown[] = [];
    hub.forExtension("notes").collection("notes").subscribe((n) => notes.push(n));
    hub.forExtension("notes").subscribeTopic("changed", (n) => topics.push(n));
    emit({ ext: "notes", type: "change", collection: "notes", changes: [{ key: "a", rev: 1, value: 1 }] });
    emit({ ext: "notes", type: "change", collection: "surfaces", changes: [{ key: "s", rev: 1, value: 1 }] });
    emit({ ext: "other", type: "change", collection: "notes", changes: [{ key: "b", rev: 1, value: 1 }] });
    emit({ ext: "notes", type: "topic", topic: "changed", payload: 3 });
    emit({ ext: "notes", type: "topic", topic: "other" });
    await flush();
    expect(notes).toEqual([{ type: "change", changes: [{ key: "a", rev: 1, value: 1 }] }]);
    expect(topics).toEqual([{ type: "topic", payload: 3 }]);
  });

  it("fetches a large value before handing the change on", async () => {
    const { src, emit } = fakeSource();
    const fetchFn = vi.fn(async () => json({ value: "big", rev: 4 }));
    const hub = createStorageHub({ fetch: fetchFn as unknown as typeof fetch, openEvents: () => src });
    const seen: StorageNotice[] = [];
    hub.forExtension("http-client").collection("history").subscribe((n) => seen.push(n));
    emit({ ext: "http-client", type: "change", collection: "history", changes: [{ key: "k/1", rev: 4, large: true }] });
    await flush();
    await flush();
    expect(fetchFn).toHaveBeenCalledWith("/api/storage/http-client/history?key=k%2F1", undefined);
    expect(seen).toEqual([{ type: "change", changes: [{ key: "k/1", rev: 4, value: "big" }] }]);
  });

  it("tells every subscriber to resync when the stream comes back, and on a data delete", async () => {
    const { src, emit } = fakeSource();
    const hub = createStorageHub({ fetch: vi.fn(), openEvents: () => src });
    const a: StorageNotice[] = [];
    const b: unknown[] = [];
    hub.forExtension("notes").collection("notes").subscribe((n) => a.push(n));
    hub.forExtension("automations").subscribeTopic("changed", (n) => b.push(n));
    src.onopen?.(new Event("open"));
    expect(a).toEqual([]);
    src.onerror?.(new Event("error"));
    src.onopen?.(new Event("open"));
    expect(a).toEqual([{ type: "resync" }]);
    expect(b).toEqual([{ type: "resync" }]);
    emit({ ext: "notes", type: "resync" });
    await flush();
    expect(a).toEqual([{ type: "resync" }, { type: "resync" }]);
    expect(b).toHaveLength(1);
  });

  it("opens one stream for all subscribers and closes it with the last", () => {
    const { src } = fakeSource();
    const open = vi.fn(() => src);
    const hub = createStorageHub({ fetch: vi.fn(), openEvents: open });
    const off1 = hub.forExtension("a").collection("x").subscribe(() => {});
    const off2 = hub.forExtension("b").subscribeTopic("t", () => {});
    expect(open).toHaveBeenCalledTimes(1);
    off1();
    expect(src.close).not.toHaveBeenCalled();
    off2();
    expect(src.close).toHaveBeenCalledTimes(1);
  });

  it("turns a refused write into an Error with the server's message and the stored record", async () => {
    const fetchFn = vi.fn(async () => json({ error: "the record has changed since it was read", current: { value: 2, rev: 2 } }, 409));
    const hub = createStorageHub({ fetch: fetchFn as unknown as typeof fetch, openEvents: () => fakeSource().src });
    const err = await hub
      .forExtension("notes")
      .collection("notes")
      .put("k", 3, { ifRev: 1 })
      .catch((e) => e);
    expect(err.message).toBe("the record has changed since it was read");
    expect(err.status).toBe(409);
    expect(err.current).toEqual({ value: 2, rev: 2 });
    expect(JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ key: "k", value: 3, ifRev: 1 });
  });
});
