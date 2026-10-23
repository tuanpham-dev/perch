// Server hook for the assistant extension: Perch as a set of MCP tools.
// `perch mcp` (cli/perch/mcp.ts) speaks the protocol to Claude Code and
// forwards tools/list and tools/call here, so the tool names, schemas and
// annotations live in this file only.
//
// Reading tools answer from core's host API. UI tools (previews, palette
// commands, the forward command) can only run in a browser: they go out as an
// "action" event on /events to the page chosen by lib.mjs's chooseTarget, and
// that page answers on /reply. Pages report focus and their active terminal on
// /presence. All of it is in memory; nothing here survives a restart.
//
// Plain ESM, no build step, like every bundled extension's server entry.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { chooseTarget, expandHome, pickWindow, resolveRef, sessionPorts, statusFromEvent } from "./lib.mjs";

const HOME = homedir();
// Hook state is per window; old windows fall off the front, as in
// _shared/agentStateRoutes.mjs.
const MAX_WINDOWS = 200;
const ACTION_TIMEOUT_MS = 10_000;
const STREAM_HEARTBEAT_MS = 25_000;
// A send this recent, with no hook event since, means the agent is about to
// start a turn even though its last event still says it is idle.
const SEND_GRACE_MS = 15_000;
const WAIT_DEFAULT_S = 120;
const WAIT_MAX_S = 600;
const MESSAGES_DEFAULT = 20;
const MESSAGES_MAX = 200;
const SCROLLBACK_MAX = 2000;

const NO_HOOKS_HINT =
  "No hook event from this agent since the Perch server started. If it is busy, its hooks may not be installed: Settings → AI Providers → Install hooks.";

// A failure the caller should read as-is: a bad reference, nothing to act on.
class ToolError extends Error {}

const str = (description) => ({ type: "string", description });
const int = (description, minimum, maximum) => ({ type: "integer", description, minimum, maximum });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TARGET = str(
  'A project or terminal: a window id ($PERCH_WINDOW), "project:index", a project (session) name, or a path inside the project.',
);
const PROJECT = str("A project (session) name, or a path inside the project.");

// Ends every wait and pending browser action when the extension unloads, so
// no tool call hangs on a router that is gone.
let cleanup = null;

