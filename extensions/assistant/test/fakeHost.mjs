// An in-memory stand-in for the host the assistant extension's server hook
// gets: a router that records handlers so a test can invoke them, and just
// enough of host.* to drive the tools. Plain ESM, test-only.
import { DatabaseSync } from "node:sqlite";

// A fake express-style response: records status, headers and body.
function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    written: [],
    ended: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    writeHead(code, headers = {}) {
      res.statusCode = code;
      Object.assign(res.headers, headers);
      return res;
    },
    json(body) {
      res.body = body;
      res.ended = true;
      return res;
    },
    write(chunk) {
      res.written.push(String(chunk));
      return true;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  return res;
}

// options.db: a DatabaseSync kept from an earlier fakeHost, to model a restart.
export function fakeHost({ sessions = [], agents = {}, conversations = {}, messages = {}, ports = [], worktrees = [], settings = {}, db } = {}) {
  const handlers = new Map(); // "GET /tools" -> fn
  const route = (method) => (path, fn) => void handlers.set(`${method} ${path}`, fn);
  const router = { get: route("GET"), post: route("POST"), put: route("PUT"), delete: route("DELETE") };

  const calls = { capture: [], sendTextToWindow: [], hooks: [] };
  const subscribers = [];
  const host = {
    calls,
    sessions: {
      list: async () => sessions,
      capture: async (windowId, opts) => {
        calls.capture.push({ windowId, opts });
        return `screen of ${windowId}`;
      },
      sendTextToWindow: async (windowId, text, submit) => {
        calls.sendTextToWindow.push({ windowId, text, submit });
      },
    },
    agents: { forSession: async (name) => agents[name] ?? [] },
    agentSessions: {
      list: async (dir) => conversations[dir] ?? [],
      messages: async (agentId, id, cwd, limit) => (messages[id] ?? []).slice(-limit),
    },
    agentHooks: {
      subscribe(sub) {
        subscribers.push(sub);
        calls.hooks.push(sub);
        return () => subscribers.splice(subscribers.indexOf(sub), 1);
      },
    },
    ports: { list: async () => ports },
    worktrees: { list: async () => worktrees },
  };

  const secretMap = new Map();
  const secrets = {
    get: async (k) => secretMap.get(k) ?? null,
    set: async (k, v) => {
      // Contract (server/src/extensions.ts): a null or blank value clears the name.
      if (v === null || v === undefined || String(v).trim() === '') secretMap.delete(k)
      else secretMap.set(k, v)
    },
    list: async () => [...secretMap.keys()],
    map: secretMap,
  };

  const database = db ?? new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec: (sql) => database.exec(sql),
      prepare: (sql) => database.prepare(sql),
    },
    db: database,
  };

  const logs = [];
  const log = (...args) => void logs.push(args);

  // Delivers a hook event to every subscriber that asked for it.
  const emit = (e) => {
    for (const s of subscribers) if (!s.events || s.events.includes(e.event)) s.onEvent(e);
  };

  // Invokes a recorded handler with a fake request; resolves with the response.
  async function request(method, path, body) {
    const fn = handlers.get(`${method.toUpperCase()} ${path}`);
    if (!fn) throw new Error(`No handler for ${method} ${path}`);
    const res = fakeRes();
    const listeners = {};
    const req = { method, path, body, on: (ev, cb) => void (listeners[ev] = cb), listeners };
    await fn(req, res);
    return res;
  }

  return {
    router,
    host,
    getSettings: async () => settings,
    settings,
    secrets,
    storage,
    log,
    logs,
    emit,
    request,
  };
}
