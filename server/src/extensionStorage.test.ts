// The storage behind activate({ storage }) and ctx.storage: what an extension
// relies on is that records round-trip with growing revisions, that a
// transaction is all-or-nothing, that conflicts and limits are refused with
// nothing stored, that its own SQL can't reach the reserved tables, that an
// unreadable database is moved aside rather than taking Perch down, and that
// each data root (one per Perch profile) is its own world.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExtensionStorageService, shortId, StorageConflict, type StorageEvent } from "./extensionStorage.js";

const roots: string[] = [];
async function service() {
  const root = await mkdtemp(path.join(tmpdir(), "perch-storage-test-"));
  roots.push(root);
  const logs: string[] = [];
  const svc = createExtensionStorageService({
    dataRoot: path.join(root, "data"),
    stateRoot: path.join(root, "x"),
    log: (...a) => logs.push(a.join(" ")),
  });
  return { svc, root, logs };
}

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("collections", () => {
  it("round-trips records with growing revisions, and lists by prefix in key order", async () => {
    const { svc } = await service();
    const notes = svc.forExtension("notes").collection("notes");
    expect(await notes.get("a")).toBeNull();
    expect(await notes.put("a", { body: "one" })).toEqual({ rev: 1 });
    expect(await notes.put("a", { body: "two" })).toEqual({ rev: 2 });
    expect(await notes.get("a")).toEqual({ value: { body: "two" }, rev: 2 });
    await notes.put("b/2", 2);
    await notes.put("b/1", 1);
    await notes.put("c", 3);
    expect((await notes.list({ prefix: "b/" })).map((r) => r.key)).toEqual(["b/1", "b/2"]);
    expect((await notes.list({ limit: 2 })).map((r) => r.key)).toEqual(["a", "b/1"]);
    expect((await notes.list({ after: "b/1" })).map((r) => r.key)).toEqual(["b/2", "c"]);
    expect(await notes.list({ prefix: "b/", keysOnly: true })).toEqual([
      { key: "b/1", rev: 1 },
      { key: "b/2", rev: 1 },
    ]);
    await notes.delete("a");
    expect(await notes.get("a")).toBeNull();
  });

  it("keeps collections apart", async () => {
    const { svc } = await service();
    const s = svc.forExtension("ext");
    await s.collection("one").put("k", 1);
    expect(await s.collection("two").get("k")).toBeNull();
  });

  it("applies 50 concurrent updates without losing any", async () => {
    const { svc } = await service();
    const c = svc.forExtension("ext").collection("counters");
    await Promise.all(Array.from({ length: 50 }, () => c.update("n", (v) => ((v as number) ?? 0) + 1)));
    expect((await c.get("n"))?.value).toBe(50);
  });

  it("deletes through update when the callback returns undefined", async () => {
    const { svc } = await service();
    const c = svc.forExtension("ext").collection("c");
    await c.put("k", 1);
    expect(await c.update("k", () => undefined)).toBeNull();
    expect(await c.get("k")).toBeNull();
  });

  it("refuses a write that names an old revision, returning what is stored", async () => {
    const { svc } = await service();
    const c = svc.forExtension("ext").collection("c");
    const { rev } = await c.put("k", "first");
    await c.put("k", "second", { ifRev: rev });
    const err = await c.put("k", "third", { ifRev: rev }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageConflict);
    expect(err.current).toEqual({ value: "second", rev: 2 });
    await expect(c.put("new", 1, { ifRev: 0 })).resolves.toEqual({ rev: 1 });
    await expect(c.put("new", 1, { ifRev: 0 })).rejects.toBeInstanceOf(StorageConflict);
  });

  it("refuses records over 16 MB and keys over 1024 characters, storing nothing", async () => {
    const { svc } = await service();
    const c = svc.forExtension("ext").collection("c");
    await expect(c.put("big", "x".repeat(17 * 1024 * 1024))).rejects.toThrow(/16 MB/);
    await expect(c.put("k".repeat(1025), 1)).rejects.toThrow(/1024/);
    expect(await c.list()).toEqual([]);
    const fifteen = "y".repeat(15 * 1024 * 1024);
    await c.put("ok", fifteen);
    expect((await c.get("ok"))?.value).toBe(fifteen);
  });

  it("refuses bad collection names", async () => {
    const { svc } = await service();
    expect(() => svc.forExtension("ext").collection("../x")).toThrow(/invalid collection/);
    expect(() => svc.forExtension("../x")).toThrow(/invalid extension/);
  });
});