export function activate({ router, host, getSettings, log }) {
  // ---- Agent hook state ----

  // window id -> { event, at }
  const lastEvent = new Map();
  // window id -> when send_to_agent last typed into it
  const lastSend = new Map();
  const waiters = new Set();

  host.agentHooks?.subscribe?.({
    events: ["prompt-submit", "permission", "stop"],
    onEvent(e) {
      if (!e.paneId || !e.event) return;
      lastEvent.delete(e.paneId);
      lastEvent.set(e.paneId, { event: e.event, at: e.receivedAt || Date.now() });
      if (lastEvent.size > MAX_WINDOWS) lastEvent.delete(lastEvent.keys().next().value);
      if (e.event === "stop" || e.event === "permission") {
        for (const w of waiters) if (w.windowId === e.paneId) w.done(statusFromEvent(e.event));
      }
    },
  });

  function windowStatus(windowId) {
    const last = lastEvent.get(windowId);
    const sent = lastSend.get(windowId);
    if (sent && Date.now() - sent < SEND_GRACE_MS && (!last || last.at < sent)) {
      return { status: "working", lastEventAt: last ? new Date(last.at).toISOString() : null, note: "A message was just sent; the agent has not reported back yet." };
    }
    if (!last) return { status: "unknown", lastEventAt: null, note: NO_HOOKS_HINT };
    return { status: statusFromEvent(last.event), lastEventAt: new Date(last.at).toISOString() };
  }

  // ---- Browser pages ----

  // page id -> { lastSeen, focusedAt, visible, session, windowIndex }
  const pages = new Map();
  const streams = new Set();
  // action id -> { resolve, reject, timer }
  const pending = new Map();

  router.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    streams.add(res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), STREAM_HEARTBEAT_MS);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(res);
    });
  });

  router.post("/presence", (req, res) => {
    const b = req.body ?? {};
    if (typeof b.page !== "string" || !b.page) return res.status(400).json({ error: "page required" });
    if (b.bye) {
      pages.delete(b.page);
      return res.status(204).end();
    }
    const now = Date.now();
    const prev = pages.get(b.page);
    pages.set(b.page, {
      lastSeen: now,
      focusedAt: b.focused ? now : (prev?.focusedAt ?? 0),
      visible: b.visible !== false,
      session: typeof b.session === "string" ? b.session : null,
      windowIndex: Number.isInteger(b.windowIndex) ? b.windowIndex : null,
    });
    res.status(204).end();
  });

  router.post("/reply", (req, res) => {
    const b = req.body ?? {};
    const entry = pending.get(b.id);
    if (entry) {
      pending.delete(b.id);
      clearTimeout(entry.timer);
      if (b.ok) entry.resolve(b.result ?? null);
      else entry.reject(new ToolError(typeof b.error === "string" ? b.error : "The browser could not do that."));
    }
    res.status(204).end();
  });

  // Runs one action in the browser chosen for this call and waits for its
  // answer. With several candidate pages ("*"), the first answer wins.
  async function uiAction(type, args, call) {
    const caller = call.callerWindow ? await callerTerminal(call.callerWindow) : null;
    const choice = chooseTarget(pages, Date.now(), caller);
    if (choice.error || !streams.size) throw new ToolError(choice.error ?? "No Perch browser window is open. Open the app and try again.");
    const id = randomBytes(8).toString("hex");
    const frame = `event: action\ndata: ${JSON.stringify({ id, target: choice.target, type, args })}\n\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ToolError("The Perch browser window did not answer within 10 seconds."));
      }, ACTION_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      for (const res of streams) res.write(frame);
    });
  }

  async function callerTerminal(windowId) {
    for (const s of await host.sessions.list()) {
      const w = s.windows.find((x) => x.id === windowId);
      if (w) return { session: s.name, index: w.index };
    }
    return null;
  }

  cleanup = () => {
    for (const w of [...waiters]) w.done("timed-out");
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new ToolError("The Assistant extension was turned off."));
      pending.delete(id);
    }
    for (const res of streams) res.end();
    streams.clear();
  };

  // ---- Lookups shared by the tools ----

  async function agentWindowsBySession(sessions) {
    const pairs = await Promise.all(
      sessions.map(async (s) => [s.name, await host.agents.forSession(s.name).catch(() => [])]),
    );
    return new Map(pairs);
  }

  async function resolveTarget(ref) {
    const sessions = await host.sessions.list();
    const r = resolveRef(ref, sessions, HOME);
    if (r.error) throw new ToolError(r.error);
    return r;
  }

  async function resolveProject(ref) {
    return (await resolveTarget(ref)).session;
  }

  // One terminal, preferring the project's agent window.
  async function resolveWindow(ref) {
    const r = await resolveTarget(ref);
    const agents = await host.agents.forSession(r.session.name).catch(() => []);
    const picked = pickWindow(r, new Set(agents.map((a) => a.windowId)));
    if (picked.error) throw new ToolError(picked.error);
    return { ...picked, agent: agents.find((a) => a.windowId === picked.window.id) ?? null };
  }

  const dirOf = (session) => expandHome(session.path, HOME);

  // The conversation an agent window has open, found through the agent's
  // session reader (absent for agents without one).
  async function openConversation(session, windowId, cwd) {
    for (const dir of new Set([cwd, dirOf(session)].filter(Boolean))) {
      const list = await host.agentSessions.list(dir).catch(() => []);
      const hit = list.find((c) => c.openIn?.windowId === windowId);
      if (hit) return { ...hit, cwd: dir };
    }
    return null;
  }

  async function findConversation(session, id) {
    const list = await host.agentSessions.list(dirOf(session)).catch(() => []);
    const hit = list.find((c) => c.id === id);
    if (!hit) throw new ToolError(`No conversation ${id} in ${session.name}. List them with list_conversations.`);
    return { ...hit, cwd: dirOf(session) };
  }

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), min), max);
  }

  // Opens the window in the browser when one is open; a headless call (no
  // browser) still succeeds, it just has nothing to show.
  async function showWindow(sessionName, windowIndex, call) {
    try {
      await uiAction("focusWindow", { session: sessionName, windowIndex }, call);
      return true;
    } catch {
      return false;
    }
  }

  // ---- Tools ----
  // kind: "read" (no side effects), "ui" (changes what a browser shows),
  // "write" (changes terminals, projects or worktrees), "destructive" (a write
  // that ends something).

  const TOOLS = [
    {
      name: "list_projects",
      kind: "read",
      description:
        "List every Perch project (terminal session): its directory, its terminal windows with what runs in each, which windows run an AI agent and that agent's status, and the ports its processes listen on.",
      inputSchema: obj({}),
      async run() {
        const [sessions, ports] = await Promise.all([host.sessions.list(), host.ports.list().catch(() => [])]);
        const agents = await agentWindowsBySession(sessions);
        return sessions.map((s) => ({
          name: s.name,
          path: s.path,
          windows: s.windows.map((w) => {
            const a = (agents.get(s.name) ?? []).find((x) => x.windowId === w.id);
            return {
              index: w.index,
              id: w.id,
              name: w.name,
              command: w.command,
              cwd: w.cwd,
              active: w.active,
              ...(a ? { agent: a.label, agentStatus: windowStatus(w.id).status } : {}),
            };
          }),
          ports: sessionPorts(ports, s.name),
        }));
      },
    },
    {
      name: "agent_status",
      kind: "read",
      description:
        'What the AI agents are doing: "working" (a turn is running), "needs-input" (waiting on a permission prompt), "idle" (its turn ended), or "unknown" (no hook event seen). Includes the last message of the conversation each agent has open. Without a target, covers every agent window in every project.',
      inputSchema: obj({ target: TARGET }),
      async run(args) {
        const resolved = args.target ? await resolveTarget(args.target) : null;
        const sessions = resolved ? [resolved.session] : await host.sessions.list();
        // A window-form target narrows to that one window.
        const only = resolved?.windows.length === 1 ? resolved.windows[0].id : null;
        const agents = await agentWindowsBySession(sessions);
        const out = [];
        for (const s of sessions) {
          for (const a of agents.get(s.name) ?? []) {
            if (only && only !== a.windowId) continue;
            const convo = await openConversation(s, a.windowId, a.cwd);
            let lastMessage = null;
            if (convo) {
              const [m] = await host.agentSessions.messages(convo.agentId, convo.id, convo.cwd, 1).catch(() => []);
              if (m) lastMessage = { role: m.role, text: m.text.length > 600 ? `${m.text.slice(0, 600)}…` : m.text };
            }
            out.push({
              project: s.name,
              window: `${s.name}:${a.windowIndex}`,
              windowId: a.windowId,
              agent: a.label,
              ...windowStatus(a.windowId),
              conversation: convo ? { id: convo.id, title: convo.title } : null,
              lastMessage,
            });
          }
        }
        if (!out.length) return args.target ? `No AI agent is running in ${args.target}.` : "No AI agent is running in any project.";
        return out;
      },
    },
    {
      name: "agent_conversation",
      kind: "read",
      description:
        "The last messages of an agent conversation: the one open in the target's agent window, or, with conversationId, a past one from list_conversations.",
      inputSchema: obj({
        target: TARGET,
        conversationId: str("A conversation id from list_conversations. Omit for the conversation open in the agent window."),
        limit: int(`How many messages, newest last (default ${MESSAGES_DEFAULT}).`, 1, MESSAGES_MAX),
      }, ["target"]),
      async run(args) {
        const limit = clampInt(args.limit, MESSAGES_DEFAULT, 1, MESSAGES_MAX);
        let convo;
        if (args.conversationId) {
          convo = await findConversation(await resolveProject(args.target), args.conversationId);
        } else {
          const { session, window, agent } = await resolveWindow(args.target);
          if (!agent) throw new ToolError(`No AI agent is running in ${session.name}:${window.index}.`);
          convo = await openConversation(session, window.id, agent.cwd);
          if (!convo) throw new ToolError(`Perch can't tell which conversation ${agent.label} has open in ${session.name}:${window.index}. Try list_conversations, or read_terminal.`);
        }
        const messages = await host.agentSessions.messages(convo.agentId, convo.id, convo.cwd, limit);
        return { conversation: { id: convo.id, title: convo.title, agent: convo.agentLabel }, messages };
      },
    },
    {
      name: "read_terminal",
      kind: "read",
      description: "The text on a terminal's screen, optionally with scrollback above it. For a project with several windows it reads the agent's window.",
      inputSchema: obj({
        target: TARGET,
        scrollback: int(`Lines of history above the screen to include (default 0, max ${SCROLLBACK_MAX}).`, 0, SCROLLBACK_MAX),
      }, ["target"]),
      async run(args) {
        const { session, window } = await resolveWindow(args.target);
        const text = await host.sessions.capture(window.id, { scrollback: clampInt(args.scrollback, 0, 0, SCROLLBACK_MAX) });
        return `${session.name}:${window.index} (${window.name})\n\n${text}`;
      },
    },
    {
      name: "list_ports",
      kind: "read",
      description: "Ports that processes started from Perch terminals listen on, with the project, process and pid.",
      inputSchema: obj({}),
      run: () => host.ports.list(),
    },
    {
      name: "list_conversations",
      kind: "read",
      description: "Past AI agent conversations that ran in a project, newest first, with whether each can be resumed and which window has it open.",
      inputSchema: obj({ project: PROJECT, limit: int("How many (default 20).", 1, 200) }, ["project"]),
      async run(args) {
        const session = await resolveProject(args.project);
        const list = await host.agentSessions.list(dirOf(session));
        return list.slice(0, clampInt(args.limit, 20, 1, 200)).map((c) => ({
          id: c.id,
          title: c.title,
          agent: c.agentLabel,
          lastActiveAt: c.lastActiveAt ? new Date(c.lastActiveAt).toISOString() : null,
          messageCount: c.messageCount,
          canResume: c.canResume,
          openIn: c.openIn ? `${c.openIn.sessionName}:${c.openIn.windowIndex}` : null,
        }));
      },
    },
    {
      name: "list_worktrees",
      kind: "read",
      description: "Git worktrees of a project's repository, with whether each has uncommitted changes.",
      inputSchema: obj({ project: PROJECT }, ["project"]),
      async run(args) {
        return host.worktrees.list(dirOf(await resolveProject(args.project)), { dirty: true });
      },
    },
    {
      name: "wait_for_agent",
      kind: "read",
      description:
        'Wait until an agent finishes its turn or stops for a permission prompt, then return its status. Returns at once when it is already idle or waiting, unless a message was just sent to it with send_to_agent. Returns "timed-out" after timeoutSeconds.',
      inputSchema: obj({
        target: TARGET,
        timeoutSeconds: int(`How long to wait (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}).`, 1, WAIT_MAX_S),
      }, ["target"]),
      async run(args) {
        const { session, window } = await resolveWindow(args.target);
        const label = `${session.name}:${window.index}`;
        const now = windowStatus(window.id);
        if (now.status === "idle" || now.status === "needs-input") return { window: label, ...now, waitedSeconds: 0 };
        const seconds = clampInt(args.timeoutSeconds, WAIT_DEFAULT_S, 1, WAIT_MAX_S);
        const started = Date.now();
        const status = await new Promise((resolve) => {
          const waiter = {
            windowId: window.id,
            done(s) {
              clearTimeout(timer);
              waiters.delete(waiter);
              resolve(s);
            },
          };
          const timer = setTimeout(() => waiter.done("timed-out"), seconds * 1000);
          waiters.add(waiter);
        });
        const waitedSeconds = Math.round((Date.now() - started) / 1000);
        if (status === "timed-out") return { window: label, status, lastStatus: windowStatus(window.id).status, waitedSeconds };
        return { window: label, status, waitedSeconds };
      },
    },
    {
      name: "open_web_preview",
      kind: "ui",
      description:
        "Open an address in Perch's web preview tab, in the Perch browser window the user is looking at. Give a url, a port on the Perch machine, or a project to preview the one port that project's processes listen on (the app's dev server).",
      inputSchema: obj({
        url: str("An http(s) address, e.g. http://localhost:5173/settings or example.com."),
        port: int("A port on the Perch machine; opens http://localhost:<port>/.", 1, 65535),
        project: str("A project whose dev server to preview."),
      }),
      async run(args, call) {
        let url = args.url;
        if (!url && args.port) url = `http://localhost:${args.port}/`;
        if (!url && args.project) {
          const session = await resolveProject(args.project);
          const ports = sessionPorts(await host.ports.list(), session.name);
          if (!ports.length) throw new ToolError(`Nothing in ${session.name} is listening on a port. Start its dev server first.`);
          if (ports.length > 1) throw new ToolError(`${session.name} listens on several ports: ${ports.join(", ")}. Say which one.`);
          url = `http://localhost:${ports[0]}/`;
        }
        if (!url) throw new ToolError("Give a url, a port, or a project.");
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = /^(localhost|127\.|\[::1\])/i.test(url) ? `http://${url}` : `https://${url}`;
        await uiAction("openUrl", { url }, call);
        return `Opened ${url} in the Perch web preview.`;
      },
    },
    {
      name: "open_file_preview",
      kind: "ui",
      description:
        "Open a file in Perch: its rendered preview when one exists (Markdown, JSON, CSV, images, PDF, HTML), otherwise the file itself. A relative path is taken from the project's directory.",
      inputSchema: obj({ path: str("The file. Absolute, ~-relative, or relative to the project."), project: PROJECT }, ["path"]),
      async run(args, call) {
        let file = expandHome(String(args.path ?? ""), HOME);
        if (!file) throw new ToolError("Give a path.");
        if (!path.isAbsolute(file)) {
          if (!args.project) throw new ToolError("A relative path needs a project.");
          file = path.join(dirOf(await resolveProject(args.project)), file);
        }
        const how = await uiAction("openFile", { path: file }, call);
        return how === "preview" ? `Opened the preview of ${file}.` : `Opened ${file}.`;
      },
    },
    {
      name: "port_forward_command",
      kind: "ui",
      description:
        "The command that forwards every Perch port to localhost on another machine (the Ports panel's Copy command). It is built by the user's Perch browser window, which also shows it with a Copy button. It may carry the browser's auth header, so treat it like a credential.",
      inputSchema: obj({}),
      async run(_args, call) {
        return uiAction("forwardCommand", {}, call);
      },
    },
    {
      name: "list_commands",
      kind: "read",
      description: "Perch's command palette commands that run_command can run: built-ins (tab.close, sidebar.toggle, panel.toggle, split.right, window.new, settings.open) and every extension command.",
      inputSchema: obj({}),
      async run(_args, call) {
        return uiAction("listCommands", {}, call);
      },
    },
    {
      name: "run_command",
      kind: "ui",
      description:
        "Run a command palette command by id in the Perch browser window the user is looking at, on its active tab. Examples: tab.close, tab.closeOthers, sidebar.toggle, panel.toggle, split.right, window.new, terminal.fontSizeIncrease. Use list_commands for every id.",
      inputSchema: obj({ id: str("The command id.") }, ["id"]),
      async run(args, call) {
        await uiAction("runCommand", { id: String(args.id ?? "") }, call);
        return `Ran ${args.id}.`;
      },
    },
    {
      name: "focus_window",
      kind: "ui",
      description: "Show a project's terminal window as the active tab in the Perch browser window, so a following run_command (such as tab.close or split.right) acts on it.",
      inputSchema: obj({ target: TARGET }, ["target"]),
      async run(args, call) {
        const { session, window } = await resolveWindow(args.target);
        await uiAction("focusWindow", { session: session.name, windowIndex: window.index }, call);
        return `Showing ${session.name}:${window.index} (${window.name}).`;
      },
    },
    {
      name: "send_to_agent",
      kind: "write",
      description:
        "Type text into a terminal, normally an AI agent's prompt, and press Enter unless submit is false. For a project with several windows it types into the agent's window. Follow with wait_for_agent to know when the agent is done.",
      inputSchema: obj({
        target: TARGET,
        text: str("What to type."),
        submit: { type: "boolean", description: "Press Enter after typing (default true)." },
      }, ["target", "text"]),
      async run(args) {
        const { session, window } = await resolveWindow(args.target);
        const submit = args.submit !== false;
        await host.sessions.sendTextToWindow(window.id, String(args.text ?? ""), submit);
        if (submit) lastSend.set(window.id, Date.now());
        return `Typed into ${session.name}:${window.index} (${window.name})${submit ? " and pressed Enter" : ""}.`;
      },
    },
    {
      name: "create_session",
      kind: "write",
      description: "Open a project: start a terminal session in a directory (at the git root containing it unless exact is true).",
      inputSchema: obj({
        path: str("The directory."),
        name: str("The project's name. Defaults to the folder name."),
        exact: { type: "boolean", description: "Start in exactly this directory rather than its git root." },
      }, ["path"]),
      async run(args, call) {
        const s = await host.sessions.create(args.name || undefined, String(args.path ?? ""), args.exact === true);
        const shown = await showWindow(s.name, s.windows[0]?.index ?? 0, call);
        return { name: s.name, path: s.path, windows: s.windows.map((w) => ({ index: w.index, id: w.id, name: w.name })), shown };
      },
    },
    {
      name: "create_window",
      kind: "write",
      description:
        "Open a new terminal window in a project, optionally running a command in it (the command is kept and runs again when the window is restored), and show it in the Perch browser window.",
      inputSchema: obj({
        project: PROJECT,
        command: str("A one-line command to run in the new terminal, e.g. npm test."),
        name: str("The window's name. Defaults to what runs in it."),
        cwd: str("The directory to start in. Defaults to the project's."),
      }, ["project"]),
      async run(args, call) {
        const session = await resolveProject(args.project);
        const index = await host.sessions.createWindow(session.name, args.cwd || undefined, args.name || undefined, args.command || undefined);
        const shown = await showWindow(session.name, index, call);
        return { project: session.name, window: `${session.name}:${index}`, shown };
      },
    },
    {
      name: "kill_session",
      kind: "destructive",
      description: "Close a project: end its terminal session and every process running in its windows.",
      inputSchema: obj({ project: str("The exact project (session) name.") }, ["project"]),
      async run(args) {
        const session = await resolveProject(args.project);
        await host.sessions.kill(session.name);
        return `Closed ${session.name}.`;
      },
    },
    {
      name: "create_worktree",
      kind: "write",
      description: "Create a git worktree for a project: a new branch off base (default HEAD), or an existing branch checked out. It does not open a project for it; use create_session with the returned path.",
      inputSchema: obj({
        project: PROJECT,
        branch: str("The branch name."),
        base: str("What a new branch starts from (default HEAD)."),
        existing: { type: "boolean", description: "Check out an existing branch instead of creating one." },
      }, ["project", "branch"]),
      async run(args) {
        const session = await resolveProject(args.project);
        return host.worktrees.create({
          cwd: dirOf(session),
          branch: String(args.branch ?? ""),
          base: args.base || undefined,
          mode: args.existing ? "existing" : "new",
        });
      },
    },
    {
      name: "remove_worktree",
      kind: "destructive",
      description: "Remove a git worktree's checkout (its branch is kept). Close any project open in it first.",
      inputSchema: obj({
        project: PROJECT,
        path: str("The worktree's path, from list_worktrees."),
        force: { type: "boolean", description: "Remove even with uncommitted changes." },
      }, ["project", "path"]),
      async run(args) {
        const session = await resolveProject(args.project);
        await host.worktrees.remove({ cwd: dirOf(session), path: expandHome(String(args.path ?? ""), HOME), force: args.force === true });
        return `Removed the worktree at ${args.path}.`;
      },
    },
    {
      name: "resume_conversation",
      kind: "write",
      description: "Reopen a past agent conversation (from list_conversations) in a new terminal window of its project, and show it.",
      inputSchema: obj({ project: PROJECT, conversationId: str("The conversation id.") }, ["project", "conversationId"]),
      async run(args, call) {
        const session = await resolveProject(args.project);
        const convo = await findConversation(session, String(args.conversationId ?? ""));
        if (convo.openIn) return `That conversation is already open in ${convo.openIn.sessionName}:${convo.openIn.windowIndex}.`;
        const command = await host.agentSessions.resumeCommand(convo.agentId, convo.id);
        if (!command) throw new ToolError(`${convo.agentLabel} can't resume this conversation.`);
        const index = await host.sessions.createWindow(session.name, undefined, undefined, command);
        const shown = await showWindow(session.name, index, call);
        return { project: session.name, window: `${session.name}:${index}`, command, shown };
      },
    },
  ];

  const ANNOTATIONS = {
    read: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ui: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  };
  const isWrite = (tool) => tool.kind === "write" || tool.kind === "destructive";

  async function readOnly() {
    try {
      return (await getSettings())["assistant.readOnly"] === true;
    } catch {
      return false;
    }
  }

  router.get("/tools", async (_req, res) => {
    const ro = await readOnly();
    res.json({
      tools: TOOLS.filter((t) => !(ro && isWrite(t))).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: ANNOTATIONS[t.kind],
      })),
    });
  });

  router.post("/call", async (req, res) => {
    const { name, arguments: args = {}, callerWindow = null } = req.body ?? {};
    const tool = TOOLS.find((t) => t.name === name);
    const reply = (text, isError = false) => res.json({ content: [{ type: "text", text }], isError });
    if (!tool) return reply(`Unknown tool: ${name}`, true);
    if (isWrite(tool) && (await readOnly())) {
      return reply(`${name} is turned off: the Assistant extension is set to read-only (Settings → Extensions → Assistant).`, true);
    }
    try {
      const result = await tool.run(args && typeof args === "object" ? args : {}, { callerWindow: typeof callerWindow === "string" ? callerWindow : null });
      reply(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    } catch (err) {
      if (!(err instanceof ToolError)) log(`${name} failed:`, err);
      reply(err instanceof Error ? err.message : String(err), true);
    }
  });
}

export function deactivate() {
  cleanup?.();
  cleanup = null;
}
