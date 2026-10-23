// The tab's side of the page agent (pageAgent.js): installs it into a
// preview's frame after each load and carries its messages. "post" sends the
// source to the page's bootstrap for a sandboxed frame; "eval" runs it
// straight in a same-origin one (a dev server through /proxy/<port>/).
import { useEffect, useMemo, useState } from "react";
import type { ElementRect, PageStep, PickedElement } from "./ElementComments";

export interface PageError {
  kind: "console" | "exception" | "rejection" | "network" | "resource";
  message: string;
  source: string;
  time: number;
}

// What the agent finds again on the page: by the id it gave a pick while
// that page lives, else by selector (after a reload).
export interface TrackItem {
  id: string;
  pickId?: string;
  selector: string;
  selectors?: string[];
}

type Listener = (data: Record<string, unknown>) => void;

const sources = new Map<string, Promise<string>>();

function loadSource(url: string): Promise<string> {
  let p = sources.get(url);
  if (!p) {
    p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`page agent: ${res.status}`);
      return res.text();
    });
    p.catch(() => sources.delete(url));
    sources.set(url, p);
  }
  return p;
}

export class PageAgentLink {
  private listeners = new Map<string, Set<Listener>>();
  private ready = false;
  private reqSeq = 0;
  private errors: PageError[] = [];
  // A pick asked for before the page's agent was ready (a page still
  // loading): sent when it says it is.
  private queuedPick: "element" | "text" | null = null;
  private onMessage = (e: MessageEvent) => {
    const win = this.getWindow();
    if (!win || e.source !== win) return;
    const data = (e.data as { __pa?: Record<string, unknown> })?.__pa;
    if (!data || typeof data.type !== "string") return;
    if (data.type === "ready") {
      this.ready = true;
      this.errors = Array.isArray(data.errors) ? (data.errors as PageError[]) : this.errors;
      this.emit("errors", { list: this.errors });
      if (this.queuedPick) this.send("pick", { mode: this.queuedPick });
      this.queuedPick = null;
    } else if (data.type === "error" && data.entry) {
      this.errors = [...this.errors.slice(-99), data.entry as PageError];
      this.emit("errors", { list: this.errors });
    }
    this.emit(data.type, data);
  };

  constructor(
    private getWindow: () => Window | null,
    private mode: "post" | "eval",
    private sourceUrl: string,
  ) {
    window.addEventListener("message", this.onMessage);
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    this.listeners.clear();
  }

  isReady(): boolean {
    return this.ready;
  }

  pageErrors(): PageError[] {
    return this.errors;
  }

  on(type: string, fn: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => set?.delete(fn);
  }

  private emit(type: string, data: Record<string, unknown>): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(data);
  }

  // Call on every load of the frame: a new document has no agent.
  async install(): Promise<void> {
    this.ready = false;
    // A fresh document: its own error log arrives with "ready".
    this.errors = [];
    this.emit("errors", { list: this.errors });
    this.emit("reset", {});
    const win = this.getWindow();
    if (!win) return;
    let source: string;
    try {
      source = await loadSource(this.sourceUrl);
    } catch {
      return;
    }
    if (win !== this.getWindow()) return;
    if (this.mode === "eval") {
      try {
        (win as unknown as { eval: (s: string) => unknown }).eval(source);
      } catch {
        // a page that went cross-origin, or forbids eval: no tools there
      }
    } else {
      // A page still busy starting up can miss the first message; ask again
      // a few times until it answers.
      for (let attempt = 0; attempt < 4 && !this.ready && win === this.getWindow(); attempt++) {
        win.postMessage({ __pa: { cmd: "install", source } }, "*");
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
    }
  }

  send(cmd: string, data: Record<string, unknown> = {}): void {
    this.getWindow()?.postMessage({ __pa: { cmd, ...data } }, "*");
  }

  pick(mode: "element" | "text"): void {
    if (!this.ready) this.queuedPick = mode;
    this.send("pick", { mode });
  }

  cancelPick(): void {
    this.queuedPick = null;
    this.send("cancel");
  }

  track(items: TrackItem[]): void {
    this.send("track", { items });
  }

  // A PNG data URL of what's in view, with `item` outlined (scrolled into
  // view first when it isn't), and a note when a simpler render stood in.
  async capture(item: TrackItem | null, timeoutMs = 60000): Promise<{ dataUrl: string; note: string }> {
    if (!this.ready) {
      try {
        await this.whenReady(5000);
      } catch {
        throw new Error("the page tools didn't start in this page");
      }
    }
    const reqId = `c${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        off();
        reject(new Error("the screenshot took too long"));
      }, timeoutMs);
      const off = this.on("captured", (data) => {
        if (data.reqId !== reqId) return;
        window.clearTimeout(timer);
        off();
        const note = typeof data.note === "string" ? data.note : "";
        if (note) console.warn(`Perch screenshot: ${note}`);
        if (typeof data.dataUrl === "string") resolve({ dataUrl: data.dataUrl, note });
        else reject(new Error(typeof data.error === "string" ? data.error : "capture failed"));
      });
      this.send("capture", { reqId, item });
    });
  }

  // Does a comment's steps again in the page (see pageAgent.js's replay):
  // resolves with how many were skipped because their element never showed.
  replay(steps: PageStep[], timeoutMs = 60000): Promise<number> {
    if (steps.length === 0) return Promise.resolve(0);
    const reqId = `r${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        off();
        reject(new Error("the steps took too long"));
      }, timeoutMs);
      const off = this.on("replayed", (data) => {
        if (data.reqId !== reqId) return;
        window.clearTimeout(timer);
        off();
        if (typeof data.missed === "number") resolve(data.missed);
        else reject(new Error(typeof data.error === "string" ? data.error : "the steps failed"));
      });
      this.send("replay", { reqId, steps });
    });
  }

  // Resolves once the agent in the (re)loaded page says it's ready.
  whenReady(timeoutMs = 15000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        off();
        reject(new Error("the page didn't finish loading"));
      }, timeoutMs);
      const off = this.on("ready", () => {
        window.clearTimeout(timer);
        off();
        resolve();
      });
    });
  }
}