describe("transactions", () => {
  it("is all or nothing", async () => {
    const { svc } = await service();
    const s = svc.forExtension("ext");
    await expect(
      s.transaction((tx) => {
        tx.collection("a").put("1", 1);
        tx.collection("b").put("2", 2);
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(await s.collection("a").get("1")).toBeNull();
    expect(await s.collection("b").get("2")).toBeNull();
  });

  it("publishes changes once, after it commits", async () => {
    const { svc } = await service();
    const events: StorageEvent[] = [];
    svc.onChange((e) => events.push(e));
    const s = svc.forExtension("ext");
    await s.transaction((tx) => {
      tx.collection("a").put("1", 1);
      tx.collection("a").put("2", 2);
      expect(events).toEqual([]);
    });
    expect(events).toEqual([
      { ext: "ext", type: "change", collection: "a", changes: [{ key: "1", rev: 1, value: 1 }, { key: "2", rev: 1, value: 2 }] },
    ]);
    await s.collection("a").delete("1");
    expect(events[1]).toEqual({ ext: "ext", type: "change", collection: "a", changes: [{ key: "1", rev: 2, deleted: true }] });
    s.notify("changed", { n: 1 });
    expect(events[2]).toEqual({ ext: "ext", type: "topic", topic: "changed", payload: { n: 1 } });
  });

  it("refuses an async callback", async () => {
    const { svc } = await service();
    const s = svc.forExtension("ext");
    await expect(s.transaction(async () => {})).rejects.toThrow(/synchronous/);
  });
});

describe("raw SQL", () => {
  it("can make its own tables and indexes, but can't reach the reserved ones", async () => {
    const { svc } = await service();
    const s = svc.forExtension("ext");
    await s.collection("c").put("k", 1);
    s.sql.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, n INTEGER); CREATE INDEX runs_n ON runs (n);");
    s.sql.prepare("INSERT INTO runs VALUES (?, ?)").run("a", 3);
    expect(s.sql.prepare("SELECT n FROM runs WHERE id = ?").get("a")).toEqual({ n: 3 });
    expect(() => s.sql.prepare("SELECT * FROM _perch_records").all()).toThrow();
    expect(() => s.sql.exec("DELETE FROM _perch_records")).toThrow();
    expect(() => s.sql.exec("DROP TABLE _perch_records")).toThrow();
    expect(() => s.sql.exec("ATTACH DATABASE ':memory:' AS other")).toThrow();
    expect((await s.collection("c").get("k"))?.value).toBe(1);
  });
});

describe("files and lifecycle", () => {
  it("keeps each data root to itself", async () => {
    const a = await service();
    const b = await service();
    await a.svc.forExtension("notes").collection("notes").put("n1", "hello");
    expect(await b.svc.forExtension("notes").collection("notes").get("n1")).toBeNull();
  });

  it("makes private folders and a private database file", async () => {
    const { svc, root } = await service();
    const s = svc.forExtension("ext");
    await s.collection("c").put("k", 1);
    const mode = async (p: string) => (await stat(p)).mode & 0o777;
    expect(await mode(path.join(root, "data", "ext"))).toBe(0o700);
    expect(await mode(path.join(root, "data", "ext", "data.sqlite"))).toBe(0o600);
    expect(await mode(s.filesDir())).toBe(0o700);
    expect(await mode(s.runtimeDir())).toBe(0o700);
    expect(s.runtimeDir()).toBe(path.join(root, "x", "ext"));
    expect(s.runtimeDirOf("agent-tasks")).toBe(path.join(root, "x", "agent-tasks"));
  });

  it("keeps runtime folder names short", () => {
    expect(shortId("perch.agent-tasks")).toBe("perch.agent-tasks");
    const long = shortId("publisher.some-very-long-extension-name");
    expect(long.length).toBeLessThanOrEqual(17);
    expect(long).toMatch(/^publisher\.-[0-9a-f]{6}$/);
    // A 60-character state folder + /x/ + the short name stays within 80.
    expect(("s".repeat(60) + "/x/" + long).length).toBeLessThanOrEqual(80);
  });

  it("moves an unreadable database aside and starts fresh", async () => {
    const { svc, root, logs } = await service();
    const dir = path.join(root, "data", "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "data.sqlite"), "this is not a database, just text ".repeat(200));
    const c = svc.forExtension("broken").collection("c");
    await c.put("k", 1);
    expect((await c.get("k"))?.value).toBe(1);
    const files = await readdir(dir);
    expect(files.some((f) => /^data\.sqlite\.corrupt-\d{8}-\d{6}$/.test(f))).toBe(true);
    expect(logs.join("\n")).toMatch(/extension broken: storage was unreadable/);
    const kept = files.find((f) => f.includes("corrupt"))!;
    expect(await readFile(path.join(dir, kept), "utf8")).toMatch(/not a database/);
  });

  it("reports sizes, and deletes one extension's data", async () => {
    const { svc, root } = await service();
    const events: StorageEvent[] = [];
    svc.onChange((e) => events.push(e));
    await svc.forExtension("notes").collection("c").put("k", "x".repeat(1000));
    await svc.forExtension("gone").collection("c").put("k", 1);
    const sizes = await svc.sizes(["notes"]);
    expect(sizes.map((s) => [s.id, s.installed])).toEqual([
      ["gone", false],
      ["notes", true],
    ]);
    expect(sizes.every((s) => s.bytes > 0)).toBe(true);
    await svc.deleteData("gone");
    expect(await readdir(path.join(root, "data"))).toEqual(["notes"]);
    expect(events.at(-1)).toEqual({ ext: "gone", type: "resync" });
    // It starts empty afterwards.
    expect(await svc.forExtension("gone").collection("c").get("k")).toBeNull();
  });

  it("keeps data when an extension is released, and runs validators only when asked", async () => {
    const { svc } = await service();
    const c = svc.forExtension("notes").collection("notes");
    c.validate((_key, value) => (JSON.stringify(value).length > 10 ? "Notes are limited" : undefined));
    expect(svc.validateClientWrite("notes", "notes", "k", "x".repeat(20))).toBe("Notes are limited");
    expect(svc.validateClientWrite("notes", "notes", "k", "ok")).toBeNull();
    // Server writes skip it.
    await c.put("k", "x".repeat(20));
    svc.release("notes");
    expect(svc.validateClientWrite("notes", "notes", "k", "x".repeat(20))).toBeNull();
    expect((await svc.forExtension("notes").collection("notes").get("k"))?.value).toBe("x".repeat(20));
  });
});
