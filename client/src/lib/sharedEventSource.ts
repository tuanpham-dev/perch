// One server-sent-events connection per URL for every Perch window of this
// origin, instead of one per window.
//
// Browsers allow six HTTP/1.1 connections per origin, shared by every tab
// and window, and an EventSource holds one for as long as it is open. Each
// window opening its own streams (core's `perch open` channel, an
// extension's live updates) fills that pool after two or three windows,
// and from then on every other request from those windows waits in the
// browser's queue: a tab moved into a new window loads nothing. Over
// HTTP/2 (an HTTPS proxy) there is no such limit, but plain http:// is the
// common way to reach Perch on a LAN or a dev port.
//
// So one window, the leader, opens the real EventSource for each URL any
// window wants, and relays every event over a BroadcastChannel; the others
// only listen. The leader is chosen with Web Locks where the browser has
// them (secure contexts: HTTPS or localhost), which hand the lock to the
// next waiting window the moment the leader's window goes away. Without
// them (plain http:// to another host) windows elect one over the channel:
// the leader sends a heartbeat, a window that hears no leader claims the
// role, and of two leaders the one with the smaller id keeps it. Without
// BroadcastChannel at all, each caller simply gets a native EventSource.
//
// The object handed out behaves like an EventSource for what callers use:
// addEventListener / removeEventListener, onmessage / onopen / onerror,
// readyState and close(). "open" and "error" reflect the shared upstream;
// a subscriber that arrives while it is already open gets an "open" of its
// own, as a fresh EventSource would.

export interface EventSourceLike {
  readonly url: string;
  readonly readyState: number;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

type Wire =
  | { k: "want"; from: string; url: string; types: string[] }
  | { k: "unwant"; from: string; url: string }
  | { k: "gone"; from: string }
  | { k: "leader"; from: string }
  | { k: "hb"; from: string }
  | { k: "ping"; from: string }
  | { k: "ev"; url: string; type: string; data: string; lastEventId: string }
  | { k: "state"; url: string; readyState: number; event: "open" | "error" | null; to?: string };

interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

export interface SharedEventsDeps {
  channelName: string;
  createChannel: ((name: string) => BroadcastChannel) | null;
  createEventSource: (url: string) => EventSource;
  locks: LockManagerLike | null;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
  randomId: () => string;
  // Fires `cb` when this window is going away for good.
  onPageHide: (cb: () => void) => void;
}

// Fallback election timing. The heartbeat is sparse because hidden tabs get
// their timers throttled (to once a minute under Chrome's intensive
// throttling), so a leader that is merely in the background must not be
// taken for dead: a leader that closes says so ("gone") and hands over at
// once; a crashed one is replaced after LEADER_TIMEOUT_MS.
const HEARTBEAT_MS = 5_000;
const LEADER_TIMEOUT_MS = 90_000;
// How long a new window waits for an existing leader to answer its ping.
const ELECTION_WAIT_MS = 400;
// Backoff for reopening an upstream the browser gave up on (a server
// restart), as EventSource itself only retries while the server is slow.
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
// A URL nobody wants any more keeps its connection this long, so a caller
// that closes and reopens (a reconnect loop, a React remount) doesn't cycle
// the upstream.
const IDLE_CLOSE_MS = 2_000;

interface Subscriber {
  source: SharedSource;
}

interface Upstream {
  url: string;
  es: EventSource | null;
  types: Set<string>;
  // Which windows want this URL, and the event types each listens for.
  wanters: Map<string, Set<string>>;
  readyState: number;
  retryMs: number;
  retryTimer: unknown;
  idleTimer: unknown;
}

export class SharedEvents {
  private readonly id: string;
  private readonly channel: BroadcastChannel | null;
  private leader = false;
  // Fallback election only.
  private lastLeaderSeen = 0;
  private heartbeat: unknown = null;
  private watchdog: unknown = null;
  // This window's subscribers, by URL.
  private readonly subs = new Map<string, Set<Subscriber>>();
  // Only on the leader.
  private readonly upstreams = new Map<string, Upstream>();

