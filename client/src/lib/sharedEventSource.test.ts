import { afterEach, describe, expect, it } from "vitest";
import { SharedEvents, type EventSourceLike } from "./sharedEventSource";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the browser's EventSource: counts live connections per URL
// and lets a test push events, open it, or fail it.
class FakeEventSource extends EventTarget {
  static live: FakeEventSource[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    super();
    FakeEventSource.live.push(this);
  }
  static count(url: string): number {
    return FakeEventSource.live.filter((e) => e.url === url && e.readyState !== 2).length;
  }
  static current(url: string): FakeEventSource {
    const found = FakeEventSource.live.filter((e) => e.url === url && e.readyState !== 2);
    if (found.length !== 1) throw new Error(`expected one live connection to ${url}, found ${found.length}`);
    return found[0];
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  emit(type: string, data: string): void {
    this.dispatchEvent(new MessageEvent(type, { data }));
  }
  fail(): void {
    this.readyState = 2;
    this.dispatchEvent(new Event("error"));
  }
  close(): void {
    this.readyState = 2;
  }
}

// Web Locks in one process: the first request holds the lock until the test
// closes that window; the next waiting request is granted then.
class FakeLocks {
  private queue: { owner: string; grant: () => void }[] = [];
  private holder: string | null = null;
  current = "";
  request(owner: string) {
    return (_name: string, cb: () => Promise<unknown>) =>
      new Promise<unknown>(() => {
        this.queue.push({ owner, grant: () => void cb() });
        this.pump();
      });
  }
  release(owner: string): void {
    this.queue = this.queue.filter((q) => q.owner !== owner);
    if (this.holder === owner) {
      this.holder = null;
      this.pump();
    }
  }
  private pump(): void {
    if (this.holder !== null || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.holder = next.owner;
    this.current = next.owner;
    next.grant();
  }
}

interface Win {
  name: string;
  hub: SharedEvents;
  close(): void;
}

let channelSeq = 0;
let windows: Win[] = [];

function makeWorld(opts: { locks: boolean }) {
  const channelName = `test-${++channelSeq}`;
  const locks = opts.locks ? new FakeLocks() : null;
  let seq = 0;
  const open = (name: string): Win => {
    let hide: () => void = () => {};
    const id = `${String(++seq).padStart(2, "0")}-${name}`;
    const hub = new SharedEvents({
      channelName,
      createChannel: (n) => new BroadcastChannel(n),
      createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
      locks: locks ? { request: locks.request(id) } : null,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      now: () => Date.now(),
      randomId: () => id,
      onPageHide: (cb) => {
        hide = cb;
      },
    });
    const win: Win = {
      name,
      hub,
      close: () => {
        hide();
        locks?.release(id);
        windows = windows.filter((w) => w !== win);
      },
    };
    windows.push(win);
    return win;
  };
  return { open };
}

function record(source: EventSourceLike, types: string[]): string[] {
  const log: string[] = [];
  source.onmessage = (e) => log.push(`message:${e.data}`);
  for (const t of types) source.addEventListener(t, (e) => log.push(e instanceof MessageEvent ? `${t}:${e.data}` : t));
  return log;
}

afterEach(() => {
  for (const w of [...windows]) w.close();
  FakeEventSource.live = [];
});

describe.each([
  { mode: "Web Locks", locks: true },
  { mode: "fallback election", locks: false },
])("shared event source ($mode)", ({ locks }) => {
  it("opens one connection for several windows and delivers every event to all of them", async () => {
    const world = makeWorld({ locks });
    const a = world.open("a");
    const b = world.open("b");
    await sleep(600);
    const la = record(a.hub.open("/events"), ["open", "changed"]);
    const lb = record(b.hub.open("/events"), ["open", "changed"]);
    await sleep(50);
    expect(FakeEventSource.count("/events")).toBe(1);
    const es = FakeEventSource.current("/events");
    es.open();
    es.emit("changed", "x1");
    es.emit("message", "plain");
    await sleep(50);
    expect(la).toEqual(["open", "changed:x1", "message:plain"]);
    expect(lb).toEqual(["open", "changed:x1", "message:plain"]);
    expect([a.hub.isLeader, b.hub.isLeader].filter(Boolean)).toHaveLength(1);
  });

  it("gives a window that joins an open stream an open event of its own", async () => {
    const world = makeWorld({ locks });
    const a = world.open("a");
    await sleep(600);
    record(a.hub.open("/events"), ["open"]);
    await sleep(20);
    FakeEventSource.current("/events").open();
    const b = world.open("b");
    await sleep(600);
    const lb = record(b.hub.open("/events"), ["open", "changed"]);
    await sleep(50);
    FakeEventSource.current("/events").emit("changed", "y");
    await sleep(50);
    expect(lb).toEqual(["open", "changed:y"]);
    expect(FakeEventSource.count("/events")).toBe(1);
  });

  it("hands the connection over when the leader's window closes", async () => {
    const world = makeWorld({ locks });
    const a = world.open("a");
    await sleep(600);
    const b = world.open("b");
    await sleep(600);
    const la = record(a.hub.open("/events"), ["changed"]);
    const lb = record(b.hub.open("/events"), ["changed"]);
    await sleep(50);
    const leader = a.hub.isLeader ? a : b;
    const other = leader === a ? b : a;
    const lOther = other === a ? la : lb;
    leader.close();
    await sleep(700);
    expect(other.hub.isLeader).toBe(true);
    expect(FakeEventSource.count("/events")).toBe(1);
    const es = FakeEventSource.current("/events");
    es.open();
    es.emit("changed", "after");
    await sleep(50);
    expect(lOther).toEqual(["changed:after"]);
  });

  it("keeps one connection per URL and closes one nobody wants", async () => {
    const world = makeWorld({ locks });
    const a = world.open("a");
    const b = world.open("b");
    await sleep(600);
    const s1 = a.hub.open("/one");
    b.hub.open("/two");
    b.hub.open("/one");
    await sleep(50);
    expect(FakeEventSource.count("/one")).toBe(1);
    expect(FakeEventSource.count("/two")).toBe(1);
    s1.close();
    await sleep(50);
    expect(FakeEventSource.count("/one")).toBe(1);
    for (const w of windows) if (w !== a) w.close();
    await sleep(2600);
    expect(a.hub.isLeader).toBe(true);
    expect(FakeEventSource.count("/one")).toBe(0);
    expect(FakeEventSource.count("/two")).toBe(0);
  });
});

describe("shared event source upstream", () => {
  it("reports an error, reopens after the browser gives up, and reports the new open", async () => {
    const world = makeWorld({ locks: true });
    const a = world.open("a");
    const b = world.open("b");
    await sleep(100);
    const lb = record(b.hub.open("/events"), ["open", "error"]);
    await sleep(50);
    FakeEventSource.current("/events").open();
    await sleep(30);
    FakeEventSource.current("/events").fail();
    await sleep(30);
    expect(FakeEventSource.count("/events")).toBe(0);
    await sleep(1100);
    FakeEventSource.current("/events").open();
    await sleep(30);
    expect(lb).toEqual(["open", "error", "open"]);
    expect(a.hub.isLeader).toBe(true);
  });

  it("falls back to a plain EventSource without BroadcastChannel", () => {
    const hub = new SharedEvents({
      channelName: "none",
      createChannel: null,
      createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
      locks: null,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: () => {},
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: () => {},
      now: () => Date.now(),
      randomId: () => "solo",
      onPageHide: () => {},
    });
    hub.open("/x");
    hub.open("/x");
    expect(FakeEventSource.count("/x")).toBe(2);
  });
});