// One link per preview, for as long as the preview is mounted. `getWindow`
// should read the frame through a ref, so it always finds the current one.
export function usePageAgent(
  getWindow: () => Window | null,
  mode: "post" | "eval" | null,
  sourceUrl: string,
): PageAgentLink | null {
  const link = useMemo(
    () => (mode ? new PageAgentLink(getWindow, mode, sourceUrl) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, sourceUrl],
  );
  useEffect(() => () => link?.dispose(), [link]);
  return link;
}

// The page's error log, live.
export function usePageErrors(agent: PageAgentLink | null): PageError[] {
  const [errors, setErrors] = useState<PageError[]>(() => agent?.pageErrors() ?? []);
  useEffect(() => {
    if (!agent) {
      setErrors([]);
      return;
    }
    setErrors(agent.pageErrors());
    return agent.on("errors", (data) => setErrors((data.list as PageError[]) ?? []));
  }, [agent]);
  return errors;
}

// Picks from the agent, and the end of a picking session.
export function usePagePicks(
  agent: PageAgentLink | null,
  onPick: (pick: PickedElement) => void,
  onCancel: () => void,
): void {
  useEffect(() => {
    if (!agent) return;
    const offPick = agent.on("picked", (data) => onPick(data.pick as PickedElement));
    const offCancel = agent.on("cancelled", () => onCancel());
    return () => {
      offPick();
      offCancel();
    };
  }, [agent, onPick, onCancel]);
}

export type { ElementRect };

// Saves a page agent capture through an extension's screenshot routes
// (screenshotRoutes.mjs) mounted at `hookBase` ("/api/ext/<id>").
export function makeScreenshotUploader(hookBase: string) {
  return async (dataUrl: string): Promise<{ path: string; url: string }> => {
    const blob = await (await fetch(dataUrl)).blob();
    const res = await fetch(`${hookBase}/screenshot`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: blob,
    });
    const data = (await res.json().catch(() => ({}))) as { path?: string; name?: string; error?: string };
    if (!res.ok || !data.path || !data.name) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
    return { path: data.path, url: `${hookBase}/screenshot/${encodeURIComponent(data.name)}` };
  };
}

// Reads what agents are doing through an extension's agent-state route
// (agentStateRoutes.mjs) mounted at `hookBase` ("/api/ext/<id>").
export function makeAgentStateReader(hookBase: string) {
  return async (windowId?: string): Promise<{ boot?: string; seq: number; last: { seq: number; event: string } | null; hooks: boolean }> => {
    const res = await fetch(`${hookBase}/agent-state${windowId ? `?window=${encodeURIComponent(windowId)}` : ""}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  };
}