  constructor(private readonly deps: SharedEventsDeps) {
    this.id = deps.randomId();
    this.channel = deps.createChannel ? deps.createChannel(deps.channelName) : null;
    if (!this.channel) return;
    this.channel.onmessage = (e: MessageEvent<Wire>) => this.onWire(e.data);
    deps.onPageHide(() => this.dispose());
    if (deps.locks) {
      // Held for the life of the window; the next waiter gets it when this
      // window goes away, however it goes.
      void deps.locks
        .request(deps.channelName, () => {
          this.becomeLeader();
          return new Promise(() => {});
        })
        .catch(() => {});
    } else {
      this.post({ k: "ping", from: this.id });
      deps.setTimeout(() => {
        if (!this.leader && this.lastLeaderSeen === 0) this.becomeLeader();
      }, ELECTION_WAIT_MS);
      this.watchdog = deps.setInterval(() => {
        if (!this.leader && this.lastLeaderSeen !== 0 && deps.now() - this.lastLeaderSeen > LEADER_TIMEOUT_MS) {
          this.becomeLeader();
        }
      }, HEARTBEAT_MS);
    }
  }

  get isLeader(): boolean {
    return this.leader;
  }

  open(url: string): EventSourceLike {
    if (!this.channel) return this.deps.createEventSource(url) as unknown as EventSourceLike;
    return new SharedSource(this, url);
  }

  // ---- called by SharedSource ----

  subscribe(sub: Subscriber): void {
    const url = sub.source.url;
    let set = this.subs.get(url);
    if (!set) {
      set = new Set();
      this.subs.set(url, set);
    }
    set.add(sub);
    this.announce(url);
  }

  unsubscribe(sub: Subscriber): void {
    const url = sub.source.url;
    const set = this.subs.get(url);
    if (!set) return;
    set.delete(sub);
    if (set.size > 0) {
      this.announce(url);
      return;
    }
    this.subs.delete(url);
    if (this.leader) this.dropWanter(url, this.id);
    else this.post({ k: "unwant", from: this.id, url });
  }

  // A subscriber started listening for another event type.
  announce(url: string): void {
    const types = this.typesFor(url);
    if (this.leader) this.addWanter(url, this.id, types);
    else this.post({ k: "want", from: this.id, url, types: [...types] });
  }

  // ---- election ----

  private becomeLeader(): void {
    if (this.leader) return;
    this.leader = true;
    this.post({ k: "leader", from: this.id });
    if (!this.deps.locks) {
      this.heartbeat = this.deps.setInterval(() => this.post({ k: "hb", from: this.id }), HEARTBEAT_MS);
    }
    for (const url of this.subs.keys()) this.addWanter(url, this.id, this.typesFor(url));
  }

  private stepDown(): void {
    if (!this.leader) return;
    this.leader = false;
    if (this.heartbeat !== null) this.deps.clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const up of this.upstreams.values()) this.closeUpstream(up);
    this.upstreams.clear();
    for (const url of this.subs.keys()) this.post({ k: "want", from: this.id, url, types: [...this.typesFor(url)] });
  }

  private dispose(): void {
    if (!this.channel) return;
    this.post({ k: "gone", from: this.id });
    if (this.leader) {
      for (const up of this.upstreams.values()) this.closeUpstream(up);
      this.upstreams.clear();
      this.leader = false;
    }
    if (this.heartbeat !== null) this.deps.clearInterval(this.heartbeat);
    if (this.watchdog !== null) this.deps.clearInterval(this.watchdog);
    this.heartbeat = null;
    this.watchdog = null;
    this.channel.onmessage = null;
    this.channel.close();
  }

  // ---- the channel ----

