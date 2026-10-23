// The assistant's decisions that don't need a running server: which terminal
// a reference names, which browser window a UI action goes to, and what an
// agent's last hook event means. Plain ESM, kept apart from server.js so the
// tests can import it without the host.
import path from "node:path";

// Paths from core arrive "~"-shortened (TerminalSession.path); a reference
// typed by the user or an agent can be either form.
export function expandHome(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function describeWindow(session, w) {
  return `${session.name}:${w.index} (${w.name}, id ${w.id})`;
}

// What a project or window reference names (spec R19), in order of
// precision: a window id ($PERCH_WINDOW), "session:index", a session name
// (exact, then ignoring case, then a session's folder name), or a path inside
// a session's directory (the deepest session directory containing it wins).
// Returns { session, windows } - one window for the window forms, every
// window of the session otherwise - or { error } naming what matched.
export function resolveRef(ref, sessions, home) {
  const raw = String(ref ?? "").trim();
  if (!raw) return { error: "No project or window given." };

  for (const s of sessions) {
    const w = s.windows.find((x) => x.id === raw);
    if (w) return { session: s, windows: [w] };
  }

  const pair = /^(.+):(\d+)$/.exec(raw);
  if (pair) {
    const s = sessions.find((x) => x.name === pair[1]);
    if (s) {
      const w = s.windows.find((x) => x.index === Number(pair[2]));
      if (w) return { session: s, windows: [w] };
      return { error: `Project "${s.name}" has no window ${pair[2]}; it has ${s.windows.map((x) => x.index).join(", ")}.` };
    }
  }

  const exact = sessions.filter((s) => s.name === raw);
  if (exact.length === 1) return { session: exact[0], windows: exact[0].windows };

  const lower = raw.toLowerCase();
  const byName = sessions.filter((s) => s.name.toLowerCase() === lower);
  if (byName.length === 1) return { session: byName[0], windows: byName[0].windows };
  if (byName.length > 1) return ambiguous(raw, byName);

  const byFolder = sessions.filter((s) => path.basename(expandHome(s.path, home)).toLowerCase() === lower);
  if (byFolder.length === 1) return { session: byFolder[0], windows: byFolder[0].windows };
  if (byFolder.length > 1) return ambiguous(raw, byFolder);

  if (raw.startsWith("/") || raw.startsWith("~")) {
    const target = path.resolve(expandHome(raw, home));
    let best = [];
    let bestLen = -1;
    for (const s of sessions) {
      const dir = path.resolve(expandHome(s.path, home));
      if (target !== dir && !target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) continue;
      if (dir.length > bestLen) {
        best = [s];
        bestLen = dir.length;
      } else if (dir.length === bestLen) best.push(s);
    }
    if (best.length === 1) return { session: best[0], windows: best[0].windows };
    if (best.length > 1) return ambiguous(raw, best);
  }

  const names = sessions.map((s) => s.name).join(", ") || "none";
  return { error: `No project or window matches "${raw}". Open projects: ${names}.` };
}

function ambiguous(raw, sessions) {
  const list = sessions.map((s) => `${s.name} (${s.path})`).join("; ");
  return { error: `"${raw}" matches more than one project: ${list}. Use the exact project name or a window id.` };
}

// One window out of a resolved reference, for tools that act on a single
// terminal: the one window a window-form reference named; else the
// session's only agent window; else its only window. `agentWindowIds` is the
// set of window ids with an agent running in them.
export function pickWindow(resolved, agentWindowIds) {
  if (resolved.error) return resolved;
  const { session, windows } = resolved;
  if (windows.length === 1) return { session, window: windows[0] };
  const agents = windows.filter((w) => agentWindowIds.has(w.id));
  if (agents.length === 1) return { session, window: agents[0] };
  const pool = agents.length ? agents : windows;
  const list = pool.map((w) => describeWindow(session, w)).join("; ");
  const what = agents.length ? "agent windows" : "windows";
  return { error: `Project "${session.name}" has several ${what}: ${list}. Name one as "${session.name}:<index>" or by id.` };
}

// How long a page counts as open without reporting in. Pages report every
// 30s while visible, so this survives one missed beat.
export const PAGE_TTL_MS = 90_000;

// Which browser window a UI action goes to (spec R16). `pages` maps a page
// id to its last report: { lastSeen, focusedAt, visible, session,
// windowIndex }. `caller` is the master's own terminal as { session, index },
// or null. A visible page showing the caller's terminal wins; then the page
// focused last; with no focus report at all, every open page ("*").
export function chooseTarget(pages, now, caller) {
  const live = [...pages].filter(([, p]) => now - p.lastSeen <= PAGE_TTL_MS);
  if (!live.length) return { error: "No Perch browser window is open. Open the app and try again." };
  const latest = (list) => list.reduce((a, b) => (b[1].focusedAt > a[1].focusedAt ? b : a))[0];
  if (caller) {
    const showing = live.filter(([, p]) => p.visible && p.session === caller.session && p.windowIndex === caller.index);
    if (showing.length) return { target: latest(showing) };
  }
  const focused = live.filter(([, p]) => p.focusedAt > 0);
  if (focused.length) return { target: latest(focused) };
  return { target: "*" };
}

// An agent window's state from the last hook event it sent (spec R4).
export function statusFromEvent(event) {
  switch (event) {
    case "prompt-submit":
      return "working";
    case "permission":
      return "needs-input";
    case "stop":
      return "idle";
    default:
      return "unknown";
  }
}

// The ports a project's own terminals listen on - "the app" when there is
// exactly one. Orphans are left out: their terminal is gone.
export function sessionPorts(ports, sessionName) {
  const seen = new Set();
  for (const p of ports) if (p.session === sessionName && !p.orphan) seen.add(p.port);
  return [...seen].sort((a, b) => a - b);
}
