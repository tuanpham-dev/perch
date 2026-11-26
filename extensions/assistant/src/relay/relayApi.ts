// The browser's side of the relay link: typed wrappers over the extension's
// /relay/* routes, and hooks that keep a component current as the server says
// the link changed (an SSE `relay` event, wired up in client.tsx).
import { useEffect, useState } from "react";

export interface RelayHost {
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  confirmDialog?(message: string, confirmLabel?: string): Promise<boolean>;
  openSettings?(): void;
  // True when the server's event stream tells this page about changes; without
  // it an action refreshes the state itself.
  hasEvents?: boolean;
}

export type Inbound = "off" | "read" | "send";

export interface RelayMachine {
  id: string;
  name: string;
  self: boolean;
  online: boolean;
  lastSeen: number | null;
  trust: "verified" | "unverified";
  blocked: boolean;
  accepts: Inbound | "unknown";
}

export interface RelayInvite {
  id: string;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  usesLeft: number;
  held: boolean;
}

export interface RelayState {
  joined: boolean;
  defaultName: string;
  relayHost: string | null;
  connection: "connected" | "reconnecting" | "refused" | null;
  reason: string;
  machine: { id: string; name: string; label: string } | null;
  inbound: Inbound | null;
  readOnlyLimiting: boolean;
  machines: RelayMachine[];
  invites: RelayInvite[];
  // Set while not joined after this machine was removed (verified) and until the next create or join.
  removedBy?: { by: string; at: number };
}

export interface RelayActivityRow {
  id: number;
  at: number;
  machine: string;
  tool: string | null;
  target: string | null;
  outcome: string | null;
  event: string | null;
  count?: number;
}

// The host the section talks through; set in activate(), cleared in deactivate().
let host: RelayHost | null = null;
export function setRelayHost(next: RelayHost | null): void {
  host = next;
  if (!next) view = { kind: "loading", error: null };
}
export function getRelayHost(): RelayHost | null {
  return host;
}

// ---- Changes and the shared state ----

// Server events (and nothing else) say the link changed. Everyone interested
// listens here: the state store below, and the activity list while it is on screen.
const changeListeners = new Set<() => void>();
export function fireRelayChanged(): void {
  for (const listener of changeListeners) listener();
}
function onRelayChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

// A burst of events costs one request after it settles, and never two at once.
const DEBOUNCE_MS = 200;
function coalesced(load: () => Promise<void>): { request(): void; now(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const run = () => {
    timer = null;
    if (running) {
      again = true;
      return;
    }
    running = true;
    load().finally(() => {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    });
  };
  const schedule = () => {
    if (timer === null) timer = setTimeout(run, DEBOUNCE_MS);
  };
  return {
    request: schedule,
    now() {
      if (timer !== null) clearTimeout(timer);
      run();
    },
  };
}

export type RelayView =
  | { kind: "loading"; error: string | null }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; state: RelayState; error: string | null };

let view: RelayView = { kind: "loading", error: null };
const viewListeners = new Set<() => void>();
function setView(next: RelayView): void {
  view = next;
  for (const listener of viewListeners) listener();
}

const stateLoader = coalesced(async () => {
  try {
    const body = await call<RelayState | { available: false; reason: string }>("/relay/state");
    if ("available" in body && body.available === false) setView({ kind: "unavailable", reason: body.reason });
    else setView({ kind: "ready", state: body as RelayState, error: null });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    setView(view.kind === "ready" ? { kind: "ready", state: view.state, error } : { kind: "loading", error });
  }
});

// Fetch now (still one at a time), for an action whose answer carries no state.
export function requestStateNow(): void {
  stateLoader.now();
}

// A state an action's own answer carried.
export function applyState(state: RelayState): void {
  setView({ kind: "ready", state, error: null });
}

// After an action whose result arrives as a server event, nothing more is
// needed; a host without events needs the refresh.
export function afterAction(): void {
  if (!host?.hasEvents) fireRelayChanged();
}

// Subscribed once by the first component that shows relay state.
function subscribeState(listener: () => void): () => void {
  if (viewListeners.size === 0) {
    stateUnsub = onRelayChanged(stateLoader.request);
    stateLoader.now();
  }
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
    if (viewListeners.size === 0 && stateUnsub) {
      stateUnsub();
      stateUnsub = null;
    }
  };
}
let stateUnsub: (() => void) | null = null;

// ---- Calls ----

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  if (!host) throw new Error("The Assistant extension is not active.");
  const res = await host.serverFetch(path, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // An empty or non-JSON answer; the status below says enough.
  }
  if (!res.ok) {
    const message = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `Request failed (${res.status}).`;
    throw new Error(message);
  }
  return data as T;
}

export const relayApi = {
  state: () => call<RelayState>("/relay/state"),
  activity: () => call<RelayActivityRow[]>("/relay/activity"),
  create: (b: { relayUrl: string; adminSecret: string; name: string; allowInsecure: boolean }) => call<RelayState>("/relay/create", { body: b }),
  join: (b: { invite: string; name: string; allowInsecure?: boolean }) => call<RelayState>("/relay/join", { body: b }),
  createInvite: (b: { uses: number; expiresMinutes: number }) => call<{ id: string; invite: string; expiresAt: number }>("/relay/invites", { body: b }),
  revokeInvite: (id: string) => call<{ ok: true }>(`/relay/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  remove: (machine: string) => call<{ ok: true }>("/relay/remove", { body: { machine } }),
  rename: (name: string) => call<RelayState>("/relay/rename", { body: { name } }),
  setLabel: (label: string) => call<RelayState>("/relay/label", { body: { label } }),
  setPermission: (inbound: Inbound) => call<RelayState>("/relay/permission", { body: { inbound } }),
  leave: () => call<unknown>("/relay/leave", { body: {} }),
};

// ---- Hooks ----

export function useRelayView(): RelayView {
  const [current, setCurrent] = useState(view);
  useEffect(() => {
    const listener = () => setCurrent(view);
    const off = subscribeState(listener);
    listener();
    return off;
  }, []);
  return current;
}

// Loaded only while a component showing it is mounted.
export function useRelayActivity(): RelayActivityRow[] {
  const [rows, setRows] = useState<RelayActivityRow[]>([]);
  useEffect(() => {
    let live = true;
    const loader = coalesced(async () => {
      try {
        const next = await relayApi.activity();
        if (live) setRows(next);
      } catch {
        // The list keeps what it had; the state line reports a broken link.
      }
    });
    const off = onRelayChanged(loader.request);
    loader.now();
    return () => {
      live = false;
      off();
    };
  }, []);
  return rows;
}