  private post(msg: Wire): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      // A closed channel (window going away): nothing to tell.
    }
  }

  private onWire(msg: Wire): void {
    switch (msg.k) {
      case "want":
        if (this.leader) this.addWanter(msg.url, msg.from, new Set(msg.types));
        break;
      case "unwant":
        if (this.leader) this.dropWanter(msg.url, msg.from);
        break;
      case "gone":
        if (this.leader) {
          for (const url of [...this.upstreams.keys()]) this.dropWanter(url, msg.from);
        } else if (!this.deps.locks && msg.from !== this.id) {
          // Possibly the leader leaving: whoever answers first takes over;
          // duplicates resolve through the id rule below.
          this.lastLeaderSeen = 0;
          this.post({ k: "ping", from: this.id });
          this.deps.setTimeout(() => {
            if (!this.leader && this.lastLeaderSeen === 0) this.becomeLeader();
          }, ELECTION_WAIT_MS);
        }
        break;
      case "leader":
      case "hb":
        this.lastLeaderSeen = this.deps.now();
        if (this.leader && !this.deps.locks && msg.from < this.id) {
          this.stepDown();
          break;
        }
        if (msg.k === "leader" && !this.leader) {
          // A new leader knows nothing yet: tell it what this window wants.
          for (const url of this.subs.keys()) this.post({ k: "want", from: this.id, url, types: [...this.typesFor(url)] });
        }
        break;
      case "ping":
        if (this.leader) this.post({ k: "hb", from: this.id });
        break;
      case "ev":
        this.dispatchLocal(msg.url, msg.type, msg.data, msg.lastEventId);
        break;
      case "state":
        if (msg.to !== undefined && msg.to !== this.id) break;
        this.applyState(msg.url, msg.readyState, msg.event);
        break;
    }
  }

  // ---- local delivery ----

  private typesFor(url: string): Set<string> {
    const types = new Set<string>();
    for (const sub of this.subs.get(url) ?? []) for (const t of sub.source.eventTypes()) types.add(t);
    return types;
  }

  private dispatchLocal(url: string, type: string, data: string, lastEventId: string): void {
    for (const sub of [...(this.subs.get(url) ?? [])]) sub.source.deliverMessage(type, data, lastEventId);
  }

  private applyState(url: string, readyState: number, event: "open" | "error" | null): void {
    for (const sub of [...(this.subs.get(url) ?? [])]) sub.source.deliverState(readyState, event);
  }

  // ---- upstreams (leader only) ----

  private addWanter(url: string, from: string, types: Set<string>): void {
    let up = this.upstreams.get(url);
    if (!up) {
      up = { url, es: null, types: new Set(), wanters: new Map(), readyState: CONNECTING, retryMs: MIN_RETRY_MS, retryTimer: null, idleTimer: null };
      this.upstreams.set(url, up);
    }
    if (up.idleTimer !== null) {
      this.deps.clearTimeout(up.idleTimer);
      up.idleTimer = null;
    }
    up.wanters.set(from, types);
    if (!up.es && up.retryTimer === null) this.connect(up);
    else this.listenFor(up, types);
    // Tell the newcomer where the stream stands: already open means an
    // "open" of its own, as a fresh EventSource would get. Local delivery is
    // deferred like the channel's, so a caller attaching listeners right
    // after opening still hears it (subscribers that had it ignore a
    // repeat).
    const event = up.readyState === OPEN ? "open" : null;
    const readyState = up.readyState;
    if (from === this.id) this.deps.setTimeout(() => this.applyState(url, readyState, event), 0);
    else this.post({ k: "state", url, readyState, event, to: from });
  }

  private dropWanter(url: string, from: string): void {
    const up = this.upstreams.get(url);
    if (!up || !up.wanters.delete(from) || up.wanters.size > 0) return;
    up.idleTimer = this.deps.setTimeout(() => {
      up.idleTimer = null;
      if (up.wanters.size > 0) return;
      this.closeUpstream(up);
      this.upstreams.delete(url);
    }, IDLE_CLOSE_MS);
  }

  private connect(up: Upstream): void {
    up.retryTimer = null;
    const es = this.deps.createEventSource(up.url);
    up.es = es;
    up.types = new Set();
    up.readyState = CONNECTING;
    es.addEventListener("open", () => {
      if (up.es !== es) return;
      up.readyState = OPEN;
      up.retryMs = MIN_RETRY_MS;
      this.broadcastState(up, "open");
    });
    es.addEventListener("error", () => {
      if (up.es !== es) return;
      up.readyState = es.readyState;
      this.broadcastState(up, "error");
      if (es.readyState === CLOSED) {
        // The browser gave up (a server restart): reopen with a backoff.
        es.close();
        up.es = null;
        up.retryTimer = this.deps.setTimeout(() => {
          if (this.upstreams.get(up.url) === up && this.leader) this.connect(up);
        }, up.retryMs);
        up.retryMs = Math.min(MAX_RETRY_MS, up.retryMs * 2);
      }
    });
    for (const types of up.wanters.values()) this.listenFor(up, types);
  }

  private listenFor(up: Upstream, types: Set<string>): void {
    const es = up.es;
    if (!es) return;
    for (const type of types) {
      if (type === "open" || type === "error" || up.types.has(type)) continue;
      up.types.add(type);
      es.addEventListener(type, (event) => {
        if (up.es !== es) return;
        const m = event as MessageEvent<string>;
        const data = typeof m.data === "string" ? m.data : String(m.data);
        this.dispatchLocal(up.url, type, data, m.lastEventId ?? "");
        this.post({ k: "ev", url: up.url, type, data, lastEventId: m.lastEventId ?? "" });
      });
    }
  }

  private broadcastState(up: Upstream, event: "open" | "error"): void {
    this.applyState(up.url, up.readyState, event);
    this.post({ k: "state", url: up.url, readyState: up.readyState, event });
  }

  private closeUpstream(up: Upstream): void {
    if (up.retryTimer !== null) this.deps.clearTimeout(up.retryTimer);
    if (up.idleTimer !== null) this.deps.clearTimeout(up.idleTimer);
    up.retryTimer = null;
    up.idleTimer = null;
    up.es?.close();
    up.es = null;
  }
}

class SharedSource implements EventSourceLike {
  readonly url: string;
  readyState = CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  private readonly sub: Subscriber;
  private closed = false;

  constructor(
    private readonly hub: SharedEvents,
    url: string,
  ) {
    this.url = url;
    this.sub = { source: this };
    hub.subscribe(this.sub);
  }

  // The event types the upstream must carry for this source: "message"
  // always (onmessage may be set at any time), plus every named listener.
  eventTypes(): string[] {
    return ["message", ...[...this.listeners.keys()].filter((t) => t !== "message")];
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (this.closed) return;
    let set = this.listeners.get(type);
    const isNew = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    if (isNew && type !== "open" && type !== "error" && type !== "message") this.hub.announce(this.url);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = CLOSED;
    this.hub.unsubscribe(this.sub);
  }

  deliverMessage(type: string, data: string, lastEventId: string): void {
    if (this.closed) return;
    const event = new MessageEvent(type, { data, lastEventId });
    if (type === "message") this.onmessage?.(event);
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event);
  }

  deliverState(readyState: number, event: "open" | "error" | null): void {
    if (this.closed) return;
    this.readyState = readyState;
    if (!event) return;
    // Opened once already: a repeated "open" (a state replay) is not news.
    if (event === "open" && this.sawOpen && this.lastEvent === "open") return;
    this.lastEvent = event;
    if (event === "open") this.sawOpen = true;
    const e = new Event(event);
    if (event === "open") this.onopen?.(e);
    else this.onerror?.(e);
    for (const l of [...(this.listeners.get(event) ?? [])]) l(e);
  }

  private sawOpen = false;
  private lastEvent: "open" | "error" | null = null;
}

function defaultRandomId(): string {
  // crypto.randomUUID needs a secure context; plain http:// to another
  // host is exactly where this module matters most.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let instance: SharedEvents | null = null;

function shared(): SharedEvents {
  if (!instance) {
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManagerLike }) : null;
    instance = new SharedEvents({
      channelName: "perch-shared-events",
      createChannel: typeof BroadcastChannel === "function" ? (name) => new BroadcastChannel(name) : null,
      createEventSource: (url) => new EventSource(url),
      locks: nav?.locks ?? null,
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (h) => window.clearInterval(h as number),
      now: () => Date.now(),
      randomId: defaultRandomId,
      onPageHide: (cb) =>
        window.addEventListener("pagehide", (e) => {
          // A page kept in the back/forward cache comes back: it is not gone.
          if (!(e as PageTransitionEvent).persisted) cb();
        }),
    });
  }
  return instance;
}

// An EventSource for a same-origin URL whose connection is shared by every
// Perch window of this origin.
export function openSharedEventSource(url: string): EventSourceLike {
  return shared().open(url);
}
